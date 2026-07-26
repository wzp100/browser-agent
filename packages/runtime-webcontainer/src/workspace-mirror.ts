import type { FileSystemTree, IFSWatcher, WebContainer, WebContainerProcess } from "@webcontainer/api";
import { logger } from "../../logging/src/index";
import type { InteractiveRuntimeSession, RuntimeSession, ScriptExecutionRequest, ScriptExecutionResult, ScriptRuntimeProvider, TerminalDimensions } from "../../runtime-contracts/src/index";
import { BROWSER_AGENT_INSTALLED_PACKAGE_DIRECTORY, BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT, BROWSER_AGENT_PACKAGE_DIRECTORY, isBrowserAgentPackagePath, isRuntimeIgnoredPath, ProjectFileService, type ProjectFileEntry } from "../../workspace-contracts/src/index";
import { runtimeCwd, runtimeFsPath } from "./paths";
import { isDependencyMutationCommand, isRuntimeNodeModulesPath, runtimePackageEnvironment } from "./package-cache";
import { decodeDependencySnapshot, encodeDependencySnapshot } from "./dependency-snapshot";
import { inspectWebContainerSupport } from "./support";

const runtimeLog = logger("runtime.webcontainer");

interface SharedWebContainerState {
  container?: WebContainer;
  bootPromise?: Promise<WebContainer>;
  bootError?: Error;
}

type RuntimeGlobal = typeof globalThis & { __agentCodexWebContainer?: SharedWebContainerState };

export interface MirrorEvent {
  kind: "boot" | "sync" | "conflict" | "error";
  message: string;
  path?: string;
}

export type MirrorEventHandler = (event: MirrorEvent) => void;

export class WorkspaceMirror {
  private container: WebContainer | undefined;
  private fileService: ProjectFileService | undefined;
  private watcher: IFSWatcher | undefined;
  private readonly suppressed = new Map<string, number>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly activeRuntimeSyncs = new Set<Promise<void>>();
  private shell: WebContainerProcess | undefined;
  private shellWriter: WritableStreamDefaultWriter<string> | undefined;
  private connectPromise: Promise<void> | undefined;
  private connectingProjectId: string | undefined;
  private dependencySnapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private dependencySnapshotDirty = false;
  private dependencySnapshotPromise: Promise<void> | undefined;

  constructor(private readonly onEvent?: MirrorEventHandler) {}

  get ready(): boolean { return Boolean(this.container && this.fileService); }
  get workingDirectory(): string { return "/workspace"; }

  async connect(fileService: ProjectFileService): Promise<void> {
    if (this.ready && this.fileService?.projectId === fileService.projectId) {
      runtimeLog.debug("项目 Runtime 已连接，跳过重复连接", { projectId: fileService.projectId });
      return;
    }
    if (this.connectPromise) {
      runtimeLog.debug("等待正在进行的 Runtime 连接", { requestedProjectId: fileService.projectId, connectingProjectId: this.connectingProjectId });
      await this.connectPromise;
      if (this.ready && this.fileService?.projectId === fileService.projectId) return;
    }
    this.connectingProjectId = fileService.projectId;
    this.connectPromise = this.connectOnce(fileService).finally(() => {
      this.connectPromise = undefined;
      this.connectingProjectId = undefined;
    });
    await this.connectPromise;
  }

  private async connectOnce(fileService: ProjectFileService): Promise<void> {
    await this.disconnect();
    const support = inspectWebContainerSupport();
    if (!support.supported) {
      runtimeLog.warn("浏览器能力不足，已在 boot 前阻止 Runtime 启动", { projectId: fileService.projectId, ...support });
      throw new Error(support.message);
    }
    runtimeLog.info("开始连接项目 Runtime", { projectId: fileService.projectId, isolated: support.crossOriginIsolated, sharedArrayBuffer: support.sharedArrayBuffer });
    this.onEvent?.({ kind: "boot", message: "正在启动浏览器 Node.js Runtime…" });
    try {
      this.container = await sharedWebContainer();
    } catch (error) {
      runtimeLog.error("WebContainer 启动失败", { projectId: fileService.projectId, isolated: support.crossOriginIsolated, sharedArrayBuffer: support.sharedArrayBuffer }, error);
      throw new Error(`WebContainer 启动失败：${errorMessage(error)}`);
    }
    this.fileService = fileService;
    const entries = await fileService.captureBaseline();
    const projectFileCount = entries.filter((entry) => entry.kind === "file" && !isBrowserAgentPackagePath(entry.path)).length;
    const tree = await buildFileSystemTree(fileService, entries);
    insertDirectory(tree, BROWSER_AGENT_INSTALLED_PACKAGE_DIRECTORY);
    await clearRuntimeWorkspace(this.container);
    await this.container.mount(tree);
    const restoredDependencies = await this.restoreDependencySnapshot();
    runtimeLog.info("真实项目已挂载到 Runtime", {
      projectId: fileService.projectId,
      files: projectFileCount,
      directories: entries.filter((entry) => entry.kind === "directory").length,
      packageCache: runtimePackageEnvironment(this.container.workdir).npm_config_cache,
      restoredDependencies
    });
    this.watcher = this.container.fs.watch("/", { recursive: true }, (_event, filename) => {
      const relative = String(filename).replace(/\\/g, "/").replace(this.container?.workdir ?? "", "").replace(/^\/+/, "");
      if (!relative) return;
      const path = `/${relative}`;
      if (isRuntimeNodeModulesPath(path)) { this.scheduleDependencySnapshot(); return; }
      if (isRuntimeIgnoredPath(path) || this.isSuppressed(path)) return;
      runtimeLog.debug("检测到 Runtime 文件事件", { event: _event, path });
      const previous = this.pending.get(path);
      if (previous) clearTimeout(previous);
      this.pending.set(path, setTimeout(() => {
        this.pending.delete(path);
        void this.trackRuntimeSync(path).catch((error) => {
          runtimeLog.error("Runtime 文件事件写回失败", { path }, error);
        });
      }, 160));
    });
    this.onEvent?.({ kind: "boot", message: `Runtime 已连接 ${projectFileCount} 个项目文件；已安装依赖可跨终端复用。` });
  }

  async available(): Promise<boolean> {
    return inspectWebContainerSupport().supported;
  }

  async syncExternalChanges(): Promise<number> {
    if (!this.fileService || !this.container) return 0;
    const changes = await this.fileService.refresh();
    for (const change of changes) {
      try {
        if (change.type === "delete") await this.container.fs.rm(runtimeFsPath(change.path), { recursive: true, force: true });
        else await this.syncHostPath(change.path);
      } catch (error) {
        runtimeLog.error("外部变更同步到 Runtime 失败", { projectId: this.fileService.projectId, path: change.path, changeType: change.type }, error);
        this.onEvent?.({ kind: "error", path: change.path, message: errorMessage(error) });
      }
    }
    if (changes.length) {
      runtimeLog.info("外部变更已同步到 Runtime", { projectId: this.fileService.projectId, changes: changes.length });
      this.onEvent?.({ kind: "sync", message: `已从真实目录同步 ${changes.length} 项外部变更。` });
    }
    return changes.length;
  }

  async syncHostPath(path: string): Promise<void> {
    if (!this.fileService || !this.container || isRuntimeIgnoredPath(path)) return;
    const target = runtimeFsPath(path);
    this.suppress(path);
    try {
      const result = await this.fileService.read(path);
      await this.container.fs.mkdir(parentPath(target), { recursive: true });
      await this.container.fs.writeFile(target, result.data);
      runtimeLog.debug("真实文件已同步到 Runtime", { projectId: this.fileService.projectId, path, bytes: result.data.byteLength });
      this.onEvent?.({ kind: "sync", path, message: `已同步到 Runtime：${path}` });
    } catch (error) {
      if (isMissing(error)) await this.container.fs.rm(target, { recursive: true, force: true });
      else throw error;
    }
  }

  async flushPendingWrites(settleMilliseconds = 180): Promise<void> {
    if (!this.fileService || !this.container) return;
    if (settleMilliseconds > 0) await new Promise<void>((resolve) => setTimeout(resolve, settleMilliseconds));
    while (this.pending.size || this.activeRuntimeSyncs.size) {
      const paths = [...this.pending.keys()];
      for (const path of paths) {
        const timeout = this.pending.get(path);
        if (timeout) clearTimeout(timeout);
        this.pending.delete(path);
      }
      const scheduled = paths.map((path) => this.trackRuntimeSync(path));
      await Promise.all([...this.activeRuntimeSyncs, ...scheduled]);
    }
  }

  async execute(request: ScriptExecutionRequest): Promise<ScriptExecutionResult> {
    request.signal?.throwIfAborted();
    const container = this.requireContainer();
    let command: string;
    let args: string[];
    if (request.kind === "javascript") {
      const tempDirectory = runtimeFsPath(request.scratchDirectory ?? "/.browser-agent/state/runs/runtime/scratch");
      const script = `${tempDirectory}/${crypto.randomUUID()}.mjs`;
      await container.fs.mkdir(tempDirectory, { recursive: true });
      await container.fs.writeFile(script, request.source);
      command = "node";
      args = [script];
    } else {
      command = "jsh";
      args = ["-c", request.source];
    }
    const cwd = runtimeCwd(request.workingDirectory);
    runtimeLog.info("启动 Runtime 命令", { kind: request.kind, command, argumentCount: args.length, cwd });
    const process = await container.spawn(command, args, { cwd, env: runtimePackageEnvironment(container.workdir) });
    let stdout = "";
    const output = process.output.pipeTo(new WritableStream({ write(chunk) { stdout += chunk; } }));
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 120_000, 1_000), 600_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        process.kill();
        reject(new Error(`Runtime 命令超过 ${Math.ceil(timeoutMs / 1000)} 秒，已终止。`));
      }, timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      request.signal?.addEventListener("abort", () => {
        process.kill();
        reject(request.signal?.reason instanceof Error ? request.signal.reason : new DOMException("运行已取消。", "AbortError"));
      }, { once: true });
    });
    let exitCode: number;
    try {
      exitCode = await Promise.race([Promise.all([process.exit, output]).then(([code]) => code), timedOut, aborted]);
    } finally {
      if (timeout) clearTimeout(timeout);
      await this.flushPendingWrites();
      if (request.kind !== "javascript" && isDependencyMutationCommand(request.source)) this.dependencySnapshotDirty = true;
      await this.flushDependencySnapshot();
    }
    runtimeLog.info("Runtime 命令结束", { kind: request.kind, command, exitCode, outputBytes: stdout.length });
    return { exitCode, stdout, stderr: exitCode === 0 ? "" : stdout };
  }

  async startInteractive(onOutput: (data: string) => void, dimensions: TerminalDimensions): Promise<InteractiveRuntimeSession> {
    const container = this.requireContainer();
    this.shell?.kill();
    this.shellWriter?.releaseLock();
    await this.flushDependencySnapshot();
    this.shell = await container.spawn("jsh", { cwd: ".", terminal: dimensions, env: runtimePackageEnvironment(container.workdir) });
    runtimeLog.info("交互式 jsh 已启动", { cwd: "/workspace", columns: dimensions.cols, rows: dimensions.rows });
    const process = this.shell;
    this.shellWriter = process.input.getWriter();
    void process.output.pipeTo(new WritableStream({ write: onOutput })).catch((error) => {
      runtimeLog.error("交互式 jsh 输出流失败", undefined, error);
      onOutput(`\r\n[Runtime] ${errorMessage(error)}\r\n`);
    });
    return {
      id: crypto.randomUUID(),
      workingDirectory: "/workspace",
      write: async (data) => { await this.shellWriter?.write(data); },
      resize: (next) => process.resize(next),
      kill: () => { runtimeLog.info("交互式 jsh 已终止"); process.kill(); }
    };
  }

  async disconnect(): Promise<void> {
    this.shell?.kill();
    this.shell = undefined;
    this.shellWriter?.releaseLock();
    this.shellWriter = undefined;
    await this.flushDependencySnapshot();
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
    this.watcher?.close();
    this.watcher = undefined;
    this.container = undefined;
    this.fileService = undefined;
    runtimeLog.debug("已断开项目 Runtime；共享 WebContainer 实例继续复用");
  }

  private async restoreDependencySnapshot(): Promise<boolean> {
    if (!this.fileService || !this.container || !(await this.fileService.exists(BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT))) return false;
    try {
      const snapshot = (await this.fileService.read(BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT)).data;
      await this.container.mount({ node_modules: { directory: await decodeDependencySnapshot(snapshot) } });
      await restorePackageBinPermissions(this.container);
      runtimeLog.info("已恢复项目持久依赖快照", { projectId: this.fileService.projectId, bytes: snapshot.byteLength });
      return true;
    } catch (error) {
      runtimeLog.error("恢复项目持久依赖快照失败", { projectId: this.fileService.projectId, path: BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT }, error);
      this.onEvent?.({ kind: "error", path: BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT, message: `依赖快照恢复失败：${errorMessage(error)}` });
      return false;
    }
  }

  private scheduleDependencySnapshot(): void {
    this.dependencySnapshotDirty = true;
    if (this.dependencySnapshotTimer) clearTimeout(this.dependencySnapshotTimer);
    this.dependencySnapshotTimer = setTimeout(() => { this.dependencySnapshotTimer = undefined; void this.flushDependencySnapshot(); }, 800);
  }

  private async flushDependencySnapshot(): Promise<void> {
    if (this.dependencySnapshotTimer) { clearTimeout(this.dependencySnapshotTimer); this.dependencySnapshotTimer = undefined; }
    if (this.dependencySnapshotPromise) await this.dependencySnapshotPromise;
    if (!this.dependencySnapshotDirty || !this.fileService || !this.container) return;
    this.dependencySnapshotDirty = false;
    const fileService = this.fileService;
    const container = this.container;
    this.dependencySnapshotPromise = (async () => {
      try {
        const snapshot = await encodeDependencySnapshot(await container.export("node_modules", { format: "json" }));
        await fileService.write(BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT, snapshot, { source: "terminal" });
        runtimeLog.info("已保存项目持久依赖快照", { projectId: fileService.projectId, bytes: snapshot.byteLength });
      } catch (error) {
        if (isMissing(error)) {
          if (await fileService.exists(BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT)) await fileService.delete(BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT, "terminal");
          runtimeLog.info("Runtime 中已无 node_modules，已清理持久依赖快照", { projectId: fileService.projectId });
        } else {
          runtimeLog.error("保存项目持久依赖快照失败", { projectId: fileService.projectId }, error);
          this.onEvent?.({ kind: "error", path: BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT, message: `依赖快照保存失败：${errorMessage(error)}` });
        }
      }
    })().finally(() => { this.dependencySnapshotPromise = undefined; });
    await this.dependencySnapshotPromise;
    if (this.dependencySnapshotDirty) await this.flushDependencySnapshot();
  }

  private async syncRuntimePath(sourcePath: string, storagePath = sourcePath): Promise<void> {
    if (!this.fileService || !this.container || isRuntimeIgnoredPath(sourcePath)) return;
    const source = runtimeFsPath(sourcePath);
    try {
      const data = await this.container.fs.readFile(source);
      await this.fileService.write(storagePath, data, { source: "terminal" });
      runtimeLog.debug("Runtime 文件已写回真实目录", { projectId: this.fileService.projectId, sourcePath, storagePath, bytes: data.byteLength });
      if (!isBrowserAgentPackagePath(storagePath)) this.onEvent?.({ kind: "sync", path: storagePath, message: `终端已写入真实项目：${storagePath}` });
      return;
    } catch (error) {
      if (!isMissing(error) && !/EISDIR/i.test(errorMessage(error))) {
        runtimeLog.error("读取 Runtime 文件失败", { projectId: this.fileService.projectId, sourcePath, storagePath }, error);
        this.onEvent?.({ kind: "error", path: storagePath, message: errorMessage(error) });
        return;
      }
    }
    try {
      const children = await this.container.fs.readdir(source, { withFileTypes: true });
      await this.fileService.ensureDirectory(storagePath);
      for (const child of children) {
        const childSource = `${sourcePath}/${child.name}`.replace(/\/+/g, "/");
        const childStorage = `${storagePath}/${child.name}`.replace(/\/+/g, "/");
        await this.syncRuntimePath(childSource, childStorage);
      }
    } catch (error) {
      if (await this.fileService.exists(storagePath)) await this.fileService.delete(storagePath, "terminal");
      else if (!isMissing(error)) {
        runtimeLog.error("同步 Runtime 目录或删除操作失败", { projectId: this.fileService.projectId, sourcePath, storagePath }, error);
        this.onEvent?.({ kind: "error", path: storagePath, message: errorMessage(error) });
      }
    }
  }

  private trackRuntimeSync(path: string): Promise<void> {
    const operation = this.syncRuntimePath(path);
    this.activeRuntimeSyncs.add(operation);
    void operation.then(
      () => this.activeRuntimeSyncs.delete(operation),
      () => this.activeRuntimeSyncs.delete(operation)
    );
    return operation;
  }

  private requireContainer(): WebContainer {
    if (!this.container) throw new Error("WebContainer 尚未连接项目。 ");
    return this.container;
  }

  private suppress(path: string): void { this.suppressed.set(path, Date.now() + 700); }
  private isSuppressed(path: string): boolean {
    const until = this.suppressed.get(path) ?? 0;
    if (until < Date.now()) { this.suppressed.delete(path); return false; }
    return true;
  }
}

export class WebContainerRuntimeProvider implements ScriptRuntimeProvider {
  readonly id = "runtime.webcontainer";
  constructor(readonly mirror: WorkspaceMirror) {}
  available(): Promise<boolean> { return this.mirror.available(); }
  async start(): Promise<RuntimeSession> {
    if (!this.mirror.ready) throw new Error("请先连接项目目录。 ");
    return { id: crypto.randomUUID(), workingDirectory: "/workspace" };
  }
  execute(_session: RuntimeSession, request: ScriptExecutionRequest): Promise<ScriptExecutionResult> { return this.mirror.execute(request); }
  startInteractive(onOutput: (data: string) => void, dimensions: TerminalDimensions): Promise<InteractiveRuntimeSession> { return this.mirror.startInteractive(onOutput, dimensions); }
  async terminate(_session?: RuntimeSession): Promise<void> { await this.mirror.disconnect(); }
  limitations(): string[] {
    return [
      "这是特殊 WebContainer jsh，不是 Windows PowerShell、CMD、宿主 Linux Bash 或完整操作系统",
      "逻辑项目根目录是 /workspace；不存在可供 Agent 使用的宿主绝对路径",
      "只保证 Node.js、npm 和纯 JavaScript",
      `npm/pnpm/yarn 下载缓存持久化到 ${BROWSER_AGENT_PACKAGE_DIRECTORY}`,
      `已安装的纯 JavaScript 依赖持久化到 ${BROWSER_AGENT_INSTALLED_PACKAGE_DIRECTORY}，新终端和重新挂载后可直接使用`,
      "不支持 Python/python3/pip/conda、EXE、Docker、PowerShell 和原生二进制扩展",
      inspectWebContainerSupport().supported ? "当前浏览器已满足跨源隔离要求" : "当前浏览器上下文不支持 WebContainer"
    ];
  }
}

export function shouldMirrorPath(path: string): boolean { return path !== BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT && !isRuntimeIgnoredPath(path); }

async function sharedWebContainer(): Promise<WebContainer> {
  const runtimeGlobal = globalThis as RuntimeGlobal;
  const state = runtimeGlobal.__agentCodexWebContainer ??= {};
  if (state.container) {
    runtimeLog.debug("复用页面内已有 WebContainer 实例", { workdir: state.container.workdir });
    return state.container;
  }
  if (state.bootError) {
    runtimeLog.warn("已阻止同一页面重复调用失败的 WebContainer.boot", { errorMessage: state.bootError.message });
    throw state.bootError;
  }
  if (state.bootPromise) {
    runtimeLog.debug("复用正在启动的 WebContainer Promise");
    return state.bootPromise;
  }
  const coep = "credentialless" as const;
  runtimeLog.info("创建页面级 WebContainer 单例", { coep, isolated: inspectWebContainerSupport().crossOriginIsolated });
  const { WebContainer: WebContainerApi } = await import("@webcontainer/api");
  state.bootPromise = WebContainerApi.boot({ coep, workdirName: "workspace", forwardPreviewErrors: "exceptions-only" })
    .then((container) => {
      state.container = container;
      runtimeLog.info("WebContainer 单例启动完成", { workdir: container.workdir, coep });
      return container;
    })
    .catch((error) => {
      delete state.bootPromise;
      state.bootError = new Error(`${errorMessage(error)}。本页面不会再次调用 WebContainer.boot；请完整刷新页面后重试。`);
      runtimeLog.error("WebContainer 单例启动 Promise 失败，已锁定本页面后续重试", { coep }, error);
      throw state.bootError;
    });
  return state.bootPromise;
}

async function clearRuntimeWorkspace(container: WebContainer): Promise<void> {
  const entries = await container.fs.readdir("/");
  if (entries.length) runtimeLog.debug("清理上一个项目的 Runtime 挂载内容", { entries: entries.length });
  await Promise.all(entries.map((entry) => container.fs.rm(`/${entry}`, { recursive: true, force: true })));
}

async function buildFileSystemTree(fileService: ProjectFileService, entries: ProjectFileEntry[]): Promise<FileSystemTree> {
  const tree: FileSystemTree = {};
  const projectEntries = entries.filter((entry) => !isBrowserAgentPackagePath(entry.path));
  const packageEntries = entries.filter((entry) => isBrowserAgentPackagePath(entry.path));
  await insertEntriesWithBudget(fileService, tree, projectEntries, 8_000_000, 80_000_000, "项目文件");
  await insertEntriesWithBudget(fileService, tree, packageEntries, 64_000_000, 512_000_000, "安装包下载缓存");
  return tree;
}

async function insertEntriesWithBudget(fileService: ProjectFileService, tree: FileSystemTree, entries: ProjectFileEntry[], maxFileBytes: number, maxTotalBytes: number, label: string): Promise<void> {
  let total = 0;
  let skipped = 0;
  for (const entry of entries) {
    const size = entry.size ?? 0;
    if (entry.kind !== "file" || !shouldMirrorPath(entry.path)) continue;
    if (size > maxFileBytes || total + size > maxTotalBytes) { skipped += 1; continue; }
    const data = (await fileService.read(entry.path)).data;
    total += data.byteLength;
    insertFile(tree, entry.path, data);
  }
  if (skipped) runtimeLog.warn(`${label}超出 Runtime 初始挂载预算`, { skipped, mountedBytes: total, maxFileBytes, maxTotalBytes });
}

function insertFile(tree: FileSystemTree, path: string, data: Uint8Array): void {
  const parts = path.replace(/^\/+/, "").split("/");
  const name = parts.pop();
  if (!name) return;
  let directory = tree;
  for (const part of parts) {
    const existing = directory[part];
    if (existing && "directory" in existing) directory = existing.directory;
    else { const node: { directory: FileSystemTree } = { directory: {} }; directory[part] = node; directory = node.directory; }
  }
  directory[name] = { file: { contents: data } };
}

function insertDirectory(tree: FileSystemTree, path: string): void {
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  let directory = tree;
  for (const part of parts) {
    const existing = directory[part];
    if (existing && "directory" in existing) directory = existing.directory;
    else { const node: { directory: FileSystemTree } = { directory: {} }; directory[part] = node; directory = node.directory; }
  }
}

function parentPath(path: string): string { return path.slice(0, Math.max(1, path.lastIndexOf("/"))); }
async function restorePackageBinPermissions(container: WebContainer): Promise<void> {
  const source = "const fs=require('node:fs');const path=require('node:path');const dir='node_modules/.bin';if(fs.existsSync(dir))for(const name of fs.readdirSync(dir))try{fs.chmodSync(path.join(dir,name),0o755)}catch{}";
  const process = await container.spawn("node", ["-e", source], { cwd: "." });
  const output = process.output.pipeTo(new WritableStream({ write() {} }));
  const [exitCode] = await Promise.all([process.exit, output]);
  if (exitCode !== 0) runtimeLog.warn("恢复依赖命令执行权限失败", { exitCode });
}
function isMissing(error: unknown): boolean { return /ENOENT|not.?found|不存在/i.test(errorMessage(error)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
