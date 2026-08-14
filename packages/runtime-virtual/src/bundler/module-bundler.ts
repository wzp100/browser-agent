import { build, initialize, type Loader, type OnResolveArgs, type Plugin } from "esbuild-wasm";
import { bytesText, type VirtualFileSystem } from "../types";
import { joinVirtualPath, normalizeInternalPath, virtualDirname } from "../paths";
import type { LockedPackage, VirtualPackageLock } from "../packages/package-manager";

const EXTENSIONS = ["", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json"];
let browserInitialization: Promise<void> | undefined;

export interface BundleResult { code: string; warnings: string[]; }

export class VirtualModuleBundler {
  constructor(private readonly fs: VirtualFileSystem, private readonly readLock: () => Promise<VirtualPackageLock | undefined>) {}

  async bundleEntry(entryPath: string): Promise<BundleResult> {
    await ensureEsbuild();
    const entry = await resolveFile(this.fs, normalizeInternalPath(entryPath));
    return this.build({ entryPoints: [entry] });
  }

  async bundleSource(source: string, resolveDirectory = "/", loader: Loader = "js"): Promise<BundleResult> {
    await ensureEsbuild();
    return this.build({ stdin: { contents: source, resolveDir: normalizeInternalPath(resolveDirectory), sourcefile: "runtime-input.ts", loader } });
  }

  private async build(input: { entryPoints: string[] } | { stdin: { contents: string; resolveDir: string; sourcefile: string; loader: Loader } }): Promise<BundleResult> {
    const lock = await this.readLock();
    const result = await build({
      ...input,
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2020",
      logLevel: "silent",
      sourcemap: "inline",
      plugins: [virtualModulesPlugin(this.fs, lock)]
    });
    const output = result.outputFiles?.[0];
    if (!output) throw new Error("esbuild 没有生成 JavaScript 输出");
    return { code: output.text, warnings: result.warnings.map((warning) => warning.text) };
  }
}

function virtualModulesPlugin(fs: VirtualFileSystem, lock: VirtualPackageLock | undefined): Plugin {
  return {
    name: "browser-agent-virtual-modules",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, async (args) => resolveModule(fs, lock, args));
      buildApi.onLoad({ filter: /.*/, namespace: "project" }, async ({ path }) => ({ contents: bytesText(await fs.readFile(path)), loader: loaderFor(path), resolveDir: virtualDirname(path) }));
      buildApi.onLoad({ filter: /.*/, namespace: "package" }, async ({ path, pluginData }) => ({
        contents: bytesText(await fs.readFile(path)),
        loader: loaderFor(path),
        resolveDir: virtualDirname(path),
        pluginData
      }));
      buildApi.onLoad({ filter: /.*/, namespace: "node-shim" }, ({ path }) => ({ contents: nodeShim(path), loader: "js" }));
    }
  };
}

async function resolveModule(fs: VirtualFileSystem, lock: VirtualPackageLock | undefined, args: OnResolveArgs): Promise<ReturnType<Plugin["setup"]> extends never ? never : object> {
  if (args.namespace === "node-shim") return { path: args.path, namespace: "node-shim" };
  if (isNodeBuiltin(args.path)) return { path: args.path.replace(/^node:/, ""), namespace: "node-shim" };
  if (args.kind === "entry-point") return { path: await resolveFile(fs, normalizeInternalPath(args.path)), namespace: "project" };
  if (args.path.startsWith(".") || args.path.startsWith("/")) {
    const base = args.path.startsWith("/") ? normalizeInternalPath(args.path) : joinVirtualPath(args.resolveDir || "/", args.path);
    return { path: await resolveFile(fs, base), namespace: args.namespace || "project", pluginData: args.pluginData };
  }
  const { name, subpath } = splitPackageImport(args.path);
  const parentId = packageIdFromPluginData(args.pluginData);
  const packageId = parentId ? lock?.packages[parentId]?.dependencies[name] ?? lock?.roots[name] : lock?.roots[name];
  if (!packageId || !lock?.packages[packageId]) throw new Error(`包 ${name} 尚未安装；请先运行 npm install ${name}`);
  const target = await packageEntry(fs, lock.packages[packageId]!, subpath);
  return { path: target, namespace: "package", pluginData: { packageId } };
}

async function packageEntry(fs: VirtualFileSystem, locked: LockedPackage, subpath: string): Promise<string> {
  if (subpath) return resolveFile(fs, joinVirtualPath(locked.storePath, subpath));
  const packageJsonPath = joinVirtualPath(locked.storePath, "package.json");
  const manifest = JSON.parse(bytesText(await fs.readFile(packageJsonPath))) as Record<string, unknown>;
  const candidate = exportEntry(manifest.exports) ?? stringField(manifest.browser) ?? stringField(manifest.module) ?? stringField(manifest.main) ?? "index.js";
  return resolveFile(fs, joinVirtualPath(locked.storePath, candidate));
}

function exportEntry(exportsField: unknown): string | undefined {
  if (typeof exportsField === "string") return exportsField;
  if (!exportsField || typeof exportsField !== "object") return undefined;
  const exports = exportsField as Record<string, unknown>;
  const root = exports["."] ?? exports;
  if (typeof root === "string") return root;
  if (!root || typeof root !== "object") return undefined;
  const conditions = root as Record<string, unknown>;
  for (const key of ["browser", "import", "require", "default"]) if (typeof conditions[key] === "string") return conditions[key] as string;
  return undefined;
}

async function resolveFile(fs: VirtualFileSystem, path: string): Promise<string> {
  for (const extension of EXTENSIONS) {
    const candidate = `${path}${extension}`;
    if (await fs.exists(candidate) && (await fs.stat(candidate)).kind === "file") return candidate;
  }
  if (await fs.exists(path) && (await fs.stat(path)).kind === "directory") {
    const packageJson = joinVirtualPath(path, "package.json");
    if (await fs.exists(packageJson)) {
      const manifest = JSON.parse(bytesText(await fs.readFile(packageJson))) as Record<string, unknown>;
      const entry = exportEntry(manifest.exports) ?? stringField(manifest.browser) ?? stringField(manifest.module) ?? stringField(manifest.main);
      if (entry) return resolveFile(fs, joinVirtualPath(path, entry));
    }
    for (const extension of EXTENSIONS.slice(1)) {
      const indexPath = joinVirtualPath(path, `index${extension}`);
      if (await fs.exists(indexPath)) return indexPath;
    }
  }
  throw new Error(`找不到模块：${path}`);
}

function loaderFor(path: string): Loader {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["js", "mjs", "cjs"].includes(extension)) return "js";
  if (extension === "ts") return "ts";
  if (extension === "tsx") return "tsx";
  if (extension === "jsx") return "jsx";
  if (extension === "json") return "json";
  return "text";
}

function splitPackageImport(path: string): { name: string; subpath: string } {
  const parts = path.split("/");
  const name = path.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
  return { name, subpath: parts.slice(path.startsWith("@") ? 2 : 1).join("/") };
}

function packageIdFromPluginData(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).packageId === "string"
    ? (value as Record<string, string>).packageId : undefined;
}

function stringField(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

function isNodeBuiltin(path: string): boolean {
  return path.startsWith("node:") || ["assert", "async_hooks", "buffer", "child_process", "cluster", "crypto", "dgram", "diagnostics_channel", "dns", "events", "fs", "http", "http2", "https", "module", "net", "os", "path", "perf_hooks", "process", "querystring", "readline", "repl", "stream", "string_decoder", "timers", "tls", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"].includes(path);
}

function nodeShim(name: string): string {
  if (name === "process") return `module.exports = process; module.exports.default = process;`;
  if (name === "path") return `
const normalize = p => { const out=[]; for(const x of String(p).replace(/\\\\/g,'/').split('/')) { if(!x||x==='.') continue; if(x==='..') out.pop(); else out.push(x); } return (String(p).startsWith('/')?'/':'')+out.join('/'); };
const join = (...parts) => normalize(parts.filter(Boolean).join('/'));
const dirname = p => { const n=normalize(p); const i=n.lastIndexOf('/'); return i<=0?(n.startsWith('/')?'/':'.'):n.slice(0,i); };
const basename = p => { const n=normalize(p); return n.slice(n.lastIndexOf('/')+1); };
const extname = p => { const b=basename(p), i=b.lastIndexOf('.'); return i<=0?'':b.slice(i); };
module.exports = { normalize, join, resolve: (...p)=>join(process.cwd(),...p), dirname, basename, extname, sep:'/', delimiter:':' }; module.exports.default=module.exports;`;
  if (name === "util") return `module.exports = { inherits:(ctor,superCtor)=>Object.setPrototypeOf(ctor.prototype,superCtor.prototype), types:{ isDate:v=>v instanceof Date } }; module.exports.default=module.exports;`;
  if (name === "assert") return `function assert(value,message){if(!value)throw new Error(message||'Assertion failed')} assert.ok=assert; assert.equal=(a,b,m)=>{if(a!=b)throw new Error(m||('Expected '+a+' == '+b))}; assert.strictEqual=(a,b,m)=>{if(a!==b)throw new Error(m||('Expected strict equality'))}; module.exports=assert; module.exports.default=assert;`;
  if (name === "buffer") return `class Buffer extends Uint8Array { static from(value){ if(typeof value==='string') return new Buffer([...value].map(c=>c.charCodeAt(0))); return new Buffer(value); } toString(){ return [...this].map(c=>String.fromCharCode(c)).join(''); } } module.exports={Buffer}; module.exports.default=Buffer;`;
  throw new Error(`不支持的 Node 内置模块：${name}`);
}

async function ensureEsbuild(): Promise<void> {
  if (typeof window === "undefined") return;
  browserInitialization ??= import("esbuild-wasm/esbuild.wasm?url").then(async ({ default: wasmURL }) => initialize({ wasmURL, worker: true }));
  await browserInitialization;
}
