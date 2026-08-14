import { maxSatisfying, valid } from "semver";
import { joinVirtualPath } from "../paths";
import { bytesText, textBytes, type VirtualFileSystem } from "../types";
import { extractNpmTarball } from "./archive";
import { verifyPackageIntegrity } from "./integrity";
import { parsePackageSpec, validatePackageName, type PackageRequest } from "./spec";

const LOCK_PATH = "/.browser-agent/virtual-lock.json";
const STORE_ROOT = "/.browser-agent/packages/store";
const TEMP_ROOT = "/.browser-agent/packages/tmp";

export interface VirtualPackageLock {
  lockfileVersion: 1;
  registry: string;
  roots: Record<string, string>;
  packages: Record<string, LockedPackage>;
}

export interface LockedPackage {
  name: string;
  version: string;
  storePath: string;
  dependencies: Record<string, string>;
  integrity: string;
}

export interface PackageInstallOptions {
  save?: boolean;
  dependencySection?: "dependencies" | "devDependencies";
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface PackageInstallResult {
  installed: Array<{ name: string; version: string }>;
  warnings: string[];
  lock: VirtualPackageLock;
}

export interface PackageManagerLimits {
  maxPackages: number;
  maxTarballBytes: number;
  maxDownloadBytes: number;
  maxExtractedBytesPerPackage: number;
  maxFilesPerPackage: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RegistryMetadata {
  name: string;
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, RegistryVersion>;
}

interface RegistryVersion {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
}

interface ResolvedNode { id: string; manifest: RegistryVersion; dependencies: Record<string, string>; }

const DEFAULT_LIMITS: PackageManagerLimits = {
  maxPackages: 128,
  maxTarballBytes: 20 * 1024 * 1024,
  maxDownloadBytes: 50 * 1024 * 1024,
  maxExtractedBytesPerPackage: 100 * 1024 * 1024,
  maxFilesPerPackage: 10_000
};

export class VirtualPackageManager {
  private readonly metadata = new Map<string, Promise<RegistryMetadata>>();
  private readonly registry: string;
  private readonly limits: PackageManagerLimits;

  constructor(
    private readonly fs: VirtualFileSystem,
    registry = "https://registry.npmjs.org",
    private readonly fetcher: FetchLike = (input, init) => globalThis.fetch(input, init),
    limits: Partial<PackageManagerLimits> = {}
  ) {
    const url = new URL(registry);
    if (url.protocol !== "https:") throw new Error("npm Registry 必须使用 HTTPS");
    this.registry = url.href.replace(/\/$/, "");
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  async install(specs: string[], options: PackageInstallOptions = {}): Promise<PackageInstallResult> {
    if (!specs.length) throw new Error("npm install 至少需要一个包名");
    const requests = specs.map(parsePackageSpec);
    requests.forEach((request) => validatePackageName(request.name));
    options.signal?.throwIfAborted();
    options.onProgress?.(`正在解析 ${requests.length} 个顶层依赖…`);
    const warnings: string[] = [];
    const { roots, nodes } = await this.resolveGraph(requests, warnings, options.signal);
    const previousLock = await this.readLock();
    const lock: VirtualPackageLock = previousLock ?? { lockfileVersion: 1, registry: this.registry, roots: {}, packages: {} };
    let downloadedBytes = 0;
    const installed: Array<{ name: string; version: string }> = [];

    await this.fs.mkdir(STORE_ROOT, { recursive: true });
    await this.fs.mkdir(TEMP_ROOT, { recursive: true });
    for (const node of nodes.values()) {
      options.signal?.throwIfAborted();
      const storePath = packageStorePath(node.manifest.name, node.manifest.version);
      if (!await this.fs.exists(storePath)) {
        options.onProgress?.(`正在下载 ${node.id}…`);
        const dist = node.manifest.dist;
        if (!dist?.tarball) throw new Error(`${node.id} 缺少 tarball 地址`);
        const tarballUrl = new URL(dist.tarball);
        if (tarballUrl.protocol !== "https:") throw new Error(`${node.id} 的 tarball 不是 HTTPS`);
        const response = await this.fetcher(tarballUrl.href, { ...(options.signal ? { signal: options.signal } : {}), headers: { Accept: "application/octet-stream" } });
        if (!response.ok) throw new Error(`下载 ${node.id} 失败：HTTP ${response.status}`);
        const declaredSize = Number(response.headers.get("content-length") ?? "0");
        if (declaredSize > this.limits.maxTarballBytes) throw new Error(`${node.id} tarball 超过大小预算`);
        const archive = await readLimitedBody(response, this.limits.maxTarballBytes, `${node.id} tarball 超过大小预算`);
        downloadedBytes += archive.byteLength;
        if (downloadedBytes > this.limits.maxDownloadBytes) throw new Error("本次安装下载量超过预算");
        await verifyPackageIntegrity(archive, dist.integrity, dist.shasum);
        const entries = extractNpmTarball(archive, {
          maxFiles: this.limits.maxFilesPerPackage,
          maxExtractedBytes: this.limits.maxExtractedBytesPerPackage
        });
        verifyManifest(entries, node.manifest);
        const temporaryPath = `${TEMP_ROOT}/${crypto.randomUUID()}`;
        try {
          await this.fs.mkdir(temporaryPath, { recursive: true });
          for (const entry of entries) await this.fs.writeFile(joinVirtualPath(temporaryPath, entry.path), entry.data);
          await this.fs.mkdir(storePath.slice(0, storePath.lastIndexOf("/")), { recursive: true });
          await this.fs.rename(temporaryPath, storePath);
        } catch (error) {
          await this.fs.remove(temporaryPath, { recursive: true, force: true });
          throw error;
        }
        installed.push({ name: node.manifest.name, version: node.manifest.version });
      }
      lock.packages[node.id] = {
        name: node.manifest.name,
        version: node.manifest.version,
        storePath,
        dependencies: node.dependencies,
        integrity: node.manifest.dist?.integrity ?? `sha1-${node.manifest.dist?.shasum ?? "unknown"}`
      };
    }
    Object.assign(lock.roots, roots);
    lock.registry = this.registry;
    await this.fs.writeFile(LOCK_PATH, textBytes(`${JSON.stringify(lock, null, 2)}\n`));
    if (options.save !== false) await this.saveDependencies(requests, roots, nodes, options.dependencySection ?? "dependencies");
    options.onProgress?.(`完成：新增 ${installed.length} 个包，共解析 ${nodes.size} 个包。`);
    return { installed, warnings, lock };
  }

  async readLock(): Promise<VirtualPackageLock | undefined> {
    if (!await this.fs.exists(LOCK_PATH)) return undefined;
    try {
      const lock = JSON.parse(bytesText(await this.fs.readFile(LOCK_PATH))) as VirtualPackageLock;
      return lock.lockfileVersion === 1 ? lock : undefined;
    } catch { return undefined; }
  }

  private async resolveGraph(requests: PackageRequest[], warnings: string[], signal?: AbortSignal): Promise<{ roots: Record<string, string>; nodes: Map<string, ResolvedNode> }> {
    const roots: Record<string, string> = {};
    const nodes = new Map<string, ResolvedNode>();
    const queue: Array<{ request: PackageRequest; parent?: ResolvedNode; optional: boolean }> = requests.map((request) => ({ request, optional: false }));
    while (queue.length) {
      signal?.throwIfAborted();
      const item = queue.shift()!;
      let manifest: RegistryVersion;
      try { manifest = await this.resolveVersion(item.request, signal); }
      catch (error) {
        if (item.optional) { warnings.push(`已跳过可选依赖 ${item.request.name}: ${errorMessage(error)}`); continue; }
        throw error;
      }
      const id = `${manifest.name}@${manifest.version}`;
      if (item.parent) item.parent.dependencies[item.request.name] = id;
      else roots[item.request.name] = id;
      if (nodes.has(id)) continue;
      if (nodes.size >= this.limits.maxPackages) throw new Error(`依赖图超过 ${this.limits.maxPackages} 个包的预算`);
      const node: ResolvedNode = { id, manifest, dependencies: {} };
      nodes.set(id, node);
      for (const [name, range] of Object.entries(manifest.dependencies ?? {})) queue.push({ request: { name, range }, parent: node, optional: false });
      for (const [name, range] of Object.entries(manifest.optionalDependencies ?? {})) queue.push({ request: { name, range }, parent: node, optional: true });
      if (Object.keys(manifest.peerDependencies ?? {}).length) warnings.push(`${id} 声明了 peerDependencies；虚拟运行时不会自动安装它们。`);
    }
    return { roots, nodes };
  }

  private async resolveVersion(request: PackageRequest, signal?: AbortSignal): Promise<RegistryVersion> {
    validatePackageName(request.name);
    const metadata = await this.getMetadata(request.name, signal);
    const versions = metadata.versions ?? {};
    const tagged = metadata["dist-tags"]?.[request.range];
    const version = tagged ?? (valid(request.range) ? request.range : maxSatisfying(Object.keys(versions), request.range));
    if (!version || !versions[version]) throw new Error(`找不到满足 ${request.name}@${request.range} 的版本`);
    const manifest = versions[version]!;
    if (manifest.name !== request.name || manifest.version !== version) throw new Error(`${request.name}@${version} 的 Registry 元数据身份不匹配`);
    return manifest;
  }

  private getMetadata(name: string, signal?: AbortSignal): Promise<RegistryMetadata> {
    let pending = this.metadata.get(name);
    if (!pending) {
      pending = this.fetcher(`${this.registry}/${encodeURIComponent(name)}`, {
        ...(signal ? { signal } : {}),
        headers: { Accept: "application/vnd.npm.install-v1+json" }
      }).then(async (response) => {
        if (!response.ok) throw new Error(`读取 ${name} 元数据失败：HTTP ${response.status}`);
        return JSON.parse(bytesText(await readLimitedBody(response, 5 * 1024 * 1024, `${name} 元数据超过大小预算`))) as RegistryMetadata;
      });
      this.metadata.set(name, pending);
    }
    return pending;
  }

  private async saveDependencies(requests: PackageRequest[], roots: Record<string, string>, nodes: Map<string, ResolvedNode>, section: "dependencies" | "devDependencies"): Promise<void> {
    const path = "/package.json";
    let manifest: Record<string, unknown> = {};
    if (await this.fs.exists(path)) {
      try { manifest = JSON.parse(bytesText(await this.fs.readFile(path))) as Record<string, unknown>; }
      catch { throw new Error("package.json 不是有效 JSON，无法保存依赖"); }
    }
    const dependencies = isStringRecord(manifest[section]) ? { ...manifest[section] } : {};
    for (const request of requests) {
      const node = nodes.get(roots[request.name]!);
      if (node) dependencies[request.name] = `^${node.manifest.version}`;
    }
    manifest[section] = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
    await this.fs.writeFile(path, textBytes(`${JSON.stringify(manifest, null, 2)}\n`));
  }
}

function packageStorePath(name: string, version: string): string {
  return `${STORE_ROOT}/${encodeURIComponent(name)}/${version}`;
}

function verifyManifest(entries: Array<{ path: string; data: Uint8Array }>, expected: RegistryVersion): void {
  const entry = entries.find((candidate) => candidate.path === "package.json");
  if (!entry) throw new Error(`${expected.name}@${expected.version} 缺少 package.json`);
  let manifest: { name?: string; version?: string };
  try { manifest = JSON.parse(bytesText(entry.data)) as { name?: string; version?: string }; }
  catch { throw new Error(`${expected.name}@${expected.version} 的 package.json 无效`); }
  if (manifest.name !== expected.name || manifest.version !== expected.version) throw new Error(`${expected.name}@${expected.version} 的 tarball 身份不匹配`);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function readLimitedBody(response: Response, maximumBytes: number, message: string): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw new Error(message);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) { await reader.cancel(); throw new Error(message); }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
