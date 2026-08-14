import { displayVirtualPath, joinVirtualPath, resolveVirtualPath, virtualBasename } from "../paths";
import { bytesText, EMPTY_BYTES, shellResult, textBytes, type ShellCommandContext, type ShellCommandHandler, type ShellProcessResult, type VirtualFileSystem } from "../types";

export const BUILTIN_NAMES = [
  "cat", "clear", "cp", "echo", "env", "false", "find", "grep", "head", "help", "ls", "mkdir", "mv", "printf", "pwd", "rm", "sleep", "sort", "tail", "touch", "true", "uniq", "wc", "which"
] as const;

export function createBuiltinCommands(fs: VirtualFileSystem, externalNames: () => readonly string[]): Map<string, ShellCommandHandler> {
  const commands = new Map<string, ShellCommandHandler>();
  commands.set("true", async () => shellResult());
  commands.set("false", async () => shellResult(1));
  commands.set("pwd", async ({ cwd }) => shellResult(0, `${displayVirtualPath(cwd)}\n`));
  commands.set("clear", async () => shellResult(0, "\x1b[2J\x1b[H"));
  commands.set("echo", async ({ args }) => {
    const noNewline = args[0] === "-n";
    return shellResult(0, `${(noNewline ? args.slice(1) : args).join(" ")}${noNewline ? "" : "\n"}`);
  });
  commands.set("printf", async ({ args }) => {
    if (!args.length) return shellResult();
    let argument = 1;
    const formatted = decodeEscapes(args[0]!).replace(/%([%sd])/g, (_all, type: string) => {
      if (type === "%") return "%";
      const value = args[argument++] ?? "";
      return type === "d" ? String(Number.parseInt(value, 10) || 0) : value;
    });
    return shellResult(0, formatted);
  });
  commands.set("env", async ({ env }) => shellResult(0, `${[...env].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n")}\n`));
  commands.set("which", async ({ args }) => {
    const names = new Set([...BUILTIN_NAMES, ...externalNames(), "cd", "export", "unset"]);
    const missing = args.filter((name) => !names.has(name as never));
    const found = args.filter((name) => names.has(name as never)).map((name) => `/virtual/bin/${name}`).join("\n");
    return shellResult(missing.length ? 1 : 0, found ? `${found}\n` : "", missing.map((name) => `which: no ${name} in virtual PATH`).join("\n") + (missing.length ? "\n" : ""));
  });
  commands.set("help", async () => shellResult(0, `Browser Agent Virtual Shell\n内置命令：${[...BUILTIN_NAMES, ...externalNames(), "cd", "export", "unset"].sort().join(", ")}\n`));
  commands.set("sleep", async ({ args, signal }) => {
    const seconds = Number(args[0] ?? "1");
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) return shellResult(2, "", "sleep: 时间必须在 0 到 600 秒之间\n");
    await abortableDelay(seconds * 1_000, signal);
    return shellResult();
  });
  commands.set("ls", async (context) => listCommand(fs, context));
  commands.set("cat", async (context) => catCommand(fs, context));
  commands.set("mkdir", async (context) => mkdirCommand(fs, context));
  commands.set("touch", async (context) => touchCommand(fs, context));
  commands.set("rm", async (context) => removeCommand(fs, context));
  commands.set("cp", async (context) => copyCommand(fs, context));
  commands.set("mv", async (context) => moveCommand(fs, context));
  commands.set("head", async (context) => headTailCommand(fs, context, false));
  commands.set("tail", async (context) => headTailCommand(fs, context, true));
  commands.set("wc", async (context) => wcCommand(fs, context));
  commands.set("grep", async (context) => grepCommand(fs, context));
  commands.set("find", async (context) => findCommand(fs, context));
  commands.set("sort", async (context) => sortCommand(context));
  commands.set("uniq", async (context) => uniqCommand(context));
  return commands;
}

async function listCommand(fs: VirtualFileSystem, { args, cwd }: ShellCommandContext): Promise<ShellProcessResult> {
  const long = args.includes("-l") || args.includes("-la") || args.includes("-al");
  const targets = args.filter((arg) => !arg.startsWith("-"));
  const paths = targets.length ? targets : ["."];
  const lines: string[] = [];
  for (const target of paths) {
    const path = resolveVirtualPath(target, cwd);
    try {
      const stat = await fs.stat(path);
      if (stat.kind === "file") { lines.push(long ? fileListLine(virtualBasename(path), stat.size, false) : virtualBasename(path)); continue; }
      const entries = await fs.list(path);
      if (paths.length > 1) lines.push(`${displayVirtualPath(path)}:`);
      lines.push(...entries.map((entry) => long ? fileListLine(entry.name, entry.size, entry.kind === "directory") : entry.name));
    } catch (error) { return shellResult(1, lines.length ? `${lines.join("\n")}\n` : "", `ls: ${errorMessage(error)}\n`); }
  }
  return shellResult(0, lines.length ? `${lines.join("\n")}\n` : "");
}

async function catCommand(fs: VirtualFileSystem, { args, cwd, stdin }: ShellCommandContext): Promise<ShellProcessResult> {
  if (!args.length) return { exitCode: 0, stdout: stdin.slice(), stderr: EMPTY_BYTES };
  const chunks: Uint8Array[] = [];
  for (const argument of args) {
    try { chunks.push(argument === "-" ? stdin : await fs.readFile(resolveVirtualPath(argument, cwd))); }
    catch (error) { return { exitCode: 1, stdout: concatBytes(chunks), stderr: textBytes(`cat: ${argument}: ${errorMessage(error)}\n`) }; }
  }
  return { exitCode: 0, stdout: concatBytes(chunks), stderr: EMPTY_BYTES };
}

async function mkdirCommand(fs: VirtualFileSystem, { args, cwd }: ShellCommandContext): Promise<ShellProcessResult> {
  const recursive = args.includes("-p");
  const paths = args.filter((arg) => arg !== "-p");
  if (!paths.length) return shellResult(2, "", "mkdir: 缺少操作数\n");
  try { for (const path of paths) await fs.mkdir(resolveVirtualPath(path, cwd), { recursive }); }
  catch (error) { return shellResult(1, "", `mkdir: ${errorMessage(error)}\n`); }
  return shellResult();
}

async function touchCommand(fs: VirtualFileSystem, { args, cwd }: ShellCommandContext): Promise<ShellProcessResult> {
  if (!args.length) return shellResult(2, "", "touch: 缺少文件操作数\n");
  try {
    for (const argument of args) {
      const path = resolveVirtualPath(argument, cwd);
      const content = await fs.exists(path) ? await fs.readFile(path) : EMPTY_BYTES;
      await fs.writeFile(path, content);
    }
  } catch (error) { return shellResult(1, "", `touch: ${errorMessage(error)}\n`); }
  return shellResult();
}

async function removeCommand(fs: VirtualFileSystem, { args, cwd }: ShellCommandContext): Promise<ShellProcessResult> {
  const recursive = args.some((arg) => ["-r", "-R", "-rf", "-fr", "-Rf", "-fR"].includes(arg));
  const force = args.some((arg) => ["-f", "-rf", "-fr", "-Rf", "-fR"].includes(arg));
  const paths = args.filter((arg) => !arg.startsWith("-"));
  if (!paths.length) return shellResult(2, "", "rm: 缺少操作数\n");
  try { for (const path of paths) await fs.remove(resolveVirtualPath(path, cwd), { recursive, force }); }
  catch (error) { return shellResult(1, "", `rm: ${errorMessage(error)}\n`); }
  return shellResult();
}

async function copyCommand(fs: VirtualFileSystem, { args, cwd }: ShellCommandContext): Promise<ShellProcessResult> {
  const recursive = args.includes("-r") || args.includes("-R");
  const paths = args.filter((arg) => !arg.startsWith("-"));
  if (paths.length !== 2) return shellResult(2, "", "cp: 需要源路径和目标路径\n");
  const source = resolveVirtualPath(paths[0]!, cwd);
  let target = resolveVirtualPath(paths[1]!, cwd);
  try {
    if (await fs.exists(target) && (await fs.stat(target)).kind === "directory") target = joinVirtualPath(target, virtualBasename(source));
    await copyPath(fs, source, target, recursive);
  } catch (error) { return shellResult(1, "", `cp: ${errorMessage(error)}\n`); }
  return shellResult();
}

async function moveCommand(fs: VirtualFileSystem, { args, cwd }: ShellCommandContext): Promise<ShellProcessResult> {
  if (args.length !== 2) return shellResult(2, "", "mv: 需要源路径和目标路径\n");
  const source = resolveVirtualPath(args[0]!, cwd);
  let target = resolveVirtualPath(args[1]!, cwd);
  try {
    if (await fs.exists(target) && (await fs.stat(target)).kind === "directory") target = joinVirtualPath(target, virtualBasename(source));
    await fs.rename(source, target);
  } catch (error) { return shellResult(1, "", `mv: ${errorMessage(error)}\n`); }
  return shellResult();
}

async function headTailCommand(fs: VirtualFileSystem, context: ShellCommandContext, tail: boolean): Promise<ShellProcessResult> {
  const parsed = numericOption(context.args, "-n", 10);
  if (parsed.error) return shellResult(2, "", `${tail ? "tail" : "head"}: ${parsed.error}\n`);
  const content = await inputText(fs, parsed.rest, context.cwd, context.stdin);
  if ("error" in content) return shellResult(1, "", `${tail ? "tail" : "head"}: ${content.error}\n`);
  const lines = content.value.split(/(?<=\n)/);
  return shellResult(0, (tail ? lines.slice(-parsed.value) : lines.slice(0, parsed.value)).join(""));
}

async function wcCommand(fs: VirtualFileSystem, context: ShellCommandContext): Promise<ShellProcessResult> {
  const flags = context.args.filter((arg) => /^-[lwc]+$/.test(arg));
  const paths = context.args.filter((arg) => !/^-[lwc]+$/.test(arg));
  const content = await inputText(fs, paths, context.cwd, context.stdin);
  if ("error" in content) return shellResult(1, "", `wc: ${content.error}\n`);
  const selected = flags.join("") || "-lwc";
  const fields: number[] = [];
  if (selected.includes("l")) fields.push((content.value.match(/\n/g) ?? []).length);
  if (selected.includes("w")) fields.push(content.value.trim() ? content.value.trim().split(/\s+/).length : 0);
  if (selected.includes("c")) fields.push(textBytes(content.value).byteLength);
  return shellResult(0, `${fields.join(" ")}\n`);
}

async function grepCommand(fs: VirtualFileSystem, context: ShellCommandContext): Promise<ShellProcessResult> {
  const ignoreCase = context.args.includes("-i");
  const lineNumber = context.args.includes("-n");
  const invert = context.args.includes("-v");
  const args = context.args.filter((arg) => !["-i", "-n", "-v"].includes(arg));
  const pattern = args.shift();
  if (pattern === undefined) return shellResult(2, "", "grep: 缺少搜索模式\n");
  const content = await inputText(fs, args, context.cwd, context.stdin);
  if ("error" in content) return shellResult(2, "", `grep: ${content.error}\n`);
  const needle = ignoreCase ? pattern.toLocaleLowerCase() : pattern;
  const matches = content.value.split(/\r?\n/).flatMap((line, index) => {
    const matched = (ignoreCase ? line.toLocaleLowerCase() : line).includes(needle);
    return matched !== invert ? [`${lineNumber ? `${index + 1}:` : ""}${line}`] : [];
  });
  return shellResult(matches.length ? 0 : 1, matches.length ? `${matches.join("\n")}\n` : "");
}

async function findCommand(fs: VirtualFileSystem, { args, cwd }: ShellCommandContext): Promise<ShellProcessResult> {
  const rootArgument = args[0] && args[0] !== "-name" ? args[0] : ".";
  const nameIndex = args.indexOf("-name");
  const pattern = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
  if (nameIndex >= 0 && !pattern) return shellResult(2, "", "find: -name 缺少模式\n");
  try {
    const root = resolveVirtualPath(rootArgument!, cwd);
    const paths: string[] = [];
    await walk(fs, root, paths);
    const matcher = pattern ? globRegex(pattern) : undefined;
    const selected = paths.filter((path) => !matcher || matcher.test(virtualBasename(path))).map(displayVirtualPath);
    return shellResult(0, selected.length ? `${selected.join("\n")}\n` : "");
  } catch (error) { return shellResult(1, "", `find: ${errorMessage(error)}\n`); }
}

async function sortCommand({ args, stdin }: ShellCommandContext): Promise<ShellProcessResult> {
  if (args.some((arg) => !["-r"].includes(arg))) return shellResult(2, "", "sort: 当前只支持标准输入和 -r\n");
  const trailing = bytesText(stdin).endsWith("\n");
  const lines = bytesText(stdin).replace(/\n$/, "").split("\n").sort((a, b) => a.localeCompare(b));
  if (args.includes("-r")) lines.reverse();
  return shellResult(0, `${lines.join("\n")}${trailing ? "\n" : ""}`);
}

async function uniqCommand({ args, stdin }: ShellCommandContext): Promise<ShellProcessResult> {
  if (args.some((arg) => arg !== "-c")) return shellResult(2, "", "uniq: 当前只支持 -c\n");
  const counts: Array<{ value: string; count: number }> = [];
  for (const line of bytesText(stdin).replace(/\n$/, "").split("\n")) {
    const previous = counts.at(-1);
    if (previous?.value === line) previous.count += 1;
    else counts.push({ value: line, count: 1 });
  }
  return shellResult(0, `${counts.map(({ value, count }) => args.includes("-c") ? `${String(count).padStart(7)} ${value}` : value).join("\n")}\n`);
}

async function inputText(fs: VirtualFileSystem, args: string[], cwd: string, stdin: Uint8Array): Promise<{ value: string; error?: never } | { value?: never; error: string }> {
  if (!args.length) return { value: bytesText(stdin) };
  const chunks: string[] = [];
  for (const argument of args) {
    try { chunks.push(bytesText(await fs.readFile(resolveVirtualPath(argument, cwd)))); }
    catch (error) { return { error: `${argument}: ${errorMessage(error)}` }; }
  }
  return { value: chunks.join("") };
}

async function copyPath(fs: VirtualFileSystem, source: string, target: string, recursive: boolean): Promise<void> {
  const stat = await fs.stat(source);
  if (stat.kind === "file") { await fs.writeFile(target, await fs.readFile(source)); return; }
  if (!recursive) throw new Error(`省略目录 ${displayVirtualPath(source)}；请使用 -r`);
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.list(source)) await copyPath(fs, entry.path, joinVirtualPath(target, entry.name), true);
}

async function walk(fs: VirtualFileSystem, path: string, output: string[]): Promise<void> {
  output.push(path);
  if ((await fs.stat(path)).kind === "file") return;
  for (const entry of await fs.list(path)) await walk(fs, entry.path, output);
}

function fileListLine(name: string, size: number, directory: boolean): string { return `${directory ? "d" : "-"}rw-r--r-- ${String(size).padStart(8)} ${name}`; }
function decodeEscapes(value: string): string { return value.replace(/\\([nrt\\])/g, (_all, escape: string) => ({ n: "\n", r: "\r", t: "\t", "\\": "\\" })[escape] ?? escape); }
function concatBytes(chunks: Uint8Array[]): Uint8Array { const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0); const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result; }
function globRegex(pattern: string): RegExp { return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "u"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function numericOption(args: string[], name: string, fallback: number): { value: number; rest: string[]; error?: string } {
  const index = args.indexOf(name);
  if (index < 0) return { value: fallback, rest: args };
  const raw = args[index + 1];
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value < 0 || value > 100_000) return { value: fallback, rest: [], error: `${name} 需要 0 到 100000 的整数` };
  return { value, rest: args.filter((_arg, position) => position !== index && position !== index + 1) };
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timeout); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}
