import { ProjectFileService, type ProjectFileEntry } from "../../workspace-contracts/src/index";
import { normalizeInternalPath, virtualBasename, virtualDirname } from "./paths";
import type { VirtualDirectoryEntry, VirtualFileStat, VirtualFileSystem } from "./types";

export class ProjectVirtualFileSystem implements VirtualFileSystem {
  constructor(private readonly service: ProjectFileService) {}

  async readFile(path: string): Promise<Uint8Array> { return (await this.service.read(normalizeInternalPath(path))).data; }

  async writeFile(path: string, data: Uint8Array, options: { append?: boolean } = {}): Promise<void> {
    const normalized = normalizeInternalPath(path);
    if (options.append && await this.service.exists(normalized)) {
      const previous = (await this.service.read(normalized)).data;
      const combined = new Uint8Array(previous.byteLength + data.byteLength);
      combined.set(previous);
      combined.set(data, previous.byteLength);
      await this.service.write(normalized, combined, { source: "terminal" });
      return;
    }
    await this.service.write(normalized, data, { source: "terminal" });
  }

  async list(path: string): Promise<VirtualDirectoryEntry[]> {
    const normalized = normalizeInternalPath(path);
    if (!await this.service.exists(normalized)) throw fsError("ENOENT", normalized);
    let entries: ProjectFileEntry[];
    try { entries = await this.service.list(normalized); }
    catch (error) { if (isTypeMismatch(error)) throw fsError("ENOTDIR", normalized); throw error; }
    return entries
      .filter((entry) => virtualDirname(entry.path) === normalized)
      .map((entry) => ({ name: virtualBasename(entry.path), path: entry.path, kind: entry.kind, size: entry.size ?? 0 }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async stat(path: string): Promise<VirtualFileStat> {
    const normalized = normalizeInternalPath(path);
    if (normalized === "/") return { path: normalized, kind: "directory", size: 0 };
    try {
      const data = await this.service.read(normalized);
      return { path: normalized, kind: "file", size: data.data.byteLength };
    } catch (error) {
      if (!isTypeMismatch(error)) {
        if (!await this.service.exists(normalized)) throw fsError("ENOENT", normalized);
        throw error;
      }
      return { path: normalized, kind: "directory", size: 0 };
    }
  }

  async exists(path: string): Promise<boolean> { return this.service.exists(normalizeInternalPath(path)); }
  async mkdir(path: string): Promise<void> { await this.service.mkdir(normalizeInternalPath(path), "terminal"); }

  async remove(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    const normalized = normalizeInternalPath(path);
    if (!await this.service.exists(normalized)) {
      if (options.force) return;
      throw fsError("ENOENT", normalized);
    }
    const stat = await this.stat(normalized);
    if (stat.kind === "directory" && !options.recursive && (await this.list(normalized)).length) throw fsError("ENOTEMPTY", normalized);
    await this.service.delete(normalized, "terminal");
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizeInternalPath(from);
    const target = normalizeInternalPath(to);
    const stat = await this.stat(source);
    if (stat.kind === "file") { await this.service.move(source, target, "terminal"); return; }
    if (target.startsWith(`${source}/`)) throw fsError("EINVAL", `${source} → ${target}`);
    await this.service.mkdir(target, "terminal");
    for (const entry of await this.service.list(source)) {
      const destination = `${target}${entry.path.slice(source.length)}`;
      if (entry.kind === "directory") await this.service.ensureDirectory(destination);
      else await this.service.move(entry.path, destination, "terminal");
    }
    if (await this.service.exists(source)) await this.service.delete(source, "terminal");
  }
}

function isTypeMismatch(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && ((error as { name?: unknown }).name === "TypeMismatchError" || /EISDIR|directory/i.test(String((error as { message?: unknown }).message ?? ""))));
}

function fsError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}
