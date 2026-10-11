import { displayVirtualPath, normalizeInternalPath, resolveVirtualPath, virtualDirname } from "../paths";
import type { VirtualFileSystem } from "../types";

/** Deliberately small snapshot and mutation limits for guest JavaScript. */
export const SANDBOX_FILESYSTEM_LIMITS = Object.freeze({
  maxEntries: 512,
  maxFileBytes: 1024 * 1024,
  maxReadBytes: 4 * 1024 * 1024,
  maxChangedPaths: 64,
  maxWrittenFileBytes: 1024 * 1024,
  maxWrittenBytes: 4 * 1024 * 1024,
  maxPathDepth: 32,
  maxPathLength: 1024
});

export type SandboxFileKind = "file" | "directory";
export interface SandboxFilesystemEntry { path: string; kind: SandboxFileKind; data?: string; fingerprint?: string; }
export interface SandboxFilesystemSnapshot { entries: SandboxFilesystemEntry[]; }
export interface SandboxFilesystemMutation { path: string; data: string; expectedFingerprint?: string; }
export interface SandboxFilesystemOverlay { directories: string[]; writes: SandboxFilesystemMutation[]; }

export class BrowserRuntimeFilesystemError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "BrowserRuntimeFilesystemError"; }
}

/** Copy a bounded, data-only workspace view.  No browser file handles cross this boundary. */
export async function captureSandboxFilesystem(fs: VirtualFileSystem): Promise<SandboxFilesystemSnapshot> {
  const entries: SandboxFilesystemEntry[] = [{ path: "/workspace", kind: "directory" }];
  let readableBytes = 0;
  const visit = async (internal: string): Promise<void> => {
    for (const entry of await fs.list(internal)) {
      if (reservedInternalPath(entry.path)) continue;
      const path = displayVirtualPath(entry.path);
      assertGuestPath(path);
      if (entries.length >= SANDBOX_FILESYSTEM_LIMITS.maxEntries) throw fsLimit("snapshot entry count");
      if (entry.kind === "directory") { entries.push({ path, kind: "directory" }); await visit(entry.path); continue; }
      const data = await fs.readFile(entry.path);
      if (data.byteLength > SANDBOX_FILESYSTEM_LIMITS.maxFileBytes) throw fsLimit(`file ${path} is too large`);
      readableBytes += data.byteLength;
      if (readableBytes > SANDBOX_FILESYSTEM_LIMITS.maxReadBytes) throw fsLimit("snapshot readable bytes");
      entries.push({ path, kind: "file", data: bytesToBase64(data), fingerprint: fingerprint(data) });
    }
  };
  await visit("/");
  return { entries };
}

/** Verify the guest manifest again before the only host-visible writes occur. */
export async function commitSandboxFilesystem(fs: VirtualFileSystem, snapshot: SandboxFilesystemSnapshot, overlay: SandboxFilesystemOverlay | undefined): Promise<void> {
  if (!overlay || (!overlay.writes.length && !overlay.directories.length)) return;
  validateOverlay(snapshot, overlay);
  const expected = new Map(snapshot.entries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry.fingerprint]));
  // Validate every write before any mutation, including expected-absent creates.
  for (const write of overlay.writes) {
    const internal = guestToInternal(write.path);
    const exists = await fs.exists(internal);
    let actual: string | undefined;
    if (exists) {
      try { actual = fingerprint(await fs.readFile(internal)); }
      catch { throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_CONFLICT", `path type changed: ${write.path}`); }
    }
    if (actual !== expected.get(write.path)) throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_CONFLICT", `snapshot conflict: ${write.path}`);
  }
  const recovery: Array<{ path: string; data?: Uint8Array }> = [];
  try {
    for (const directory of [...overlay.directories].sort((a, b) => a.length - b.length || a.localeCompare(b))) await fs.mkdir(guestToInternal(directory), { recursive: true });
    for (const write of [...overlay.writes].sort((a, b) => a.path.localeCompare(b.path))) {
      const internal = guestToInternal(write.path);
      let before: Uint8Array | undefined;
      try { if (await fs.exists(internal)) before = await fs.readFile(internal); } catch { /* type was already checked above */ }
      recovery.push(before ? { path: internal, data: before } : { path: internal });
      await fs.writeFile(internal, base64ToBytes(write.data));
    }
  } catch (error) {
    // Best effort rollback makes a partial underlying browser write fail closed rather than leak a half transaction.
    for (const item of recovery.reverse()) {
      try {
        if (item.data) await fs.writeFile(item.path, item.data);
        else if (await fs.exists(item.path)) await fs.remove(item.path, { force: true });
      } catch { /* original writeback error remains authoritative */ }
    }
    if (error instanceof BrowserRuntimeFilesystemError) throw error;
    throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_WRITEBACK_FAILED", error instanceof Error ? error.message : String(error));
  }
}

function validateOverlay(snapshot: SandboxFilesystemSnapshot, overlay: SandboxFilesystemOverlay): void {
  if (!Array.isArray(overlay.writes) || !Array.isArray(overlay.directories)) throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_MANIFEST", "invalid mutation manifest");
  const known = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const changes = new Set<string>();
  let bytes = 0;
  for (const directory of overlay.directories) {
    assertGuestPath(directory);
    if (directory === "/workspace") continue;
    if (changes.has(directory)) throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_MANIFEST", `duplicate mutation: ${directory}`);
    changes.add(directory);
    const original = known.get(directory);
    if (original?.kind === "file") throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_MANIFEST", `directory replaces file: ${directory}`);
  }
  for (const write of overlay.writes) {
    assertGuestPath(write.path);
    if (changes.has(write.path)) throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_MANIFEST", `duplicate mutation: ${write.path}`);
    changes.add(write.path);
    const original = known.get(write.path);
    if (original?.kind === "directory") throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_MANIFEST", `file replaces directory: ${write.path}`);
    if (write.expectedFingerprint !== original?.fingerprint) throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_MANIFEST", `unexpected fingerprint: ${write.path}`);
    const size = base64ToBytes(write.data).byteLength;
    if (size > SANDBOX_FILESYSTEM_LIMITS.maxWrittenFileBytes) throw fsLimit(`written file ${write.path} is too large`);
    bytes += size;
  }
  if (changes.size > SANDBOX_FILESYSTEM_LIMITS.maxChangedPaths) throw fsLimit("changed path count");
  if (bytes > SANDBOX_FILESYSTEM_LIMITS.maxWrittenBytes) throw fsLimit("written bytes");
}

function assertGuestPath(path: string): void {
  if (typeof path !== "string" || path.length > SANDBOX_FILESYSTEM_LIMITS.maxPathLength || path.includes("\0")) throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_PATH", "invalid path");
  let internal: string;
  try { internal = guestToInternal(path); } catch { throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_PATH", `outside /workspace: ${path}`); }
  if (internal.split("/").filter(Boolean).length > SANDBOX_FILESYSTEM_LIMITS.maxPathDepth || reservedInternalPath(internal)) throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_PATH", `reserved or too deep: ${path}`);
}
function guestToInternal(path: string): string { return resolveVirtualPath(path, "/"); }
function reservedInternalPath(path: string): boolean { return normalizeInternalPath(path).split("/").some((part) => part === ".git" || part === ".browser-agent"); }
function fsLimit(detail: string): BrowserRuntimeFilesystemError { return new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_QUOTA", detail); }
function fingerprint(data: Uint8Array): string { let value = 2166136261; for (const byte of data) { value ^= byte; value = Math.imul(value, 16777619); } return `${data.byteLength}:${(value >>> 0).toString(16)}`; }
function bytesToBase64(data: Uint8Array): string { let binary = ""; for (let index = 0; index < data.length; index += 0x8000) binary += String.fromCharCode(...data.subarray(index, index + 0x8000)); return btoa(binary); }
function base64ToBytes(value: string): Uint8Array { if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw new BrowserRuntimeFilesystemError("ERR_BROWSER_RUNTIME_FS_MANIFEST", "invalid binary data"); const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
