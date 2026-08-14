import type { InteractiveRuntimeSession, RuntimeSession, ScriptExecutionRequest, ScriptExecutionResult, ScriptRuntimeProvider, TerminalDimensions } from "../../runtime-contracts/src/index";
import { VirtualPackageManager } from "./packages/package-manager";
import { VirtualRuntimeCommands, type JavaScriptExecutor } from "./runtime-commands";
import { VirtualShell } from "./shell/shell";
import { bytesText, type VirtualFileSystem } from "./types";

interface SessionState { session: RuntimeSession; shell: VirtualShell; controllers: Set<AbortController>; }

export interface VirtualRuntimeProviderOptions {
  executor?: JavaScriptExecutor;
  packageManager?: VirtualPackageManager;
}

export class VirtualRuntimeProvider implements ScriptRuntimeProvider {
  readonly id = "browser-agent-virtual";
  private readonly sessions = new Map<string, SessionState>();
  private readonly commands: VirtualRuntimeCommands;

  constructor(private readonly fs: VirtualFileSystem, options: VirtualRuntimeProviderOptions = {}) {
    this.commands = new VirtualRuntimeCommands(fs, options.packageManager ?? new VirtualPackageManager(fs), options.executor);
  }

  async available(): Promise<boolean> { return typeof WebAssembly === "object" && typeof Worker === "function"; }

  async start(): Promise<RuntimeSession> {
    const existing = this.sessions.values().next().value as SessionState | undefined;
    if (existing) return existing.session;
    const session: RuntimeSession = { id: crypto.randomUUID(), workingDirectory: ".", runtimeCommandsUseRelativePaths: true };
    this.sessions.set(session.id, { session, shell: this.createShell(), controllers: new Set() });
    return session;
  }

  async execute(session: RuntimeSession, request: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    const state = this.sessions.get(session.id);
    if (!state) throw new Error("虚拟运行时会话不存在或已终止");
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", forwardAbort, { once: true });
    state.controllers.add(controller);
    const timeoutMs = Math.min(60_000, Math.max(1, request.timeoutMs ?? 10_000));
    const timer = setTimeout(() => controller.abort(new Error(`执行超时（${timeoutMs}ms）`)), timeoutMs + 300);
    try {
      const result = request.kind === "javascript"
        ? await this.commands.executeJavaScript(request.source, state.shell.workingDirectory, state.shell.environment(), timeoutMs, controller.signal)
        : await state.shell.execute(request.source, { signal: controller.signal, timeoutMs });
      return { exitCode: result.exitCode, stdout: bytesText(result.stdout), stderr: bytesText(result.stderr) };
    } catch (error) {
      if (controller.signal.aborted) return { exitCode: 130, stdout: "", stderr: `${errorMessage(controller.signal.reason ?? error)}\n` };
      throw error;
    } finally {
      clearTimeout(timer);
      state.controllers.delete(controller);
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async startInteractive(onOutput: (data: string) => void, _dimensions: TerminalDimensions): Promise<InteractiveRuntimeSession> {
    const session = await this.start();
    const state = this.sessions.get(session.id)!;
    const terminal = new VirtualInteractiveTerminal(state, onOutput);
    terminal.start();
    return {
      ...session,
      write: (data) => terminal.write(data),
      resize: () => undefined,
      kill: () => terminal.kill()
    };
  }

  async terminate(session: RuntimeSession): Promise<void> {
    const state = this.sessions.get(session.id);
    if (!state) return;
    for (const controller of state.controllers) controller.abort(new Error("会话已终止"));
    this.sessions.delete(session.id);
  }

  limitations(): string[] {
    return ["仅支持纯 JavaScript/TypeScript npm 包", "不支持原生扩展、生命周期脚本、Docker、Python 或宿主二进制", "Node 内置模块目前提供有限兼容层"];
  }

  private createShell(): VirtualShell { return new VirtualShell(this.fs, { commands: this.commands.handlers }); }
}

class VirtualInteractiveTerminal {
  private line = "";
  private history: string[] = [];
  private historyIndex = 0;
  private active: AbortController | undefined;
  private queue = Promise.resolve();
  private alive = true;

  constructor(private readonly state: SessionState, private readonly output: (data: string) => void) {}

  start(): void {
    this.output("\x1b[1;36mBrowser Agent Virtual Runtime\x1b[0m\r\n无需容器或 API Key；输入 help 查看命令。\r\n");
    this.prompt();
  }

  async write(data: string): Promise<void> {
    if (!this.alive) return;
    for (let index = 0; index < data.length; index += 1) {
      if (data.startsWith("\x1b[A", index)) { this.recall(-1); index += 2; continue; }
      if (data.startsWith("\x1b[B", index)) { this.recall(1); index += 2; continue; }
      const character = data[index]!;
      if (character === "\r" || character === "\n") {
        if (character === "\n" && data[index - 1] === "\r") continue;
        const command = this.line;
        this.line = "";
        this.output("\r\n");
        if (command.trim()) { this.history.push(command); this.historyIndex = this.history.length; }
        this.queue = this.queue.then(() => this.run(command));
      } else if (character === "\x03") {
        this.active?.abort(new Error("用户取消"));
        this.line = "";
        this.output("^C\r\n");
        if (!this.active) this.prompt();
      } else if (character === "\x0c") {
        this.output("\x1b[2J\x1b[H"); this.prompt(); this.output(this.line);
      } else if (character === "\x7f" || character === "\b") {
        if (this.line) { this.line = this.line.slice(0, -1); this.output("\b \b"); }
      } else if (character >= " " && character !== "\x7f") {
        this.line += character; this.output(character);
      }
    }
    await this.queue;
  }

  kill(): void { this.alive = false; this.active?.abort(new Error("终端已关闭")); }

  private async run(command: string): Promise<void> {
    if (!this.alive) return;
    if (!command.trim()) { this.prompt(); return; }
    this.active = new AbortController();
    try {
      const result = await this.state.shell.execute(command, { signal: this.active.signal, timeoutMs: 60_000 });
      if (result.stdout.byteLength) this.output(terminalLines(bytesText(result.stdout)));
      if (result.stderr.byteLength) this.output(`\x1b[31m${terminalLines(bytesText(result.stderr))}\x1b[0m`);
    } catch (error) {
      this.output(`\x1b[31m${terminalLines(errorMessage(error))}\x1b[0m\r\n`);
    } finally {
      this.active = undefined;
      if (this.alive) this.prompt();
    }
  }

  private recall(direction: -1 | 1): void {
    if (!this.history.length) return;
    this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
    const next = this.history[this.historyIndex] ?? "";
    this.output(`\r\x1b[2K${this.promptText()}${next}`);
    this.line = next;
  }

  private prompt(): void { this.output(this.promptText()); }
  private promptText(): string { return `\x1b[32mvirtual:${this.state.shell.environment().get("PWD") ?? "/workspace"}$\x1b[0m `; }
}

function terminalLines(value: string): string { return value.replace(/\r?\n/g, "\r\n"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
