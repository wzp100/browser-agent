import { normalizeInternalPath, virtualBasename, virtualDirname } from "./paths";
import type { VirtualDirectoryEntry, VirtualFileStat, VirtualFileSystem } from "./types";

export class MemoryVirtualFileSystem implements VirtualFileSystem {
  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>(["/"]);

  async readFile(path: string): Promise<Uint8Array> {
    const normalized = normalizeInternalPath(path);
    const value = this.files.get(normalized);
    if (!value) throw fsError("ENOENT", normalized);
    return value.slice();
  }

  async writeFile(path: string, data: Uint8Array, options: { append?: boolean } = {}): Promise<void> {
    const normalized = normalizeInternalPath(path);
    if (normalized === "/") throw fsError("EISDIR", normalized);
    await this.mkdir(virtualDirname(normalized), { recursive: true });
    const previous = options.append ? this.files.get(normalized) : undefined;
    if (previous) {
      const combined = new Uint8Array(previous.byteLength + data.byteLength);
      combined.set(previous);
      combined.set(data, previous.byteLength);
      this.files.set(normalized, combined);
    } else this.files.set(normalized, data.slice());
  }

  async list(path: string): Promise<VirtualDirectoryEntry[]> {
    const normalized = normalizeInternalPath(path);
    if (!this.directories.has(normalized)) {
      if (this.files.has(normalized)) throw fsError("ENOTDIR", normalized);
      throw fsError("ENOENT", normalized);
    }
    const entries = new Map<string, VirtualDirectoryEntry>();
    for (const directory of this.directories) {
      if (directory === normalized || virtualDirname(directory) !== normalized) continue;
      entries.set(directory, { name: virtualBasename(directory), path: directory, kind: "directory", size: 0 });
    }
    for (const [file, data] of this.files) {
      if (virtualDirname(file) !== normalized) continue;
      entries.set(file, { name: virtualBasename(file), path: file, kind: "file", size: data.byteLength });
    }
    return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async stat(path: string): Promise<VirtualFileStat> {
    const normalized = normalizeInternalPath(path);
    const file = this.files.get(normalized);
    if (file) return { path: normalized, kind: "file", size: file.byteLength };
    if (this.directories.has(normalized)) return { path: normalized, kind: "directory", size: 0 };
    throw fsError("ENOENT", normalized);
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizeInternalPath(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const normalized = normalizeInternalPath(path);
    if (this.files.has(normalized)) throw fsError("ENOTDIR", normalized);
    if (this.directories.has(normalized)) return;
    const parent = virtualDirname(normalized);
    if (!this.directories.has(parent)) {
      if (!options.recursive) throw fsError("ENOENT", parent);
      await this.mkdir(parent, { recursive: true });
    }
    this.directories.add(normalized);
  }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    const normalized = normalizeInternalPath(path);
    if (normalized === "/") throw fsError("EPERM", normalized);
    if (this.files.delete(normalized)) return;
    if (!this.directories.has(normalized)) {
      if (options.force) return;
      throw fsError("ENOENT", normalized);
    }
    const descendants = [...this.files.keys(), ...this.directories].filter((candidate) => candidate.startsWith(`${normalized}/`));
    if (descendants.length && !options.recursive) throw fsError("ENOTEMPTY", normalized);
    for (const file of [...this.files.keys()]) if (file.startsWith(`${normalized}/`)) this.files.delete(file);
    for (const directory of [...this.directories]) if (directory === normalized || directory.startsWith(`${normalized}/`)) this.directories.delete(directory);
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizeInternalPath(from);
    const target = normalizeInternalPath(to);
    if (source === "/" || target === "/" || target.startsWith(`${source}/`)) throw fsError("EINVAL", `${source} → ${target}`);
    await this.mkdir(virtualDirname(target), { recursive: true });
    if (this.files.has(source)) {
      const data = this.files.get(source)!;
      await this.remove(target, { recursive: true, force: true });
      this.files.set(target, data);
      this.files.delete(source);
      return;
    }
    if (!this.directories.has(source)) throw fsError("ENOENT", source);
    await this.remove(target, { recursive: true, force: true });
    const movedDirectories = [...this.directories].filter((path) => path === source || path.startsWith(`${source}/`));
    const movedFiles = [...this.files.entries()].filter(([path]) => path.startsWith(`${source}/`));
    for (const path of movedDirectories) this.directories.delete(path);
    for (const [path] of movedFiles) this.files.delete(path);
    for (const path of movedDirectories) this.directories.add(`${target}${path.slice(source.length)}`);
    for (const [path, data] of movedFiles) this.files.set(`${target}${path.slice(source.length)}`, data);
  }
}

function fsError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}
