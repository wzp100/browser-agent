import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSContext } from "quickjs-emscripten-core";
import type { QuickJsExecutionOptions, QuickJsExecutionResult } from "./types";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MEMORY_LIMIT = 64 * 1024 * 1024;
const DEFAULT_STACK_LIMIT = 1 * 1024 * 1024;
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
  const QuickJS = await quickJsModule;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryLimitBytes);
  runtime.setMaxStackSize(maxStackBytes);
  runtime.setInterruptHandler(() => {
    interrupted = Date.now() >= deadline;
    return interrupted;
  });
  const vm = runtime.newContext();

  try {
    installConsole(vm, stdout, stderr);
    const result = vm.evalCode(`${createPrelude(options.args ?? [], options.env ?? {})}\n${options.source}`, options.filename ?? "/workspace/index.js", { type: "global" });
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      return failedResult(error, interrupted, timeoutMs, stdout, stderr);
    }
    result.value.dispose();
    return { exitCode: readExitCode(vm), stdout: stdout.join(""), stderr: stderr.join("") };
  } catch (error) {
    return failedResult(error, interrupted, timeoutMs, stdout, stderr);
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

function installConsole(vm: QuickJSContext, stdout: string[], stderr: string[]): void {
  const consoleHandle = vm.newObject();
  for (const [name, target] of [["log", stdout], ["info", stdout], ["warn", stderr], ["error", stderr]] as const) {
    const fn = vm.newFunction(name, (...args) => {
      target.push(`${args.map((argument) => formatConsoleValue(vm.dump(argument))).join(" ")}\n`);
    });
    vm.setProp(consoleHandle, name, fn);
    fn.dispose();
  }
  vm.setProp(vm.global, "console", consoleHandle);
  consoleHandle.dispose();
}

function createPrelude(args: string[], env: Record<string, string>): string {
  const safeArgs = JSON.stringify(["browser-node", "/workspace/index.js", ...args]);
  const safeEnv = JSON.stringify(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])));
  return `globalThis.global = globalThis;
globalThis.process = Object.seal({
  argv: Object.freeze(${safeArgs}), env: Object.freeze(${safeEnv}),
  cwd: () => "/workspace", platform: "browser", browser: true,
  version: "v22.0.0-browser", versions: Object.freeze({ node: "22.0.0-browser", quickjs: "2025-09-13" }),
  exitCode: 0
});`;
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
  return {
    exitCode: interrupted ? 124 : 1,
    stdout: stdout.join(""),
    stderr: `${stderr.join("")}${interrupted ? `执行超时（${timeoutMs}ms）` : message}\n`,
    errorCode: interrupted ? "TIMEOUT" : memoryError ? "MEMORY_LIMIT" : "EXECUTION"
  };
}

function formatConsoleValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Error) return value.stack ?? value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const name = typeof record.name === "string" ? `${record.name}: ` : "";
    const message = typeof record.message === "string" ? record.message : JSON.stringify(record);
    return typeof record.stack === "string" ? record.stack : `${name}${message}`;
  }
  return String(error);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
