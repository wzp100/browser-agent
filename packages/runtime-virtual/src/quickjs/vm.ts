import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSContext, type QuickJSRuntime } from "quickjs-emscripten-core";
import type { QuickJsExecutionOptions, QuickJsExecutionResult } from "./types";
import type { SandboxFilesystemOverlay } from "./sandbox-filesystem";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_LIMIT = 64 * 1024 * 1024;
const DEFAULT_STACK_LIMIT = 1 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const quickJsModule = newQuickJSWASMModuleFromVariant(RELEASE_SYNC);

/** 在 QuickJS/WASM 中执行打包后的 JavaScript，不暴露宿主 DOM、网络或文件系统。 */
export async function runQuickJsScript(options: QuickJsExecutionOptions): Promise<QuickJsExecutionResult> {
  const timeoutMs = clamp(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 60_000);
  const memoryLimitBytes = clamp(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT, 8 * 1024 * 1024, 256 * 1024 * 1024);
  const maxStackBytes = clamp(options.maxStackBytes ?? DEFAULT_STACK_LIMIT, 128 * 1024, 4 * 1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  let interrupted = false;
  const stdout: string[] = [];
  const stderr: string[] = [];
  // Only this host-generated value represents process.exit; user exceptions must never commit a filesystem overlay.
  const exitSignal = crypto.randomUUID();
  const QuickJS = await quickJsModule;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryLimitBytes);
  runtime.setMaxStackSize(maxStackBytes);
  runtime.setInterruptHandler(() => (interrupted = Date.now() >= deadline));
  const vm = runtime.newContext();

  try {
    installConsole(vm, stdout, stderr);
    const result = vm.evalCode(`${createPrelude(options.args ?? [], options.env ?? {}, options.cwd ?? "/workspace", options.filename ?? "/workspace/index.js", options.filesystem, exitSignal)}\n${options.source}`, options.filename ?? "/workspace/index.js", { type: "global" });
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      if (error === exitSignal) return successfulResult(vm, stdout, stderr);
      return failedResult(error, interrupted, timeoutMs, stdout, stderr);
    }
    result.value.dispose();
    drainNextTicks(vm);
    const jobError = drainPendingJobs(runtime, vm, deadline);
    if (jobError !== undefined) {
      if (jobError === exitSignal) return successfulResult(vm, stdout, stderr);
      return failedResult(jobError, interrupted, timeoutMs, stdout, stderr);
    }
    const asyncError = readAsyncError(vm);
    if (asyncError !== undefined) return failedResult(asyncError, interrupted, timeoutMs, stdout, stderr);
    return successfulResult(vm, stdout, stderr);
  } catch (error) {
    return failedResult(error, interrupted, timeoutMs, stdout, stderr);
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

/** Drain QuickJS Promise jobs before disposing the context.  Without this, a normal
 * Promise.resolve().then(...) is silently lost at the end of an execution. */
function drainPendingJobs(runtime: QuickJSRuntime, vm: QuickJSContext, deadline: number): unknown | undefined {
  // A next-tick callback can schedule Promise work and a Promise callback can schedule
  // another next-tick callback, so repeat the two queues until both are quiet.
  while (true) {
    if (Date.now() >= deadline) throw new Error("QuickJS pending jobs timed out");
    drainNextTicks(vm);
    if (!runtime.hasPendingJob()) {
      drainNextTicks(vm);
      if (!runtime.hasPendingJob()) return undefined;
    }
    const result = runtime.executePendingJobs();
    if ("error" in result && result.error) {
      const error = result.error.context.dump(result.error);
      result.error.dispose();
      return error;
    }
  }
}

function successfulResult(vm: QuickJSContext, stdout: string[], stderr: string[]): QuickJsExecutionResult {
  const filesystemOverlay = readFilesystemOverlay(vm);
  return { exitCode: readExitCode(vm), stdout: stdout.join(""), stderr: stderr.join(""), ...(filesystemOverlay ? { filesystemOverlay } : {}) };
}

function drainNextTicks(vm: QuickJSContext): void {
  const result = vm.evalCode("globalThis.__browserAgentDrainNextTicks && globalThis.__browserAgentDrainNextTicks()", "runtime:next-ticks");
  if (result.error) { const error = result.error; const message = vm.dump(error); error.dispose(); throw new Error(formatError(message)); }
  result.value.dispose();
}

function readAsyncError(vm: QuickJSContext): unknown | undefined {
  const result = vm.evalCode("globalThis.__browserAgentAsyncError && globalThis.__browserAgentAsyncError()", "runtime:unhandled-rejection");
  if (result.error) { result.error.dispose(); return undefined; }
  const value = vm.dump(result.value);
  result.value.dispose();
  return value === undefined || value === null ? undefined : value;
}

function readFilesystemOverlay(vm: QuickJSContext): SandboxFilesystemOverlay | undefined {
  const result = vm.evalCode("globalThis.__browserAgentFs && globalThis.__browserAgentFs.__manifest()", "runtime:filesystem-manifest");
  if (result.error) { result.error.dispose(); return undefined; }
  const value = vm.dump(result.value);
  result.value.dispose();
  if (!value || typeof value !== "object") return undefined;
  const manifest = value as SandboxFilesystemOverlay;
  return Array.isArray(manifest.directories) && Array.isArray(manifest.writes) ? manifest : undefined;
}

function installConsole(vm: QuickJSContext, stdout: string[], stderr: string[]): void {
  let outputBytes = 0;
  const write = (target: string[], text: string): void => {
    outputBytes += new TextEncoder().encode(text).byteLength;
    if (outputBytes > MAX_OUTPUT_BYTES) throw new Error(`输出超过 ${MAX_OUTPUT_BYTES} 字节预算`);
    target.push(text);
  };
  const consoleHandle = vm.newObject();
  for (const [name, target] of [["log", stdout], ["info", stdout], ["warn", stderr], ["error", stderr]] as const) {
    const fn = vm.newFunction(name, (...args) => write(target, `${args.map((argument) => formatConsoleValue(vm.dump(argument))).join(" ")}\n`));
    vm.setProp(consoleHandle, name, fn);
    fn.dispose();
  }
  vm.setProp(vm.global, "console", consoleHandle);
  consoleHandle.dispose();
}

function createPrelude(args: string[], env: Record<string, string>, cwd: string, filename: string, filesystem: QuickJsExecutionOptions["filesystem"], exitSignal: string): string {
  const safeArgs = JSON.stringify(["browser-node", filename, ...args]);
  const safeEnv = JSON.stringify(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])));
  const safeCwd = JSON.stringify(cwd);
  const safeFilesystem = JSON.stringify(filesystem ?? { entries: [] });
  const safeExitSignal = JSON.stringify(exitSignal);
  return `
/* Browser-runtime primordials: pure JS only; no Worker, DOM, fetch, or host handles. */
(function(){
const utf8Encode=s=>{const a=[];for(let i=0;i<String(s).length;i++){let c=String(s).charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const n=String(s).charCodeAt(i+1);if(n>=0xdc00&&n<=0xdfff){c=0x10000+((c-0xd800)<<10)+(n-0xdc00);i++}else c=0xfffd}else if(c>=0xdc00&&c<=0xdfff)c=0xfffd;if(c<0x80)a.push(c);else if(c<0x800)a.push(0xc0|c>>6,0x80|c&63);else if(c<0x10000)a.push(0xe0|c>>12,0x80|c>>6&63,0x80|c&63);else a.push(0xf0|c>>18,0x80|c>>12&63,0x80|c>>6&63,0x80|c&63)}return new Uint8Array(a)};
const utf8Decode=bytes=>{let s='',i=0;while(i<bytes.length){const a=bytes[i++];if(a<128){s+=String.fromCharCode(a);continue}const n=a<224?1:a<240?2:a<248?3:0;if(!n||i+n>bytes.length){s+='�';continue}let c=a&((1<<(7-n))-1),ok=true;for(let j=0;j<n;j++){const x=bytes[i++];if((x&192)!==128)ok=false;c=c<<6|x&63}if(!ok||c>0x10ffff||(c>=0xd800&&c<=0xdfff))s+='�';else if(c<0x10000)s+=String.fromCharCode(c);else{s+=String.fromCharCode(0xd800+((c-0x10000)>>10),0xdc00+(c-0x10000&1023))}}return s};
const hex=b=>Array.prototype.map.call(b,x=>x.toString(16).padStart(2,'0')).join('');const unhex=s=>{s=String(s);const a=[];for(let i=0;i+1<s.length;i+=2){const n=parseInt(s.slice(i,i+2),16);if(Number.isNaN(n))break;a.push(n)}return new Uint8Array(a)};const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';const b64=b=>{let s='';for(let i=0;i<b.length;i+=3){const n=(b[i]<<16)|((b[i+1]||0)<<8)|(b[i+2]||0);s+=alphabet[n>>18]+alphabet[n>>12&63]+(i+1<b.length?alphabet[n>>6&63]:'=')+(i+2<b.length?alphabet[n&63]:'=')}return s};const unb64=value=>{const s=String(value).replace(/-/g,'+').replace(/_/g,'/').replace(/[^A-Za-z0-9+\\/]/g,'');const a=[];for(let i=0;i<s.length;i+=4){const count=Math.min(4,s.length-i);if(count<2)break;const n=(alphabet.indexOf(s[i])<<18)|(alphabet.indexOf(s[i+1])<<12)|((count>2?alphabet.indexOf(s[i+2]):0)<<6)|(count>3?alphabet.indexOf(s[i+3]):0);a.push(n>>16&255);if(count>2)a.push(n>>8&255);if(count>3)a.push(n&255)}return new Uint8Array(a)};const encode=(v,e='utf8')=>e==='hex'?unhex(v):e==='base64'||e==='base64url'?unb64(v):utf8Encode(v);
class BrowserBuffer extends Uint8Array{static from(v,e){if(typeof v==='string')return new BrowserBuffer(encode(v,e));if(v instanceof ArrayBuffer)return new BrowserBuffer(v.slice(0));if(ArrayBuffer.isView(v)||Array.isArray(v))return new BrowserBuffer(v);throw new TypeError('Unsupported Buffer input')}static alloc(n,fill=0,e){const b=new BrowserBuffer(n);if(typeof fill==='string')b.set(encode(fill,e));else b.fill(fill);return b}static allocUnsafe(n){return new BrowserBuffer(n)}static concat(list,n){n=n===undefined?list.reduce((x,b)=>x+b.length,0):n;const b=new BrowserBuffer(n);let i=0;for(const x of list){b.set(x.subarray(0,n-i),i);i+=x.length;if(i>=n)break}return b}static isBuffer(v){return v instanceof BrowserBuffer}static byteLength(v,e){return typeof v==='string'?encode(v,e).length:BrowserBuffer.from(v).length}toString(e='utf8',start=0,end=this.length){const b=this.subarray(start,end);return e==='hex'?hex(b):e==='base64'||e==='base64url'?b64(b):utf8Decode(b)}equals(b){return this.length===b.length&&this.every((x,i)=>x===b[i])}toJSON(){return {type:'Buffer',data:Array.from(this)}}}globalThis.Buffer=BrowserBuffer;
if(!globalThis.TextEncoder)globalThis.TextEncoder=class{encode(s){return utf8Encode(s)}};if(!globalThis.TextDecoder)globalThis.TextDecoder=class{decode(b){return utf8Decode(b||[])}};
class BrowserURLSearchParams{constructor(init=''){this.pairs=[];if(typeof init==='string'){for(const p of init.replace(/^\\?/,'').split('&'))if(p){const i=p.indexOf('=');this.append(decodeURIComponent((i<0?p:p.slice(0,i)).replace(/\\+/g,' ')),decodeURIComponent((i<0?'':p.slice(i+1)).replace(/\\+/g,' ')))}}else if(init&&typeof init[Symbol.iterator]==='function')for(const [k,v] of init)this.append(k,v);else for(const k in init)this.append(k,init[k])}append(k,v){this.pairs.push([String(k),String(v)])}set(k,v){this.delete(k);this.append(k,v)}get(k){const p=this.pairs.find(x=>x[0]===String(k));return p?p[1]:null}getAll(k){return this.pairs.filter(x=>x[0]===String(k)).map(x=>x[1])}has(k){return this.pairs.some(x=>x[0]===String(k))}delete(k){this.pairs=this.pairs.filter(x=>x[0]!==String(k))}sort(){this.pairs.sort((a,b)=>a[0].localeCompare(b[0]))}toString(){return this.pairs.map(([k,v])=>encodeURIComponent(k).replace(/%20/g,'+')+'='+encodeURIComponent(v).replace(/%20/g,'+')).join('&')}entries(){return this.pairs[Symbol.iterator]()}keys(){return this.pairs.map(x=>x[0])[Symbol.iterator]()}values(){return this.pairs.map(x=>x[1])[Symbol.iterator]()}forEach(f,t){this.pairs.forEach(([v,k])=>f.call(t,k,v,this))}[Symbol.iterator](){return this.entries()}}
class BrowserURL{constructor(input,base){const raw=base&& !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)?String(base).replace(/[^/]*$/,'')+input:String(input);const m=/^([a-zA-Z][a-zA-Z0-9+.-]*:)(?:\\/\\/([^/?#]*))?([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(raw);if(!m)throw new TypeError('Invalid URL');this.protocol=m[1];this.host=m[2]||'';this.hostname=this.host.replace(/:.*/,'');this.port=this.host.includes(':')?this.host.slice(this.host.lastIndexOf(':')+1):'';this.pathname=m[3]||'/';this.search=m[4]||'';this.hash=m[5]||'';this.searchParams=new BrowserURLSearchParams(this.search)}get href(){const q=this.searchParams.toString();return this.protocol+(this.host?'//'+this.host:this.protocol==='file:'?'//':'')+this.pathname+(q?'?'+q:'')+this.hash}toString(){return this.href}toJSON(){return this.href}}
globalThis.URL=globalThis.URL||BrowserURL;globalThis.URLSearchParams=globalThis.URLSearchParams||BrowserURLSearchParams;
const __originalPromiseThen=Promise.prototype.then,__rejectedPromises=new Map();Promise.prototype.then=function(onFulfilled,onRejected){if(typeof onRejected==='function')__rejectedPromises.delete(this);const next=__originalPromiseThen.call(this,onFulfilled,onRejected);__originalPromiseThen.call(next,undefined,error=>{__rejectedPromises.set(next,error)});return next};globalThis.__browserAgentAsyncError=()=>{for(const error of __rejectedPromises.values())return error};
const __filesystemSnapshot=${safeFilesystem};
const __fsError=(code,message)=>{const error=new Error(code+': '+message);error.code=code;return error};
const __fsPath=input=>{if(typeof input!=='string'||input.includes('\\0'))throw __fsError('ERR_BROWSER_RUNTIME_FS_PATH','invalid path');let path=input.replace(/\\\\/g,'/');if(!path.startsWith('/'))path=${safeCwd}.replace(/\\/$/,'')+'/'+path;if(path==='/workspace')return path;if(!path.startsWith('/workspace/'))throw __fsError('ERR_BROWSER_RUNTIME_FS_PATH','outside /workspace');const out=[];for(const part of path.slice('/workspace/'.length).split('/')){if(!part||part==='.')continue;if(part==='..'){if(!out.length)throw __fsError('ERR_BROWSER_RUNTIME_FS_PATH','outside /workspace');out.pop()}else out.push(part)}path='/workspace/'+out.join('/');if(out.some(part=>part==='.git'||part==='.browser-agent'))throw __fsError('ERR_BROWSER_RUNTIME_FS_PATH','reserved path');if(path.length>1024||out.length>32)throw __fsError('ERR_BROWSER_RUNTIME_FS_PATH','path quota');return path};
const __snapshot=new Map(),__directories=new Set(['/workspace']),__writes=new Map(),__madeDirectories=new Set();for(const entry of __filesystemSnapshot.entries||[]){if(!entry||typeof entry.path!=='string')continue;if(entry.kind==='directory')__directories.add(entry.path);else if(entry.kind==='file')__snapshot.set(entry.path,entry)};
const __parents=path=>{const result=[];for(let i=path.lastIndexOf('/');i>'/workspace'.length;i=path.lastIndexOf('/',i-1))result.push(path.slice(0,i));return result};
const __data=entry=>entry&&unb64(entry.data||'');const __changedPathCount=()=>new Set([...__writes.keys(),...__madeDirectories]).size;const __recordDirectory=path=>{if(!__directories.has(path)&&!__madeDirectories.has(path)){if(__changedPathCount()>=64)throw __fsError('ERR_BROWSER_RUNTIME_FS_QUOTA','changed path quota');__directories.add(path);__madeDirectories.add(path)}};const __ensureParent=path=>{for(const parent of __parents(path)){if(!__directories.has(parent)&&!__madeDirectories.has(parent))throw __fsError('ENOENT','parent directory does not exist: '+parent)}};
const __encoding=value=>typeof value==='string'?value:(value&&typeof value.encoding==='string'?value.encoding:null);const __read=(path,options)=>{path=__fsPath(path);const entry=__writes.get(path)||__snapshot.get(path);if(!entry){if(__directories.has(path)||__madeDirectories.has(path))throw __fsError('EISDIR',path);throw __fsError('ENOENT',path)}const bytes=__data(entry);const encoding=__encoding(options);return encoding?new BrowserBuffer(bytes).toString(encoding):new BrowserBuffer(bytes)};
const __write=(path,value,options)=>{path=__fsPath(path);if(__directories.has(path)||__madeDirectories.has(path))throw __fsError('EISDIR',path);__ensureParent(path);let bytes;if(typeof value==='string')bytes=encode(value,__encoding(options)||'utf8');else if(value instanceof ArrayBuffer||ArrayBuffer.isView(value)||Array.isArray(value))bytes=BrowserBuffer.from(value);else throw new TypeError('writeFile data must be a string or binary value');if(bytes.length>1048576)throw __fsError('ERR_BROWSER_RUNTIME_FS_QUOTA','written file too large');const projected=[...__writes.entries()].reduce((total,[key,item])=>total+(key===path?0:__data(item).length),0)+bytes.length;if(__changedPathCount()+(__writes.has(path)?0:1)>64||projected>4194304)throw __fsError('ERR_BROWSER_RUNTIME_FS_QUOTA','write quota');const original=__snapshot.get(path);__writes.set(path,{path,data:b64(bytes),expectedFingerprint:original&&original.fingerprint});};
const __fsApi={readFile:async(path,options)=>__read(path,options),writeFile:async(path,data,options)=>__write(path,data,options),mkdir:async(path,options={})=>{path=__fsPath(path);if(__snapshot.has(path)||__writes.has(path))throw __fsError('EEXIST',path);if(!options.recursive)__ensureParent(path);else for(const parent of __parents(path).reverse())__recordDirectory(parent);__recordDirectory(path)},readdir:async(path,options)=>{path=__fsPath(path);if(!__directories.has(path)&&!__madeDirectories.has(path))throw __fsError('ENOTDIR',path);const names=new Set();for(const key of [...__snapshot.keys(),...__writes.keys(),...__directories,...__madeDirectories])if(key.startsWith(path==='/'?'/':path+'/')){const rest=key.slice((path==='/'?'/':path+'/').length);if(rest&&!rest.includes('/'))names.add(rest)}const list=[...names].sort();return options&&options.withFileTypes?list.map(name=>({name,isFile:()=>Boolean(__writes.get(path+'/'+name)||__snapshot.get(path+'/'+name)),isDirectory:()=>Boolean(__directories.has(path+'/'+name)||__madeDirectories.has(path+'/'+name))})):list},stat:async(path)=>{path=__fsPath(path);const entry=__writes.get(path)||__snapshot.get(path);if(entry){const size=__data(entry).length;return {size,isFile:()=>true,isDirectory:()=>false,mode:0o100666}}if(__directories.has(path)||__madeDirectories.has(path))return {size:0,isFile:()=>false,isDirectory:()=>true,mode:0o40777};throw __fsError('ENOENT',path)},access:async(path)=>{await __fsApi.stat(path)},__manifest:()=>({directories:[...__madeDirectories].sort(),writes:[...__writes.values()].sort((a,b)=>a.path.localeCompare(b.path))})};Object.freeze(__fsApi);globalThis.__browserAgentFs=__fsApi;
const workspacePath=path=>path==='/workspace'||path.startsWith('/workspace/');const filePathEncode=path=>path.split('/').map(encodeURIComponent).join('/');globalThis.__pathToFileURL=path=>{path=String(path);if(!workspacePath(path))throw new TypeError('只能转换 /workspace 内的文件 URL');return new globalThis.URL('file://'+filePathEncode(path))};globalThis.__fileURLToPath=url=>{const value=typeof url==='string'?new globalThis.URL(url):url;if(value.protocol!=='file:'||!workspacePath(value.pathname))throw new TypeError('文件 URL 必须位于 /workspace');return decodeURIComponent(value.pathname)};
globalThis.global=globalThis;let exitCode=0,requestedExitCode;const __nextTicks=[];globalThis.__browserAgentDrainNextTicks=()=>{while(__nextTicks.length)__nextTicks.shift()()};const process={argv:${safeArgs},argv0:'browser-node',env:${safeEnv},cwd:()=>${safeCwd},platform:'browser',browser:true,version:'v22.0.0-browser',versions:Object.freeze({node:'22.0.0-browser',quickjs:'2025-09-13'}),get exitCode(){return requestedExitCode===undefined?exitCode:requestedExitCode},set exitCode(value){if(requestedExitCode===undefined)exitCode=value},nextTick:(fn,...values)=>{if(typeof fn!=='function')throw new TypeError('callback must be a function');__nextTicks.push(()=>fn(...values))},exit(code=0){requestedExitCode=Number(code)||0;throw ${safeExitSignal}}};globalThis.process=process;globalThis.queueMicrotask=globalThis.queueMicrotask|| (fn=>Promise.resolve().then(fn));
})();`;
}

function readExitCode(vm: QuickJSContext): number {
  const result = vm.evalCode("Number.isInteger(process.exitCode) ? process.exitCode : 0", "runtime:exit-code");
  if (result.error) { result.error.dispose(); return 1; }
  const value = vm.getNumber(result.value);
  result.value.dispose();
  return clamp(Math.trunc(value), 0, 255);
}

function failedResult(error: unknown, interrupted: boolean, timeoutMs: number, stdout: string[], stderr: string[]): QuickJsExecutionResult {
  const message = formatError(error);
  const memoryError = /out of memory|allocation failed/i.test(message);
  return { exitCode: interrupted ? 124 : 1, stdout: stdout.join(""), stderr: interrupted ? `${stderr.join("")}执行超时（${timeoutMs}ms）\n` : `${stderr.join("")}${message}\n`, ...(interrupted ? { errorCode: "TIMEOUT" as const } : memoryError ? { errorCode: "MEMORY_LIMIT" as const } : { errorCode: "EXECUTION" as const }) };
}

function formatConsoleValue(value: unknown): string { if (typeof value === "string") return value; if (typeof value === "undefined") return "undefined"; if (typeof value === "bigint") return `${value}n`; if (value instanceof Error) return value.stack ?? value.message; try { return JSON.stringify(value); } catch { return String(value); } }
function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack?.includes(error.message) ? error.stack : `${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === "string" ? `${record.name}: ` : "";
    const message = typeof record.message === "string" ? `${name}${record.message}` : JSON.stringify(record);
    return typeof record.stack === "string" && record.stack.includes(message) ? record.stack : `${message}${typeof record.stack === "string" ? `\n${record.stack}` : ""}`;
  }
  return String(error);
}
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
