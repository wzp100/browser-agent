import type { FileSystemTree } from "@webcontainer/api";

const SNAPSHOT_GZIP_MAGIC = "BAS1G";
const SNAPSHOT_JSON_MAGIC = "BAS1J";
const DANGEROUS_NAMES = new Set(["__proto__", "prototype", "constructor"]);

export interface DependencySnapshotLimits {
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxEntries: number;
  maxDepth: number;
}

export const DEFAULT_DEPENDENCY_SNAPSHOT_LIMITS: DependencySnapshotLimits = {
  maxCompressedBytes: 64 * 1024 * 1024,
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxEntries: 100_000,
  maxDepth: 64
};

type PersistedNode =
  | { kind: "directory"; entries: Record<string, PersistedNode> }
  | { kind: "file"; encoding: "text" | "base64"; contents: string }
  | { kind: "symlink"; target: string };

export async function encodeDependencySnapshot(tree: FileSystemTree, limits: DependencySnapshotLimits = DEFAULT_DEPENDENCY_SNAPSHOT_LIMITS): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(serializeTree(tree, { entries: 0, limits }, 0)));
  if (json.byteLength > limits.maxDecompressedBytes) throw new Error("依赖快照解压后内容超过安全上限。 ");
  if (typeof CompressionStream === "undefined") return joinBytes(new TextEncoder().encode(SNAPSHOT_JSON_MAGIC), json);
  const compressed = await streamBytes(new Blob([toArrayBuffer(json)]).stream().pipeThrough(new CompressionStream("gzip")), limits.maxCompressedBytes);
  return joinBytes(new TextEncoder().encode(SNAPSHOT_GZIP_MAGIC), compressed);
}

export async function decodeDependencySnapshot(snapshot: Uint8Array, limits: DependencySnapshotLimits = DEFAULT_DEPENDENCY_SNAPSHOT_LIMITS): Promise<FileSystemTree> {
  if (snapshot.byteLength < SNAPSHOT_GZIP_MAGIC.length) throw new Error("依赖快照格式无效。 ");
  if (snapshot.byteLength > limits.maxCompressedBytes + SNAPSHOT_GZIP_MAGIC.length) throw new Error("依赖快照压缩数据超过安全上限。 ");
  const magic = new TextDecoder().decode(snapshot.subarray(0, SNAPSHOT_GZIP_MAGIC.length));
  const payload = snapshot.subarray(SNAPSHOT_GZIP_MAGIC.length);
  let json: Uint8Array;
  if (magic === SNAPSHOT_GZIP_MAGIC) {
    if (typeof DecompressionStream === "undefined") throw new Error("当前浏览器不支持解压依赖快照。 ");
    json = await streamBytes(new Blob([toArrayBuffer(payload)]).stream().pipeThrough(new DecompressionStream("gzip")), limits.maxDecompressedBytes);
  } else if (magic === SNAPSHOT_JSON_MAGIC) {
    if (payload.byteLength > limits.maxDecompressedBytes) throw new Error("依赖快照内容超过安全上限。 ");
    json = payload;
  } else throw new Error("依赖快照版本不受支持。 ");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(json));
  return deserializeTree(parsed, { entries: 0, limits }, 0);
}

interface SnapshotTraversalState { entries: number; limits: DependencySnapshotLimits }

function serializeTree(tree: FileSystemTree, state: SnapshotTraversalState, depth: number): Record<string, PersistedNode> {
  assertDepth(depth, state.limits);
  const result: Record<string, PersistedNode> = {};
  for (const [name, node] of Object.entries(tree)) {
    assertEntry(name, state);
    if ("directory" in node) result[name] = { kind: "directory", entries: serializeTree(node.directory, state, depth + 1) };
    else if ("symlink" in node.file) result[name] = { kind: "symlink", target: node.file.symlink };
    else if (typeof node.file.contents === "string") result[name] = { kind: "file", encoding: "text", contents: node.file.contents };
    else result[name] = { kind: "file", encoding: "base64", contents: bytesToBase64(node.file.contents) };
  }
  return result;
}

function deserializeTree(value: unknown, state: SnapshotTraversalState, depth: number): FileSystemTree {
  assertDepth(depth, state.limits);
  if (!isRecord(value)) throw new Error("依赖快照目录结构无效。 ");
  const result: FileSystemTree = {};
  for (const [name, rawNode] of Object.entries(value)) {
    assertEntry(name, state);
    if (!isRecord(rawNode) || typeof rawNode.kind !== "string") throw new Error(`依赖快照节点无效：${name}`);
    if (rawNode.kind === "directory") result[name] = { directory: deserializeTree(rawNode.entries, state, depth + 1) };
    else if (rawNode.kind === "symlink" && typeof rawNode.target === "string") result[name] = { file: { symlink: rawNode.target } };
    else if (rawNode.kind === "file" && rawNode.encoding === "text" && typeof rawNode.contents === "string") result[name] = { file: { contents: rawNode.contents } };
    else if (rawNode.kind === "file" && rawNode.encoding === "base64" && typeof rawNode.contents === "string") result[name] = { file: { contents: base64ToBytes(rawNode.contents) } };
    else throw new Error(`依赖快照节点类型无效：${name}`);
  }
  return result;
}

function assertEntry(name: string, state: SnapshotTraversalState): void {
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === ".." || DANGEROUS_NAMES.has(name) || /[\u0000-\u001f]/.test(name)) throw new Error(`依赖快照包含危险节点名：${name || "<empty>"}`);
  state.entries += 1;
  if (state.entries > state.limits.maxEntries) throw new Error("依赖快照节点数量超过安全上限。 ");
}

function assertDepth(depth: number, limits: DependencySnapshotLimits): void {
  if (depth > limits.maxDepth) throw new Error("依赖快照目录深度超过安全上限。 ");
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("依赖快照包含无效 Base64 数据。 "); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function streamBytes(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("依赖快照流超过安全上限。 ");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function joinBytes(prefix: Uint8Array, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(prefix.byteLength + payload.byteLength);
  result.set(prefix);
  result.set(payload, prefix.byteLength);
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
