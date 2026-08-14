import { displayVirtualPath, joinVirtualPath, resolveVirtualPath } from "./paths";
import { VirtualModuleBundler } from "./bundler/module-bundler";
import { VirtualPackageManager, type LockedPackage } from "./packages/package-manager";
import { QuickJsWorkerExecutor } from "./quickjs/worker-client";
import type { QuickJsExecutionOptions, QuickJsExecutionResult } from "./quickjs/types";
import { bytesText, shellResult, type ShellCommandContext, type ShellCommandHandler, type ShellProcessResult, type VirtualFileSystem } from "./types";

export interface JavaScriptExecutor { execute(options: QuickJsExecutionOptions, signal?: AbortSignal): Promise<QuickJsExecutionResult>; }

export class VirtualRuntimeCommands {
  readonly handlers: Record<string, ShellCommandHandler>;
  private readonly bundler: VirtualModuleBundler;

  constructor(
    private readonly fs: VirtualFileSystem,
    private readonly packages = new VirtualPackageManager(fs),
    private readonly executor: JavaScriptExecutor = new QuickJsWorkerExecutor()
  ) {
    this.bundler = new VirtualModuleBundler(fs, () => packages.readLock());
    this.handlers = {
      node: (context) => this.node(context),
      npm: (context) => this.npm(context),
      npx: (context) => this.npx(context)
    };
  }

  async executeJavaScript(source: string, cwd: string, env: ReadonlyMap<string, string>, timeoutMs: number, signal?: AbortSignal): Promise<ShellProcessResult> {
    const bundled = await this.bundler.bundleSource(source, cwd);
    const result = await this.executor.execute({ source: bundled.code, env: Object.fromEntries(env), timeoutMs, filename: "/workspace/.browser-agent/bundle.js" }, signal);
    return shellResult(result.exitCode, result.stdout, `${bundled.warnings.map((warning) => `warning: ${warning}\n`).join("")}${result.stderr}`);
  }

  private async node(context: ShellCommandContext): Promise<ShellProcessResult> {
    const args = [...context.args];
    if (args[0] === "--version" || args[0] === "-v") return shellResult(0, "v22.0.0-browser\n");
    let bundled;
    let scriptArgs: string[];
    if (args[0] === "-e" || args[0] === "--eval" || args[0] === "-p" || args[0] === "--print") {
      const mode = args.shift()!;
      const source = args.shift();
      if (source === undefined) return shellResult(9, "", `node: ${mode} 需要 JavaScript 参数\n`);
      bundled = await this.bundler.bundleSource(mode === "-p" || mode === "--print" ? `console.log(${source})` : source, context.cwd);
      scriptArgs = args;
    } else if (!args.length) {
      bundled = await this.bundler.bundleSource(bytesText(context.stdin), context.cwd);
      scriptArgs = [];
    } else {
      const entry = resolveVirtualPath(args.shift()!, context.cwd);
      bundled = await this.bundler.bundleEntry(entry);
      scriptArgs = args;
    }
    const result = await this.executor.execute({
      source: bundled.code,
      args: scriptArgs,
      env: Object.fromEntries(context.env),
      timeoutMs: context.timeoutMs ?? 10_000,
      filename: "/workspace/.browser-agent/bundle.js"
    }, context.signal);
    return shellResult(result.exitCode, result.stdout, `${bundled.warnings.map((warning) => `warning: ${warning}\n`).join("")}${result.stderr}`);
  }

  private async npm(context: ShellCommandContext): Promise<ShellProcessResult> {
    if (!context.args.length || ["--version", "-v"].includes(context.args[0]!)) return shellResult(0, "11.7.0-browser\n");
    const [operation, ...rawArgs] = context.args;
    if (!["install", "i", "add"].includes(operation!)) return shellResult(1, "", `npm: 虚拟运行时暂不支持 ${operation}\n支持：install、i、add、--version\n`);
    if (rawArgs.some((arg) => ["-g", "--global"].includes(arg))) return shellResult(1, "", "npm: 浏览器虚拟环境不支持全局安装\n");
    const noSave = rawArgs.includes("--no-save");
    const saveDev = rawArgs.includes("--save-dev") || rawArgs.includes("-D");
    const specs = rawArgs.filter((arg) => !arg.startsWith("-"));
    const requested = specs.length ? specs : await this.packageJsonDependencies();
    if (!requested.length) return shellResult(0, "up to date\n");
    const progress: string[] = [];
    try {
      const result = await this.packages.install(requested, {
        save: specs.length > 0 && !noSave,
        dependencySection: saveDev ? "devDependencies" : "dependencies",
        ...(context.signal ? { signal: context.signal } : {}),
        onProgress: (message) => progress.push(message)
      });
      const warnings = result.warnings.map((warning) => `npm WARN ${warning}\n`).join("");
      return shellResult(0, `${progress.join("\n")}\n`, warnings);
    } catch (error) { return shellResult(1, `${progress.join("\n")}${progress.length ? "\n" : ""}`, `npm ERR! ${errorMessage(error)}\n`); }
  }

  private async npx(context: ShellCommandContext): Promise<ShellProcessResult> {
    const [command, ...args] = context.args;
    if (!command) return shellResult(1, "", "npx: 缺少命令\n");
    const lock = await this.packages.readLock();
    const packageId = lock?.roots[command];
    let locked = packageId ? lock?.packages[packageId] : undefined;
    if (!locked) {
      const installed = await this.packages.install([command], { save: false, ...(context.signal ? { signal: context.signal } : {}) });
      const id = installed.lock.roots[command];
      locked = id ? installed.lock.packages[id] : undefined;
    }
    if (!locked) return shellResult(1, "", `npx: 无法解析 ${command}\n`);
    const bin = await this.packageBin(locked, command);
    if (!bin) return shellResult(1, "", `npx: ${command} 没有可执行入口\n`);
    return this.node({ ...context, args: [displayVirtualPath(joinVirtualPath(locked.storePath, bin)), ...args] });
  }

  private async packageJsonDependencies(): Promise<string[]> {
    if (!await this.fs.exists("/package.json")) return [];
    const manifest = JSON.parse(bytesText(await this.fs.readFile("/package.json"))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).map(([name, range]) => `${name}@${range}`);
  }

  private async packageBin(locked: LockedPackage, command: string): Promise<string | undefined> {
    const manifest = JSON.parse(bytesText(await this.fs.readFile(joinVirtualPath(locked.storePath, "package.json")))) as { bin?: string | Record<string, string> };
    if (typeof manifest.bin === "string") return manifest.bin;
    return manifest.bin?.[command] ?? (manifest.bin ? Object.values(manifest.bin)[0] : undefined);
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
