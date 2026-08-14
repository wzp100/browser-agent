export type VirtualEntryKind = "file" | "directory";

export interface VirtualDirectoryEntry {
  name: string;
  path: string;
  kind: VirtualEntryKind;
  size: number;
}

export interface VirtualFileStat {
  path: string;
  kind: VirtualEntryKind;
  size: number;
}

export interface VirtualFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options?: { append?: boolean }): Promise<void>;
  list(path: string): Promise<VirtualDirectoryEntry[]>;
  stat(path: string): Promise<VirtualFileStat>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface ShellProcessResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface ShellCommandContext {
  args: string[];
  cwd: string;
  env: ReadonlyMap<string, string>;
  stdin: Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ShellCommandHandler = (context: ShellCommandContext) => Promise<ShellProcessResult>;

export const EMPTY_BYTES = new Uint8Array();

export function textBytes(value: string): Uint8Array { return new TextEncoder().encode(value); }
export function bytesText(value: Uint8Array): string { return new TextDecoder().decode(value); }

export function shellResult(exitCode = 0, stdout = "", stderr = ""): ShellProcessResult {
  return { exitCode, stdout: textBytes(stdout), stderr: textBytes(stderr) };
}
