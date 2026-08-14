import { gunzipSync } from "fflate";

export interface TarEntry { path: string; data: Uint8Array; }
export interface TarLimits { maxFiles: number; maxExtractedBytes: number; maxFileBytes: number; }

const DEFAULT_LIMITS: TarLimits = { maxFiles: 10_000, maxExtractedBytes: 100 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024 };

export function extractNpmTarball(archive: Uint8Array, limits: Partial<TarLimits> = {}): TarEntry[] {
  const configured = { ...DEFAULT_LIMITS, ...limits };
  if (archive.byteLength < 4) throw new Error("npm tarball 不是有效 gzip 文件");
  const declaredSize = archive[archive.byteLength - 4]! | archive[archive.byteLength - 3]! << 8 | archive[archive.byteLength - 2]! << 16 | archive[archive.byteLength - 1]! << 24;
  if ((declaredSize >>> 0) > configured.maxExtractedBytes) throw new Error("包解压后超过空间预算");
  const tar = gunzipSync(archive);
  if (tar.byteLength > configured.maxExtractedBytes) throw new Error("包解压后超过空间预算");
  const entries: TarEntry[] = [];
  const paths = new Set<string>();
  let extractedBytes = 0;
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.subarray(0, 100));
    const prefix = tarString(header.subarray(345, 500));
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const size = tarOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) throw new Error("npm tarball 已截断");
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type !== "0" && type !== "\0" && type !== "") continue;
    const path = safePackagePath(rawPath);
    if (!path) continue;
    if (paths.has(path)) throw new Error(`包内存在重复路径：${path}`);
    paths.add(path);
    if (size > configured.maxFileBytes) throw new Error(`包内文件过大：${path}`);
    extractedBytes += size;
    if (extractedBytes > configured.maxExtractedBytes) throw new Error("包解压后超过空间预算");
    if (entries.length >= configured.maxFiles) throw new Error("包内文件数量超过预算");
    entries.push({ path, data: tar.slice(dataStart, dataEnd) });
  }
  return entries;
}

function safePackagePath(rawPath: string): string | undefined {
  const normalized = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const withoutRoot = normalized.startsWith("package/") ? normalized.slice(8) : normalized;
  if (!withoutRoot) return undefined;
  const segments = withoutRoot.split("/");
  if (normalized.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`包内存在不安全路径：${rawPath}`);
  }
  return segments.join("/");
}

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes).trim();
}

function tarOctal(bytes: Uint8Array): number {
  const value = tarString(bytes).replace(/^0+/, "") || "0";
  if (!/^[0-7]+$/.test(value)) throw new Error("tar header 包含无效文件大小");
  return Number.parseInt(value, 8);
}
