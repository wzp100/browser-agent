import { build, initialize, type Loader, type OnResolveArgs, type Plugin } from "esbuild-wasm";
import { bytesText, type VirtualFileSystem } from "../types";
import { joinVirtualPath, normalizeInternalPath, virtualDirname } from "../paths";
import type { LockedPackage, VirtualPackageLock } from "../packages/package-manager";

const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json"];
const NODE_SHIMS = new Set(["process", "path", "path/posix", "buffer", "util", "assert", "assert/strict", "events", "url", "querystring", "string_decoder", "fs", "fs/promises"]);
/* These names are recognized solely to reject them before package resolution.  This is
 * deliberately not a catch-all: an unknown bare name may be an npm package, while every
 * node: name fails closed. */
const UNSUPPORTED_NODE_BUILTINS = new Set(["async_hooks", "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "fs", "fs/promises", "http", "http2", "https", "inspector", "module", "net", "os", "perf_hooks", "punycode", "readline", "repl", "sea", "sqlite", "stream", "sys", "test", "timers", "tls", "trace_events", "tty", "v8", "vm", "wasi", "worker_threads", "zlib"]);
let browserInitialization: Promise<void> | undefined;

/** The intentionally small, browser-safe Node core compatibility contract. */
export const BROWSER_NODE_CORE_MODULES = Object.freeze([...NODE_SHIMS].sort());

export interface BundleResult { code: string; warnings: string[]; usesSandboxFilesystem: boolean; }

export class VirtualModuleBundler {
  constructor(private readonly fs: VirtualFileSystem, private readonly readLock: () => Promise<VirtualPackageLock | undefined>) {}

  async bundleEntry(entryPath: string): Promise<BundleResult> {
    await ensureEsbuild();
    const normalized = normalizeInternalPath(entryPath);
    rejectReservedProjectPath(normalized);
    const entry = await resolveFile(this.fs, normalized);
    return this.build({ entryPoints: [entry] });
  }

  /** Trusted package command entry. Project entry points can never use this route. */
  async bundlePackageEntry(entryPath: string, packageId: string): Promise<BundleResult> {
    await ensureEsbuild();
    const lock = await this.readLock();
    const locked = lock?.packages[packageId];
    const normalized = normalizeInternalPath(entryPath);
    if (!locked || !insidePackage(normalized, locked.storePath)) throw new Error("ERR_BROWSER_RUNTIME_PACKAGE_BOUNDARY: untrusted package entry");
    const entry = await resolveFile(this.fs, normalized);
    return this.build({ entryPoints: [entry] }, { packageId });
  }

  async bundleSource(source: string, resolveDirectory = "/", loader: Loader = "js"): Promise<BundleResult> {
    await ensureEsbuild();
    return this.build({ stdin: { contents: source, resolveDir: normalizeInternalPath(resolveDirectory), sourcefile: "runtime-input.ts", loader } });
  }

  private async build(input: { entryPoints: string[] } | { stdin: { contents: string; resolveDir: string; sourcefile: string; loader: Loader } }, trustedEntry?: { packageId: string }): Promise<BundleResult> {
    const lock = await this.readLock();
    const result = await build({ ...input, bundle: true, write: false, format: "iife", platform: "browser", target: "es2020", logLevel: "silent", sourcemap: "inline", plugins: [virtualModulesPlugin(this.fs, lock, trustedEntry)] });
    const output = result.outputFiles?.[0];
    if (!output) throw new Error("esbuild 没有生成 JavaScript 输出");
    return { code: output.text, warnings: result.warnings.map((warning) => warning.text), usesSandboxFilesystem: output.text.includes("globalThis.__browserAgentFs") };
  }
}

function virtualModulesPlugin(fs: VirtualFileSystem, lock: VirtualPackageLock | undefined, trustedEntry?: { packageId: string }): Plugin {
  return { name: "browser-agent-virtual-modules", setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, async (args) => resolveModule(fs, lock, args, trustedEntry));
    buildApi.onLoad({ filter: /.*/, namespace: "project" }, async ({ path }) => ({ contents: bytesText(await fs.readFile(path)), loader: loaderFor(path), resolveDir: virtualDirname(path) }));
    buildApi.onLoad({ filter: /.*/, namespace: "package" }, async ({ path, pluginData }) => ({ contents: bytesText(await fs.readFile(path)), loader: loaderFor(path), resolveDir: virtualDirname(path), pluginData }));
    buildApi.onLoad({ filter: /.*/, namespace: "node-shim" }, ({ path }) => ({ contents: nodeShim(path), loader: "js" }));
  }};
}

async function resolveModule(fs: VirtualFileSystem, lock: VirtualPackageLock | undefined, args: OnResolveArgs, trustedEntry?: { packageId: string }): Promise<object> {
  if (args.namespace === "node-shim") return { path: args.path, namespace: "node-shim" };
  const builtin = builtinName(args.path);
  if (builtin) {
    if (NODE_SHIMS.has(builtin)) return { path: builtin, namespace: "node-shim" };
    throw unsupportedBuiltin(args.path);
  }
  if (args.kind === "entry-point") {
    const entry = normalizeInternalPath(args.path);
    if (trustedEntry) {
      const locked = lock?.packages[trustedEntry.packageId];
      if (!locked || !insidePackage(entry, locked.storePath)) throw new Error("ERR_BROWSER_RUNTIME_PACKAGE_BOUNDARY: package entry escaped its store");
      return { path: await resolveFile(fs, entry), namespace: "package", pluginData: trustedEntry };
    }
    rejectReservedProjectPath(entry);
    return { path: await resolveFile(fs, entry), namespace: "project" };
  }
  if (args.path.startsWith(".") || args.path.startsWith("/")) {
    const parentId = packageIdFromPluginData(args.pluginData);
    if (parentId) {
      // Installed modules may only use package-relative paths inside their own verified store.
      if (args.path.startsWith("/")) throw new Error(`ERR_BROWSER_RUNTIME_PACKAGE_BOUNDARY: package absolute import denied: ${args.path}`);
      const locked = lock?.packages[parentId];
      const base = joinVirtualPath(args.resolveDir || "/", args.path);
      if (!locked || !insidePackage(base, locked.storePath)) throw new Error(`ERR_BROWSER_RUNTIME_PACKAGE_BOUNDARY: package import escaped: ${args.path}`);
      return { path: await resolveFile(fs, base), namespace: "package", pluginData: { packageId: parentId } };
    }
    const base = args.path.startsWith("/") ? normalizeInternalPath(args.path) : joinVirtualPath(args.resolveDir || "/", args.path);
    rejectReservedProjectPath(base);
    return { path: await resolveFile(fs, base), namespace: "project" };
  }
  const { name, subpath } = splitPackageImport(args.path);
  const parentId = packageIdFromPluginData(args.pluginData);
  const packageId = parentId ? lock?.packages[parentId]?.dependencies[name] : lock?.roots[name];
  if (!packageId || !lock?.packages[packageId]) throw new Error(`包 ${name} 尚未安装；请先运行 npm install ${name}`);
  const target = await packageEntry(fs, lock.packages[packageId]!, subpath, args.kind === "require-call");
  return { path: target, namespace: "package", pluginData: { packageId } };
}

function builtinName(path: string): string | undefined {
  if (path.startsWith("node:")) return path.slice(5);
  if (NODE_SHIMS.has(path) || UNSUPPORTED_NODE_BUILTINS.has(path)) return path;
  const root = path.split("/", 1)[0]!;
  return NODE_SHIMS.has(root) || UNSUPPORTED_NODE_BUILTINS.has(root) ? path : undefined;
}

function unsupportedBuiltin(specifier: string): Error {
  return new Error(`ERR_BROWSER_RUNTIME_UNSUPPORTED_BUILTIN: Node 内置模块 ${specifier} 在浏览器虚拟运行时不可用`);
}

async function packageEntry(fs: VirtualFileSystem, locked: LockedPackage, subpath: string, requireCall: boolean): Promise<string> {
  const manifest = JSON.parse(bytesText(await fs.readFile(joinVirtualPath(locked.storePath, "package.json")))) as Record<string, unknown>;
  const exported = packageExport(manifest.exports, subpath, requireCall);
  if (manifest.exports !== undefined && exported === undefined) throw new Error(`包 ${locked.name} 未导出 ${subpath ? `./${subpath}` : "."}`);
  const candidate = exported ?? (subpath || (stringField(manifest.browser) ?? stringField(manifest.module) ?? stringField(manifest.main) ?? "index.js"));
  return resolvePackageFile(fs, locked.storePath, candidate);
}

/** Resolve the useful, safe subset of package exports: conditions, subpaths and patterns. */
function packageExport(exportsField: unknown, subpath: string, requireCall: boolean): string | undefined {
  if (exportsField === undefined) return undefined;
  const request = subpath ? `./${subpath}` : ".";
  let target: unknown = exportsField;
  if (typeof exportsField === "object" && exportsField !== null && !Array.isArray(exportsField)) {
    const map = exportsField as Record<string, unknown>;
    if (Object.keys(map).some((key) => key.startsWith("."))) {
      target = map[request];
      if (target === undefined) {
        const pattern = Object.keys(map).filter((key) => key.includes("*") && request.startsWith(key.slice(0, key.indexOf("*"))) && request.endsWith(key.slice(key.indexOf("*") + 1))).sort((a, b) => b.length - a.length)[0];
        if (pattern) {
          const star = request.slice(pattern.indexOf("*"), request.length - (pattern.length - pattern.indexOf("*") - 1));
          return resolveExportTarget(map[pattern], requireCall)?.replaceAll("*", star);
        }
      }
    }
  }
  return resolveExportTarget(target, requireCall);
}

function resolveExportTarget(value: unknown, requireCall: boolean): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) { for (const item of value) { const target = resolveExportTarget(item, requireCall); if (target !== undefined) return target; } return undefined; }
  if (!value || typeof value !== "object") return undefined;
  const conditions = value as Record<string, unknown>;
  for (const key of ["browser", requireCall ? "require" : "import", "default"]) {
    if (key in conditions) { const target = resolveExportTarget(conditions[key], requireCall); if (target !== undefined) return target; }
  }
  return undefined;
}

async function resolvePackageFile(fs: VirtualFileSystem, storePath: string, candidate: string): Promise<string> {
  if (!candidate || candidate.startsWith("/") || candidate.split("/").includes("..")) throw new Error(`不安全的包入口：${candidate}`);
  const path = joinVirtualPath(storePath, candidate);
  if (path !== storePath && !path.startsWith(`${storePath}/`)) throw new Error(`包入口不能离开包目录：${candidate}`);
  return resolveFile(fs, path);
}

async function resolveFile(fs: VirtualFileSystem, path: string): Promise<string> {
  for (const extension of EXTENSIONS) { const candidate = `${path}${extension}`; if (await fs.exists(candidate) && (await fs.stat(candidate)).kind === "file") return candidate; }
  if (await fs.exists(path) && (await fs.stat(path)).kind === "directory") {
    const packageJson = joinVirtualPath(path, "package.json");
    if (await fs.exists(packageJson)) {
      const manifest = JSON.parse(bytesText(await fs.readFile(packageJson))) as Record<string, unknown>;
      const entry = packageExport(manifest.exports, "", false) ?? stringField(manifest.browser) ?? stringField(manifest.module) ?? stringField(manifest.main);
      if (entry) return resolveFile(fs, joinVirtualPath(path, entry));
    }
    for (const extension of EXTENSIONS.slice(1)) { const indexPath = joinVirtualPath(path, `index${extension}`); if (await fs.exists(indexPath)) return indexPath; }
  }
  throw new Error(`找不到模块：${path}`);
}

function loaderFor(path: string): Loader { const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase(); return (["js", "mjs", "cjs"].includes(extension) ? "js" : extension === "ts" ? "ts" : extension === "tsx" ? "tsx" : extension === "jsx" ? "jsx" : extension === "json" ? "json" : "text") as Loader; }
function splitPackageImport(path: string): { name: string; subpath: string } { const parts = path.split("/"); const scoped = path.startsWith("@"); return { name: scoped ? `${parts[0]}/${parts[1]}` : parts[0]!, subpath: parts.slice(scoped ? 2 : 1).join("/") }; }
function packageIdFromPluginData(value: unknown): string | undefined { return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).packageId === "string" ? (value as Record<string, string>).packageId : undefined; }
function stringField(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

function rejectReservedProjectPath(path: string): void { if (normalizeInternalPath(path).split("/").some((part) => part === ".git" || part === ".browser-agent")) throw new Error(`ERR_BROWSER_RUNTIME_FS_PATH: reserved project path: ${path}`); }
function insidePackage(path: string, storePath: string): boolean { return path === storePath || path.startsWith(`${storePath}/`); }

function nodeShim(name: string): string {
  if (name === "process") return "module.exports=process;module.exports.default=process;";
  if (name === "fs") return "module.exports={promises:globalThis.__browserAgentFs};module.exports.default=module.exports;";
  if (name === "fs/promises") return "module.exports=globalThis.__browserAgentFs;module.exports.default=module.exports;";
  if (name === "buffer") return "module.exports={Buffer:globalThis.Buffer,SlowBuffer:globalThis.Buffer};module.exports.default=globalThis.Buffer;";
  if (name === "path" || name === "path/posix") return PATH_SHIM;
  if (name === "events") return EVENTS_SHIM;
  if (name === "util") return UTIL_SHIM;
  if (name === "assert" || name === "assert/strict") return ASSERT_SHIM;
  if (name === "url") return "module.exports={URL:globalThis.URL,URLSearchParams:globalThis.URLSearchParams,pathToFileURL:globalThis.__pathToFileURL,fileURLToPath:globalThis.__fileURLToPath};module.exports.default=module.exports;";
  if (name === "querystring") return QUERYSTRING_SHIM;
  if (name === "string_decoder") return "class StringDecoder{constructor(encoding='utf8'){this.encoding=encoding}write(value){return globalThis.Buffer.from(value).toString(this.encoding)}end(value){return value===undefined?'':this.write(value)}}module.exports={StringDecoder};module.exports.default=StringDecoder;";
  throw unsupportedBuiltin(`node:${name}`);
}

const PATH_SHIM = `
const normalize=p=>{p=String(p);const abs=p.startsWith('/'),trail=p.endsWith('/');const out=[];for(const x of p.split('/')){if(!x||x==='.')continue;if(x==='..'){if(out.length&&out[out.length-1]!=='..')out.pop();else if(!abs)out.push('..')}else out.push(x)}const r=(abs?'/':'')+out.join('/');return (r|| (abs?'/':'.'))+(trail&&r&&r!=='/'?'/':'')};
const join=(...p)=>normalize(p.filter(x=>typeof x==='string'&&x).join('/'));
const resolve=(...p)=>{let out='';for(let i=p.length-1;i>=-1;i--){const x=i<0?process.cwd():p[i];if(typeof x!=='string')throw new TypeError('Path must be a string');out=x+'/'+out;if(x.startsWith('/'))break}return normalize(out).replace(/\\/$/,'')||'/'};
const dirname=p=>{p=normalize(p).replace(/\\/$/,'');const i=p.lastIndexOf('/');return i<0?'.':i===0?'/':p.slice(0,i)};const basename=(p,s='')=>{const b=normalize(p).replace(/\\/$/,'').split('/').pop()||'';return s&&b.endsWith(s)?b.slice(0,-s.length):b};const extname=p=>{const b=basename(p),i=b.lastIndexOf('.');return i<=0?'':b.slice(i)};const parse=p=>{const dir=dirname(p),base=basename(p),ext=extname(p);return {root:p.startsWith('/')?'/':'',dir,base,ext,name:ext?base.slice(0,-ext.length):base}};const format=o=>(o.dir?(o.dir==='/'?'/':o.dir+'/'):'')+(o.base||((o.name||'')+(o.ext||'')));const relative=(a,b)=>{a=resolve(a).split('/').filter(Boolean);b=resolve(b).split('/').filter(Boolean);while(a[0]===b[0]){a.shift();b.shift()}return [...a.map(()=> '..'),...b].join('/')};const api={normalize,join,resolve,dirname,basename,extname,parse,format,relative,isAbsolute:p=>String(p).startsWith('/'),sep:'/',delimiter:':'};api.posix=api;module.exports=api;module.exports.default=api;`;

const EVENTS_SHIM = `
class EventEmitter{constructor(){this._events=Object.create(null)}on(n,fn){if(typeof fn!=='function')throw new TypeError('listener must be a function');(this._events[n]||(this._events[n]=[])).push(fn);return this}addListener(n,fn){return this.on(n,fn)}prependListener(n,fn){(this._events[n]||(this._events[n]=[])).unshift(fn);return this}once(n,fn){const w=(...a)=>{this.off(n,w);return fn.apply(this,a)};w.listener=fn;return this.on(n,w)}off(n,fn){const a=this._events[n];if(a){const i=a.findIndex(x=>x===fn||x.listener===fn);if(i>=0)a.splice(i,1)}return this}removeListener(n,fn){return this.off(n,fn)}removeAllListeners(n){if(n===undefined)this._events=Object.create(null);else delete this._events[n];return this}emit(n,...a){const l=this._events[n];if(!l||!l.length)return false;for(const fn of [...l])fn.apply(this,a);return true}listeners(n){return [...(this._events[n]||[])].map(x=>x.listener||x)}listenerCount(n){return (this._events[n]||[]).length}};EventEmitter.listenerCount=(e,n)=>e.listenerCount(n);const once=(e,n)=>new Promise((resolve,reject)=>{const ok=(...a)=>{e.off('error',bad);resolve(a)};const bad=x=>{e.off(n,ok);reject(x)};e.once(n,ok);if(n!=='error')e.once('error',bad)});module.exports=EventEmitter;module.exports.EventEmitter=EventEmitter;module.exports.once=once;module.exports.default=EventEmitter;`;

const UTIL_SHIM = `
const inspect=v=>{const seen=[];const walk=x=>{if(x===null||typeof x!=='object')return typeof x==='string'?"'"+x+"'":String(x);if(seen.includes(x))return '[Circular]';seen.push(x);const r=Array.isArray(x)?'['+x.map(walk).join(', ')+']':'{ '+Object.keys(x).map(k=>k+': '+walk(x[k])).join(', ')+' }';seen.pop();return r};return walk(v)};const format=(f,...a)=>{if(typeof f!=='string')return [f,...a].map(inspect).join(' ');let i=0;const out=f.replace(/%[sdijoO%]/g,x=>{if(x==='%%')return '%';const v=a[i++];if(x==='s')return String(v);if(x==='d'||x==='i')return Number(v);if(x==='j'){try{return JSON.stringify(v)}catch{return '[Circular]'}}return inspect(v)});return out+(i<a.length?' '+a.slice(i).map(inspect).join(' '):'')};const inherits=(ctor,superCtor)=>{Object.setPrototypeOf(ctor.prototype,superCtor.prototype);Object.setPrototypeOf(ctor,superCtor)};const types={isDate:v=>v instanceof Date,isRegExp:v=>v instanceof RegExp,isMap:v=>v instanceof Map,isSet:v=>v instanceof Set,isUint8Array:v=>v instanceof Uint8Array,isArrayBuffer:v=>v instanceof ArrayBuffer};module.exports={format,inspect,inherits,types};module.exports.default=module.exports;`;

const ASSERT_SHIM = `
class AssertionError extends Error{constructor(message){super(message||'Assertion failed');this.name='AssertionError';this.code='ERR_ASSERTION'}};const fail=m=>{throw new AssertionError(m)};const deep=(a,b,seen=new Map)=>{if(Object.is(a,b))return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||a.constructor!==b.constructor)return false;if(seen.get(a)===b)return true;seen.set(a,b);if(a instanceof Date)return +a===+b;if(a instanceof RegExp)return String(a)===String(b);if(ArrayBuffer.isView(a)){if(a.byteLength!==b.byteLength)return false;for(let i=0;i<a.byteLength;i++)if(a[i]!==b[i])return false;return true}const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&ak.every(k=>Object.prototype.hasOwnProperty.call(b,k)&&deep(a[k],b[k],seen))};const match=(error,expected)=>!expected||typeof expected==='function'?(expected?error instanceof expected:false):expected instanceof RegExp?expected.test(String(error&&error.message||error)):typeof expected==='object'?Object.keys(expected).every(k=>error&&error[k]===expected[k]):false;function assert(v,m){if(!v)fail(m)}assert.ok=assert;assert.fail=fail;assert.equal=(a,b,m)=>{if(a!=b)fail(m)};assert.notEqual=(a,b,m)=>{if(a==b)fail(m)};assert.strictEqual=(a,b,m)=>{if(!Object.is(a,b))fail(m)};assert.notStrictEqual=(a,b,m)=>{if(Object.is(a,b))fail(m)};assert.deepEqual=(a,b,m)=>{if(!deep(a,b))fail(m)};assert.deepStrictEqual=assert.deepEqual;assert.notDeepEqual=(a,b,m)=>{if(deep(a,b))fail(m)};assert.notDeepStrictEqual=assert.notDeepEqual;assert.throws=(fn,expected,m)=>{try{fn()}catch(e){if(match(e,expected))return e;fail(m||'Unexpected error')}fail(m||'Missing expected exception')};assert.doesNotThrow=(fn,m)=>{try{fn()}catch(e){fail(m||e.message)}};assert.rejects=async(p,expected,m)=>{try{await (typeof p==='function'?p():p)}catch(e){if(match(e,expected))return e;fail(m||'Unexpected rejection')}fail(m||'Missing expected rejection')};assert.doesNotReject=async(p,m)=>{try{await(typeof p==='function'?p():p)}catch(e){fail(m||e.message)}};assert.AssertionError=AssertionError;assert.strict=assert;module.exports=assert;module.exports.default=assert;`;

const QUERYSTRING_SHIM = `
const esc=s=>encodeURIComponent(String(s)).replace(/%20/g,'+');const unesc=s=>{try{return decodeURIComponent(String(s).replace(/\\+/g,' '))}catch{return String(s)}};const parse=s=>{const out=Object.create(null);for(const part of String(s).split('&')){if(!part)continue;const i=part.indexOf('='),k=unesc(i<0?part:part.slice(0,i)),v=unesc(i<0?'':part.slice(i+1));out[k]=Object.prototype.hasOwnProperty.call(out,k)?[].concat(out[k],v):v}return out};const stringify=o=>Object.keys(o||{}).flatMap(k=>[].concat(o[k]).map(v=>esc(k)+'='+esc(v))).join('&');module.exports={parse,decode:parse,stringify,encode:stringify,escape:esc,unescape:unesc};module.exports.default=module.exports;`;

async function ensureEsbuild(): Promise<void> { if (typeof window === "undefined") return; browserInitialization ??= import("esbuild-wasm/esbuild.wasm?url").then(async ({ default: wasmURL }) => initialize({ wasmURL, worker: true })); await browserInitialization; }
