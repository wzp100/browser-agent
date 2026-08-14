import { displayVirtualPath, joinVirtualPath, resolveVirtualPath } from "../paths";
import { bytesText, EMPTY_BYTES, shellResult, textBytes, type ShellCommandHandler, type ShellProcessResult, type VirtualFileSystem } from "../types";
import type { ShellCommandNode, ShellPipelineNode, ShellRedirection, ShellWord } from "./ast";
import { createBuiltinCommands } from "./builtins";
import { parseShell } from "./parser";

export interface VirtualShellHooks {
  commands?: Record<string, ShellCommandHandler>;
}

export interface VirtualShellExecutionOptions { signal?: AbortSignal; stdin?: Uint8Array; timeoutMs?: number; }

export class VirtualShell {
  private cwd = "/";
  private readonly env = new Map<string, string>([["HOME", "/workspace"], ["PWD", "/workspace"], ["PATH", "/virtual/bin"], ["SHELL", "/virtual/bin/bash"]]);
  private readonly commands: Map<string, ShellCommandHandler>;
  private lastExitCode = 0;

  constructor(private readonly fs: VirtualFileSystem, hooks: VirtualShellHooks = {}) {
    const external = new Map(Object.entries(hooks.commands ?? {}));
    this.commands = createBuiltinCommands(fs, () => [...external.keys()]);
    for (const [name, handler] of external) this.commands.set(name, handler);
  }

  get workingDirectory(): string { return this.cwd; }
  environment(): ReadonlyMap<string, string> { return new Map(this.env); }

  async execute(source: string, options: VirtualShellExecutionOptions = {}): Promise<ShellProcessResult> {
    options.signal?.throwIfAborted();
    const program = parseShell(source);
    let result = shellResult(0, "", "");
    let stdin = options.stdin ?? EMPTY_BYTES;
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    for (const chain of program.chains) {
      for (let index = 0; index < chain.pipelines.length; index += 1) {
        const operator = chain.operators[index - 1];
        if (operator === "&&" && result.exitCode !== 0) continue;
        if (operator === "||" && result.exitCode === 0) continue;
        result = await this.executePipeline(chain.pipelines[index]!, stdin, options.signal, options.timeoutMs);
        this.lastExitCode = result.exitCode;
        stdout.push(result.stdout);
        stderr.push(result.stderr);
        stdin = EMPTY_BYTES;
      }
    }
    return { exitCode: result.exitCode, stdout: concatBytes(stdout), stderr: concatBytes(stderr) };
  }

  private async executePipeline(pipeline: ShellPipelineNode, initialStdin: Uint8Array, signal?: AbortSignal, timeoutMs?: number): Promise<ShellProcessResult> {
    let stdin = initialStdin;
    let result = shellResult();
    const stderr: Uint8Array[] = [];
    for (const command of pipeline.commands) {
      signal?.throwIfAborted();
      result = await this.executeCommand(command, stdin, signal, timeoutMs);
      stdin = result.stdout;
      stderr.push(result.stderr);
    }
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: concatBytes(stderr) };
  }

  private async executeCommand(node: ShellCommandNode, pipelineInput: Uint8Array, signal?: AbortSignal, timeoutMs?: number): Promise<ShellProcessResult> {
    const expandedWords: string[] = [];
    for (const word of node.words) expandedWords.push(...await this.expandWord(word));
    const assignments = new Map<string, string>();
    while (expandedWords.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(expandedWords[0]!)) {
      const assignment = expandedWords.shift()!;
      const equals = assignment.indexOf("=");
      assignments.set(assignment.slice(0, equals), assignment.slice(equals + 1));
    }
    if (!expandedWords.length) {
      for (const [name, value] of assignments) this.env.set(name, value);
      return shellResult();
    }

    let stdin = pipelineInput;
    for (const redirect of node.redirects) {
      if (redirect.operator !== "<") continue;
      const target = await this.redirectTarget(redirect);
      try { stdin = await this.fs.readFile(resolveVirtualPath(target, this.cwd)); }
      catch (error) { return shellResult(1, "", `${expandedWords[0]}: ${target}: ${errorMessage(error)}\n`); }
    }

    const command = expandedWords.shift()!;
    const commandEnv = new Map(this.env);
    for (const [name, value] of assignments) commandEnv.set(name, value);
    let result: ShellProcessResult;
    if (command === "cd") result = await this.changeDirectory(expandedWords);
    else if (command === "export") result = this.exportVariables(expandedWords);
    else if (command === "unset") result = this.unsetVariables(expandedWords);
    else {
      const handler = this.commands.get(command);
      result = handler
        ? await handler({ args: expandedWords, cwd: this.cwd, env: commandEnv, stdin, ...(signal ? { signal } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }) })
        : shellResult(127, "", `${command}: command not found\n`);
    }
    return this.applyOutputRedirects(node.redirects, result);
  }

  private async changeDirectory(args: string[]): Promise<ShellProcessResult> {
    if (args.length > 1) return shellResult(2, "", "cd: 参数过多\n");
    const target = args[0] ?? this.env.get("HOME") ?? "/workspace";
    try {
      const path = resolveVirtualPath(target, this.cwd);
      if ((await this.fs.stat(path)).kind !== "directory") return shellResult(1, "", `cd: ${target}: 不是目录\n`);
      this.cwd = path;
      this.env.set("PWD", displayVirtualPath(path));
      return shellResult();
    } catch (error) { return shellResult(1, "", `cd: ${target}: ${errorMessage(error)}\n`); }
  }

  private exportVariables(args: string[]): ShellProcessResult {
    if (!args.length) return shellResult(0, `${[...this.env].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `declare -x ${key}="${value.replace(/"/g, '\\"')}"`).join("\n")}\n`);
    for (const argument of args) {
      const match = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/);
      if (!match) return shellResult(2, "", `export: ${argument}: 无效变量名\n`);
      this.env.set(match[1]!, match[2] ?? this.env.get(match[1]!) ?? "");
    }
    return shellResult();
  }

  private unsetVariables(args: string[]): ShellProcessResult {
    for (const name of args) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return shellResult(2, "", `unset: ${name}: 无效变量名\n`);
      this.env.delete(name);
    }
    return shellResult();
  }

  private async applyOutputRedirects(redirects: ShellRedirection[], source: ShellProcessResult): Promise<ShellProcessResult> {
    let stdout = source.stdout;
    let stderr = source.stderr;
    for (const redirect of redirects) {
      if (redirect.operator === "<") continue;
      if (redirect.operator === "2>&1") { stdout = concatBytes([stdout, stderr]); stderr = EMPTY_BYTES; continue; }
      const target = resolveVirtualPath(await this.redirectTarget(redirect), this.cwd);
      const errorStream = redirect.operator === "2>" || redirect.operator === "2>>";
      const data = errorStream ? stderr : stdout;
      await this.fs.writeFile(target, data, { append: redirect.operator === ">>" || redirect.operator === "2>>" });
      if (errorStream) stderr = EMPTY_BYTES; else stdout = EMPTY_BYTES;
    }
    return { exitCode: source.exitCode, stdout, stderr };
  }

  private async redirectTarget(redirect: ShellRedirection): Promise<string> {
    if (!redirect.target) throw new Error(`${redirect.operator} 缺少重定向目标。`);
    const values = await this.expandWord(redirect.target, false);
    if (values.length !== 1) throw new Error(`${redirect.operator} 的目标必须唯一。`);
    return values[0]!;
  }

  private async expandWord(word: ShellWord, allowGlob = true): Promise<string[]> {
    let value = "";
    let glob = false;
    for (const part of word.parts) {
      const expanded = part.kind === "literal" ? part.value : part.kind === "status" ? String(this.lastExitCode) : this.env.get(part.value) ?? "";
      value += expanded;
      if (!part.quoted && /[*?]/.test(expanded)) glob = true;
    }
    if (!allowGlob || !glob) return [value];
    const matches = await this.expandGlob(value);
    return matches.length ? matches : [value];
  }

  private async expandGlob(pattern: string): Promise<string[]> {
    const normalized = pattern.replace(/\\/g, "/");
    let current: string[];
    let segments: string[];
    if (normalized === "/workspace" || normalized.startsWith("/workspace/")) {
      current = ["/"];
      segments = normalized.slice("/workspace".length).split("/").filter(Boolean);
    } else if (normalized.startsWith("/")) {
      resolveVirtualPath(normalized, this.cwd);
      return [];
    } else {
      current = [this.cwd];
      segments = normalized.split("/").filter(Boolean);
    }
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]!;
      const next: string[] = [];
      if (!/[*?]/.test(segment)) {
        for (const base of current) {
          try { const candidate = resolveVirtualPath(segment, base); if (await this.fs.exists(candidate)) next.push(candidate); } catch { /* no match */ }
        }
      } else {
        const matcher = globRegex(segment);
        for (const base of current) {
          try {
            for (const entry of await this.fs.list(base)) {
              if (entry.name.startsWith(".") && !segment.startsWith(".")) continue;
              if (matcher.test(entry.name) && (index === segments.length - 1 || entry.kind === "directory")) next.push(entry.path);
            }
          } catch { /* no match */ }
        }
      }
      current = next;
      if (!current.length) break;
    }
    return current.map(displayVirtualPath).sort();
  }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function globRegex(pattern: string): RegExp { return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "u"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
