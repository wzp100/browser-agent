import type { BrowserDirectoryHandle, BrowserFileHandle } from "./index";
import { logger } from "../../logging/src/index";

const fileLog = logger("workspace.files");

export const BROWSER_AGENT_DIRECTORY = "/.browser-agent";
export const BROWSER_AGENT_STATE_DIRECTORY = `${BROWSER_AGENT_DIRECTORY}/state`;
export const BROWSER_AGENT_LOG_DIRECTORY = `${BROWSER_AGENT_DIRECTORY}/logs`;
export const BROWSER_AGENT_RUNS_DIRECTORY = `${BROWSER_AGENT_STATE_DIRECTORY}/runs`;
export const BROWSER_AGENT_PACKAGE_DIRECTORY = `${BROWSER_AGENT_DIRECTORY}/packages`;
export const BROWSER_AGENT_INSTALLED_PACKAGE_DIRECTORY = `${BROWSER_AGENT_PACKAGE_DIRECTORY}/installed`;
export const BROWSER_AGENT_INSTALLED_PACKAGE_SNAPSHOT = `${BROWSER_AGENT_INSTALLED_PACKAGE_DIRECTORY}/node-modules.snapshot`;

export function browserAgentRunDirectory(runId: string): string {
  return `${BROWSER_AGENT_RUNS_DIRECTORY}/${normalizeRunId(runId)}`;
}

export function browserAgentRunScratchDirectory(runId: string): string {
  return `${browserAgentRunDirectory(runId)}/scratch`;
}

export interface ProjectFileEntry {
  path: string;
  kind: "file" | "directory";
  size?: number;
  lastModified?: number;
  fingerprint?: string;
}

export interface ProjectFileChange {
  path: string;
  type: "create" | "modify" | "delete" | "move" | "external";
  at: string;
  source: "agent" | "terminal" | "external";
}

export interface ProjectFileBackup {
  id: string;
  projectId: string;
  path: string;
  operation: ProjectFileChange["type"];
  createdAt: string;
  bytes: number;
}

export interface RecoveryBackupPayload { record: ProjectFileBackup; data: Uint8Array; }

export type ChangeSetStatus = "active" | "completed" | "failed" | "cancelled" | "interrupted" | "restored";

export interface ChangeSetChange {
  id: string;
  runId: string;
  type: "create" | "modify" | "delete" | "move";
  path: string;
  targetPath?: string;
  kind: "file" | "directory";
  beforeFingerprint?: string;
  afterFingerprint?: string;
  backupRef?: string;
  targetBeforeFingerprint?: string;
  targetBackupRef?: string;
  createdAt: string;
}

export interface ChangeSet {
  id: string;
  projectId: string;
  runId: string;
  status: ChangeSetStatus;
  changes: ChangeSetChange[];
  createdAt: string;
  updatedAt: string;
}

export interface RestoreOptions { force?: boolean; }

export interface ChangePreview {
  change: ChangeSetChange;
  before: Uint8Array;
  after: Uint8Array;
}

export class ChangeSetConflictError extends Error {
  constructor(readonly path: string, readonly expected: string | undefined, readonly actual: string | undefined) {
    super(`路径“${path}”在运行结束后已被修改，恢复操作已停止。`);
    this.name = "ChangeSetConflictError";
  }
}

export class WorkspaceConflictError extends Error {
  constructor(readonly path: string, readonly expected: string | undefined, readonly actual: string | undefined) {
    super(`文件“${path}”在读取后已被外部修改，已停止覆盖。`);
    this.name = "WorkspaceConflictError";
  }
}

export interface ChangeJournal {
  backup(projectId: string, path: string, operation: ProjectFileChange["type"], data?: Uint8Array): Promise<ProjectFileBackup>;
  beginRun?(projectId: string, runId: string): Promise<ChangeSet>;
  appendChange?(projectId: string, runId: string, change: ChangeSetChange): Promise<void>;
  endRun?(projectId: string, runId: string, status: Exclude<ChangeSetStatus, "active">): Promise<ChangeSet>;
  list?(projectId: string): Promise<ChangeSet[]>;
  read?(projectId: string, runId: string): Promise<ChangeSet | undefined>;
  readBackup?(projectId: string, backupRef: string): Promise<Uint8Array>;
  importRecovery?(projectId: string, changeSets: ChangeSet[], backups: RecoveryBackupPayload[]): Promise<void>;
}

export class OpfsChangeJournal implements ChangeJournal {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly changeSetQueues = new Map<string, Promise<unknown>>();

  async backup(projectId: string, path: string, operation: ProjectFileChange["type"], data = new Uint8Array()): Promise<ProjectFileBackup> {
    const record: ProjectFileBackup = { id: crypto.randomUUID(), projectId, path, operation, createdAt: new Date().toISOString(), bytes: data.byteLength };
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) throw new Error("当前浏览器不支持 OPFS，无法在修改真实文件前创建恢复记录。 ");
    const root = await navigator.storage.getDirectory();
    const backups = await root.getDirectoryHandle("agent-runtime-backups", { create: true });
    const project = await backups.getDirectoryHandle(safeSegment(projectId), { create: true });
    const meta = await project.getFileHandle(`${record.id}.json`, { create: true });
    const metaWriter = await meta.createWritable();
    await metaWriter.write(this.encoder.encode(JSON.stringify(record)));
    await metaWriter.close();
    if (data.byteLength) {
      const content = await project.getFileHandle(`${record.id}.bin`, { create: true });
      const writer = await content.createWritable();
      await writer.write(data);
      await writer.close();
    }
    return record;
  }

  async beginRun(projectId: string, runId: string): Promise<ChangeSet> {
    const normalizedRunId = normalizeRunId(runId);
    const existing = await this.read(projectId, normalizedRunId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const changeSet: ChangeSet = { id: crypto.randomUUID(), projectId, runId: normalizedRunId, status: "active", changes: [], createdAt: now, updatedAt: now };
    await this.writeChangeSet(changeSet);
    return changeSet;
  }

  appendChange(projectId: string, runId: string, change: ChangeSetChange): Promise<void> {
    return this.enqueueChangeSet(projectId, runId, async () => {
      const changeSet = await this.beginRun(projectId, runId);
      changeSet.changes.push(change);
      changeSet.updatedAt = new Date().toISOString();
      await this.writeChangeSet(changeSet);
    });
  }

  endRun(projectId: string, runId: string, status: Exclude<ChangeSetStatus, "active">): Promise<ChangeSet> {
    return this.enqueueChangeSet(projectId, runId, async () => {
      const changeSet = await this.beginRun(projectId, runId);
      changeSet.status = status;
      changeSet.updatedAt = new Date().toISOString();
      await this.writeChangeSet(changeSet);
      return changeSet;
    });
  }

  async list(projectId: string): Promise<ChangeSet[]> {
    let directory: FileSystemDirectoryHandle;
    try { directory = await this.changeSetDirectory(projectId, false); }
    catch (error) { if (isNotFound(error)) return []; throw error; }
    const values: ChangeSet[] = [];
    const iterable = directory as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle> };
    for await (const entry of iterable.values()) {
      if (entry.kind !== "file" || !entry.name.endsWith(".json")) continue;
      try { values.push(await this.readChangeSetFile(entry)); } catch { /* 损坏记录不会阻断其他运行的恢复。 */ }
    }
    return values.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async read(projectId: string, runId: string): Promise<ChangeSet | undefined> {
    const normalizedRunId = normalizeRunId(runId);
    try {
      const directory = await this.changeSetDirectory(projectId, false);
      const handle = await directory.getFileHandle(`${normalizedRunId}.json`);
      const changeSet = await this.readChangeSetFile(handle);
      return changeSet.runId === normalizedRunId ? changeSet : undefined;
    } catch (error) { if (isNotFound(error)) return undefined; throw error; }
  }

  async readBackup(projectId: string, backupRef: string): Promise<Uint8Array> {
    const project = await this.projectDirectory(projectId, false);
    let metadata: ProjectFileBackup;
    try {
      const metaHandle = await project.getFileHandle(`${safeSegment(backupRef)}.json`);
      const metaData = new Uint8Array(await (await metaHandle.getFile()).arrayBuffer());
      metadata = JSON.parse(this.decoder.decode(metaData)) as ProjectFileBackup;
    } catch (error) {
      if (isNotFound(error)) throw new Error(`找不到内容备份“${backupRef}”。`);
      throw error;
    }
    if (metadata.id !== backupRef) throw new Error(`内容备份“${backupRef}”的元数据不匹配。`);
    if (metadata.bytes === 0) return new Uint8Array();
    try {
      const handle = await project.getFileHandle(`${safeSegment(backupRef)}.bin`);
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (isNotFound(error)) throw new Error(`内容备份“${backupRef}”不完整。`);
      throw error;
    }
  }

  async importRecovery(projectId: string, changeSets: ChangeSet[], backups: RecoveryBackupPayload[]): Promise<void> {
    const project = await this.projectDirectory(projectId, true);
    for (const { record, data } of backups) {
      if (record.projectId !== projectId || record.bytes !== data.byteLength) throw new Error(`恢复备份“${record.id}”与项目或大小不匹配。`);
      const safeId = safeSegment(record.id);
      const meta = await project.getFileHandle(`${safeId}.json`, { create: true });
      const metaWriter = await meta.createWritable();
      await metaWriter.write(this.encoder.encode(JSON.stringify(record)));
      await metaWriter.close();
      if (data.byteLength) {
        const content = await project.getFileHandle(`${safeId}.bin`, { create: true });
        const writer = await content.createWritable();
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        await writer.write(copy);
        await writer.close();
      }
    }
    for (const changeSet of changeSets) {
      if (changeSet.projectId !== projectId) throw new Error("导入的 ChangeSet 不属于目标项目。 ");
      await this.writeChangeSet(changeSet.status === "active" ? { ...changeSet, status: "interrupted", updatedAt: new Date().toISOString() } : changeSet);
    }
  }

  private async writeChangeSet(changeSet: ChangeSet): Promise<void> {
    const directory = await this.changeSetDirectory(changeSet.projectId, true);
    const handle = await directory.getFileHandle(`${normalizeRunId(changeSet.runId)}.json`, { create: true });
    const writer = await handle.createWritable();
    await writer.write(this.encoder.encode(JSON.stringify(changeSet)));
    await writer.close();
  }

  private async readChangeSetFile(handle: FileSystemFileHandle): Promise<ChangeSet> {
    const data = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    return JSON.parse(this.decoder.decode(data)) as ChangeSet;
  }

  private async projectDirectory(projectId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) throw new Error("当前浏览器不支持 OPFS，无法读取恢复记录。 ");
    const root = await navigator.storage.getDirectory();
    const backups = await root.getDirectoryHandle("agent-runtime-backups", { create });
    return backups.getDirectoryHandle(safeSegment(projectId), { create });
  }

  private async changeSetDirectory(projectId: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    const project = await this.projectDirectory(projectId, create);
    return project.getDirectoryHandle("change-sets", { create });
  }

  private enqueueChangeSet<T>(projectId: string, runId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${projectId}\u0000${runId}`;
    const previous = this.changeSetQueues.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const tracked = current.then(() => undefined, () => undefined).finally(() => { if (this.changeSetQueues.get(key) === tracked) this.changeSetQueues.delete(key); });
    this.changeSetQueues.set(key, tracked);
    return current;
  }
}

export type ProjectFileEventHandler = (change: ProjectFileChange) => void | Promise<void>;

export class ProjectFileService {
  private readonly fingerprints = new Map<string, string>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private activeRunId: string | undefined;
  private journalSuppression = 0;

  constructor(
    readonly projectId: string,
    private readonly root: BrowserDirectoryHandle,
    private readonly journal: ChangeJournal = new OpfsChangeJournal(),
    private readonly onChange?: ProjectFileEventHandler
  ) {}

  setActiveRun(runId: string | undefined): void {
    this.activeRunId = runId === undefined ? undefined : normalizeRunId(runId);
  }

  async beginRun(runId: string): Promise<ChangeSet> {
    const normalizedRunId = normalizeRunId(runId);
    if (!this.journal.beginRun) throw new Error("当前恢复日志不支持运行级 ChangeSet。 ");
    const changeSet = await this.journal.beginRun(this.projectId, normalizedRunId);
    this.activeRunId = normalizedRunId;
    return changeSet;
  }

  async endRun(status: Exclude<ChangeSetStatus, "active"> = "completed"): Promise<ChangeSet | undefined> {
    const runId = this.activeRunId;
    if (!runId) return undefined;
    this.activeRunId = undefined;
    return this.journal.endRun?.(this.projectId, runId, status);
  }

  async listChangeSets(): Promise<ChangeSet[]> { return this.journal.list?.(this.projectId) ?? []; }
  async readChangeSet(runId: string): Promise<ChangeSet | undefined> { return this.journal.read?.(this.projectId, normalizeRunId(runId)); }
  async interruptActiveChangeSets(): Promise<number> {
    if (!this.journal.list || !this.journal.endRun) return 0;
    const active = (await this.journal.list(this.projectId)).filter((changeSet) => changeSet.status === "active");
    for (const changeSet of active) await this.journal.endRun(this.projectId, changeSet.runId, "interrupted");
    return active.length;
  }

  async previewChange(runId: string, changeId: string): Promise<ChangePreview> {
    const changeSet = await this.requireChangeSet(runId);
    const change = changeSet.changes.find((item) => item.id === changeId);
    if (!change) throw new Error(`ChangeSet 中不存在变更：${changeId}`);
    const before = change.backupRef && this.journal.readBackup ? await this.journal.readBackup(this.projectId, change.backupRef) : new Uint8Array();
    const afterPath = change.type === "move" ? change.targetPath : change.type === "delete" ? undefined : change.path;
    let after: Uint8Array = new Uint8Array();
    if (afterPath && await this.exists(afterPath)) {
      try { after = (await this.read(afterPath)).data; }
      catch (error) { if (!isTypeMismatch(error)) throw error; }
    }
    return { change, before, after };
  }

  async exportRecoveryBackups(): Promise<RecoveryBackupPayload[]> {
    if (!this.journal.readBackup) return [];
    const references = new Map<string, { path: string; operation: ProjectFileChange["type"] }>();
    for (const changeSet of await this.listChangeSets()) {
      for (const change of changeSet.changes) {
        if (change.backupRef) references.set(change.backupRef, { path: change.path, operation: change.type });
        if (change.targetBackupRef) references.set(change.targetBackupRef, { path: change.targetPath ?? change.path, operation: "modify" });
      }
    }
    const payloads: RecoveryBackupPayload[] = [];
    for (const [id, metadata] of references) {
      const data = await this.journal.readBackup(this.projectId, id);
      payloads.push({ record: { id, projectId: this.projectId, path: metadata.path, operation: metadata.operation, createdAt: new Date().toISOString(), bytes: data.byteLength }, data });
    }
    return payloads;
  }

  async importRecovery(changeSets: ChangeSet[], backups: RecoveryBackupPayload[]): Promise<void> {
    if (!this.journal.importRecovery) throw new Error("当前恢复日志不支持导入。 ");
    await this.journal.importRecovery(this.projectId, changeSets, backups);
  }

  async restoreChange(runId: string, changeId: string, options: RestoreOptions = {}): Promise<void> {
    const changeSet = await this.requireChangeSet(runId);
    const change = changeSet.changes.find((candidate) => candidate.id === changeId);
    if (!change) throw new Error(`运行“${runId}”中不存在恢复项“${changeId}”。`);
    if (!options.force) await this.assertChangeAfterState(change);
    await this.withJournalSuppressed(() => this.restoreChangeUnchecked(change));
  }

  async restoreRun(runId: string, options: RestoreOptions = {}): Promise<ChangeSet> {
    const changeSet = await this.requireChangeSet(runId);
    if (!options.force) await this.assertRunFinalState(changeSet);
    await this.withJournalSuppressed(async () => {
      for (const change of [...changeSet.changes].reverse()) await this.restoreChangeUnchecked(change);
    });
    if (this.activeRunId === changeSet.runId) this.activeRunId = undefined;
    return await this.journal.endRun?.(this.projectId, changeSet.runId, "restored") ?? { ...changeSet, status: "restored", updatedAt: new Date().toISOString() };
  }

  async captureBaseline(): Promise<ProjectFileEntry[]> {
    const entries = await this.list("/");
    this.fingerprints.clear();
    for (const entry of entries) if (entry.fingerprint && !isWorkspaceInternalMetadataPath(entry.path)) this.fingerprints.set(entry.path, entry.fingerprint);
    fileLog.info("项目文件基线已捕获", { projectId: this.projectId, files: entries.filter((entry) => entry.kind === "file").length, directories: entries.filter((entry) => entry.kind === "directory").length });
    return entries;
  }

  async list(path = "/"): Promise<ProjectFileEntry[]> {
    const directory = path === "/" ? this.root : await this.directoryHandle(path, false);
    const entries: ProjectFileEntry[] = [];
    await this.walk(directory, normalizeDirectory(path), entries);
    fileLog.debug("项目目录已列出", { projectId: this.projectId, path, entries: entries.length });
    return entries;
  }

  async read(path: string): Promise<{ data: Uint8Array; fingerprint: string }> {
    const normalized = normalizeFilePath(path);
    const file = await this.getFile(normalized);
    const fingerprint = fileFingerprint(file);
    this.fingerprints.set(normalized, fingerprint);
    const data = new Uint8Array(await file.arrayBuffer());
    fileLog.debug("项目文件已读取", { projectId: this.projectId, path: normalized, bytes: data.byteLength });
    return { data, fingerprint };
  }

  async getFile(path: string): Promise<File> {
    const normalized = normalizeFilePath(path);
    return (await this.fileHandle(normalized, false)).getFile();
  }

  async readText(path: string): Promise<{ content: string; fingerprint: string }> {
    const result = await this.read(path);
    return { content: this.decoder.decode(result.data), fingerprint: result.fingerprint };
  }

  async write(path: string, data: Uint8Array, options: { expectedFingerprint?: string; source?: ProjectFileChange["source"] } = {}): Promise<string> {
    const normalized = normalizeFilePath(path);
    const existing = await this.tryRead(normalized);
    if (options.expectedFingerprint !== undefined && existing?.fingerprint !== options.expectedFingerprint) {
      fileLog.warn("项目文件写入发生指纹冲突", { projectId: this.projectId, path: normalized, source: options.source ?? "agent", expectedFingerprint: options.expectedFingerprint, actualFingerprint: existing?.fingerprint });
      throw new WorkspaceConflictError(normalized, options.expectedFingerprint, existing?.fingerprint);
    }
    const internal = isWorkspaceInternalMetadataPath(normalized);
    const shouldJournal = !internal && this.journalSuppression === 0;
    if (shouldJournal) await this.ensureActiveChangeSet();
    const backup = shouldJournal ? await this.journal.backup(this.projectId, normalized, existing ? "modify" : "create", existing?.data) : undefined;
    const { parent, name } = await this.parent(normalized, true);
    const handle = await parent.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
    const fingerprint = (await this.read(normalized)).fingerprint;
    if (!internal) await this.emit({ path: normalized, type: existing ? "modify" : "create", at: new Date().toISOString(), source: options.source ?? "agent" });
    if (shouldJournal) await this.recordActiveChange({
      type: existing ? "modify" : "create",
      path: normalized,
      kind: "file",
      ...(existing ? { beforeFingerprint: existing.fingerprint } : {}),
      afterFingerprint: fingerprint,
      ...(backup ? { backupRef: backup.id } : {})
    });
    fileLog.info("项目文件已写入", { projectId: this.projectId, path: normalized, bytes: data.byteLength, operation: existing ? "modify" : "create", source: options.source ?? "agent" });
    return fingerprint;
  }

  writeText(path: string, content: string, options?: { expectedFingerprint?: string; source?: ProjectFileChange["source"] }): Promise<string> {
    return this.write(path, this.encoder.encode(content), options);
  }

  /** 仅供 .browser-agent 内部追加型文件使用；真实 File System Access 流可原位追加，避免反复重写日志。 */
  async appendInternalText(path: string, content: string): Promise<void> {
    const normalized = normalizeFilePath(path);
    if (!isWorkspaceInternalMetadataPath(normalized)) throw new Error("appendInternalText 只能写入 .browser-agent 内部路径。 ");
    const { parent, name } = await this.parent(normalized, true);
    const handle = await parent.getFileHandle(name, { create: true });
    const existing = await handle.getFile();
    const writable = await handle.createWritable({ keepExistingData: true });
    if (writable.seek) {
      await writable.seek(existing.size);
      await writable.write(this.encoder.encode(content));
    } else {
      const previous = new Uint8Array(await existing.arrayBuffer());
      const addition = this.encoder.encode(content);
      const combined = new Uint8Array(previous.byteLength + addition.byteLength);
      combined.set(previous);
      combined.set(addition, previous.byteLength);
      await writable.write(combined);
    }
    await writable.close();
  }

  async applyPatch(path: string, edits: Array<{ search: string; replace: string }>, expectedFingerprint?: string): Promise<{ fingerprint: string; replacements: number }> {
    const current = await this.readText(path);
    if (expectedFingerprint !== undefined && current.fingerprint !== expectedFingerprint) throw new WorkspaceConflictError(path, expectedFingerprint, current.fingerprint);
    let content = current.content;
    let replacements = 0;
    for (const edit of edits) {
      if (!edit.search) throw new Error("apply_patch 的 search 不能为空。 ");
      const index = content.indexOf(edit.search);
      if (index < 0) throw new Error(`在“${path}”中找不到待替换内容。`);
      if (content.indexOf(edit.search, index + edit.search.length) >= 0) throw new Error(`“${path}”中的待替换内容不唯一。`);
      content = `${content.slice(0, index)}${edit.replace}${content.slice(index + edit.search.length)}`;
      replacements += 1;
    }
    const fingerprint = await this.writeText(path, content, { expectedFingerprint: current.fingerprint });
    fileLog.info("项目补丁已应用", { projectId: this.projectId, path, replacements });
    return { fingerprint, replacements };
  }

  async mkdir(path: string, source: ProjectFileChange["source"] = "agent"): Promise<void> {
    const normalized = normalizeFilePath(path);
    const existed = await this.exists(normalized);
    const shouldJournal = !existed && !isWorkspaceInternalMetadataPath(normalized) && this.journalSuppression === 0;
    if (shouldJournal) await this.ensureActiveChangeSet();
    await this.directoryHandle(normalized, true);
    if (!isWorkspaceInternalMetadataPath(normalized)) await this.emit({ path: normalized, type: "create", at: new Date().toISOString(), source });
    if (shouldJournal) await this.recordActiveChange({ type: "create", path: normalized, kind: "directory" });
    fileLog.info("项目目录已创建", { projectId: this.projectId, path: normalized, source });
  }

  /** 创建 Agent 自用目录，但不把初始化动作计入用户任务产物。 */
  async ensureDirectory(path: string): Promise<boolean> {
    const normalized = normalizeFilePath(path);
    const existed = await this.exists(normalized);
    if (!existed) await this.directoryHandle(normalized, true);
    fileLog.info("项目级 Browser Agent 目录已就绪", { projectId: this.projectId, path: normalized, created: !existed });
    return !existed;
  }

  async move(from: string, to: string, source: ProjectFileChange["source"] = "agent"): Promise<void> {
    const sourcePath = normalizeFilePath(from);
    const targetPath = normalizeFilePath(to);
    const data = await this.read(sourcePath);
    const target = await this.tryRead(targetPath);
    const internal = isWorkspaceInternalMetadataPath(sourcePath) || isWorkspaceInternalMetadataPath(targetPath);
    const shouldJournal = !internal && this.journalSuppression === 0;
    if (shouldJournal) await this.ensureActiveChangeSet();
    const sourceBackup = shouldJournal ? await this.journal.backup(this.projectId, sourcePath, "move", data.data) : undefined;
    const targetBackup = shouldJournal && target ? await this.journal.backup(this.projectId, targetPath, "modify", target.data) : undefined;
    this.journalSuppression += 1;
    let targetFingerprint: string;
    try {
      targetFingerprint = await this.write(targetPath, data.data, { source });
      await this.delete(sourcePath, source);
    } finally { this.journalSuppression -= 1; }
    if (!internal) await this.emit({ path: `${sourcePath} → ${targetPath}`, type: "move", at: new Date().toISOString(), source });
    if (shouldJournal) await this.recordActiveChange({
      type: "move",
      path: sourcePath,
      targetPath,
      kind: "file",
      beforeFingerprint: data.fingerprint,
      afterFingerprint: targetFingerprint,
      ...(sourceBackup ? { backupRef: sourceBackup.id } : {}),
      ...(target ? { targetBeforeFingerprint: target.fingerprint } : {}),
      ...(targetBackup ? { targetBackupRef: targetBackup.id } : {})
    });
    fileLog.info("项目文件已移动", { projectId: this.projectId, from: sourcePath, to: targetPath, source });
  }

  async delete(path: string, source: ProjectFileChange["source"] = "agent"): Promise<void> {
    const normalized = normalizeFilePath(path);
    const recoverable = !isWorkspaceInternalMetadataPath(normalized);
    const shouldJournal = recoverable && this.journalSuppression === 0;
    if (shouldJournal) await this.ensureActiveChangeSet();
    let existing: { data: Uint8Array; fingerprint: string } | undefined;
    const deletedFiles: Array<{ path: string; fingerprint: string; backupRef: string }> = [];
    const deletedDirectories: string[] = [];
    try { existing = await this.tryRead(normalized); }
    catch (error) {
      if (!isTypeMismatch(error)) throw error;
      if (shouldJournal) {
        deletedDirectories.push(normalized);
        for (const entry of await this.list(normalized)) {
          if (entry.kind === "directory") { deletedDirectories.push(entry.path); continue; }
          const data = await this.read(entry.path);
          const backup = await this.journal.backup(this.projectId, entry.path, "delete", data.data);
          deletedFiles.push({ path: entry.path, fingerprint: data.fingerprint, backupRef: backup.id });
        }
      } else if (recoverable && this.journalSuppression === 0) {
        for (const entry of await this.list(normalized)) if (entry.kind === "file") await this.journal.backup(this.projectId, entry.path, "delete", (await this.read(entry.path)).data);
      }
    }
    const backup = shouldJournal || (recoverable && this.journalSuppression === 0) ? await this.journal.backup(this.projectId, normalized, "delete", existing?.data) : undefined;
    const { parent, name } = await this.parent(normalized, false);
    await parent.removeEntry(name, { recursive: true });
    this.fingerprints.delete(normalized);
    if (recoverable) await this.emit({ path: normalized, type: "delete", at: new Date().toISOString(), source });
    if (shouldJournal) {
      if (existing) await this.recordActiveChange({ type: "delete", path: normalized, kind: "file", beforeFingerprint: existing.fingerprint, ...(backup ? { backupRef: backup.id } : {}) });
      else {
        for (const directory of deletedDirectories) await this.recordActiveChange({ type: "delete", path: directory, kind: "directory" });
        for (const file of deletedFiles) await this.recordActiveChange({ type: "delete", path: file.path, kind: "file", beforeFingerprint: file.fingerprint, backupRef: file.backupRef });
      }
    }
    fileLog.info("项目路径已删除", { projectId: this.projectId, path: normalized, source, hadFileContent: Boolean(existing) });
  }

  async search(query: string, path = "/"): Promise<Array<{ path: string; line: number; text: string }>> {
    const needle = query.toLocaleLowerCase();
    if (!needle) return [];
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const entry of await this.list(path)) {
      if (entry.kind !== "file" || (entry.size ?? 0) > 1_000_000 || isRuntimeIgnoredPath(entry.path) || isWorkspaceInternalMetadataPath(entry.path)) continue;
      let text: string;
      try { text = (await this.readText(entry.path)).content; } catch { continue; }
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line.toLocaleLowerCase().includes(needle)) matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) });
        if (matches.length >= 200) { fileLog.info("项目搜索完成并达到结果上限", { projectId: this.projectId, path, queryCharacters: query.length, matches: matches.length }); return matches; }
      }
    }
    fileLog.info("项目搜索完成", { projectId: this.projectId, path, queryCharacters: query.length, matches: matches.length });
    return matches;
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalizeFilePath(path);
    try { await this.fileHandle(normalized, false); return true; } catch (error) { if (!isNotFound(error) && !isTypeMismatch(error)) throw error; }
    try { await this.directoryHandle(normalized, false); return true; } catch (error) { if (isNotFound(error) || isTypeMismatch(error)) return false; throw error; }
  }

  async refresh(): Promise<ProjectFileChange[]> {
    const next = new Map<string, string>();
    const changes: ProjectFileChange[] = [];
    for (const entry of await this.list("/")) {
      if (!entry.fingerprint || isWorkspaceInternalMetadataPath(entry.path)) continue;
      next.set(entry.path, entry.fingerprint);
      const previous = this.fingerprints.get(entry.path);
      if (previous !== entry.fingerprint) changes.push({ path: entry.path, type: "external", at: new Date().toISOString(), source: "external" });
    }
    for (const path of this.fingerprints.keys()) if (!next.has(path)) changes.push({ path, type: "delete", at: new Date().toISOString(), source: "external" });
    this.fingerprints.clear();
    for (const [path, fingerprint] of next) this.fingerprints.set(path, fingerprint);
    if (changes.length) fileLog.info("检测到真实目录外部变更", { projectId: this.projectId, changes: changes.length });
    return changes;
  }

  private async ensureActiveChangeSet(): Promise<void> {
    if (this.activeRunId && this.journal.beginRun) await this.journal.beginRun(this.projectId, this.activeRunId);
  }

  private async recordActiveChange(change: Omit<ChangeSetChange, "id" | "runId" | "createdAt">): Promise<void> {
    const runId = this.activeRunId;
    if (!runId || !this.journal.appendChange) return;
    await this.journal.appendChange(this.projectId, runId, { ...change, id: crypto.randomUUID(), runId, createdAt: new Date().toISOString() });
  }

  private async requireChangeSet(runId: string): Promise<ChangeSet> {
    const normalizedRunId = normalizeRunId(runId);
    if (!this.journal.read || !this.journal.readBackup) throw new Error("当前恢复日志不支持读取 ChangeSet。 ");
    const changeSet = await this.journal.read(this.projectId, normalizedRunId);
    if (!changeSet) throw new Error(`找不到运行“${normalizedRunId}”的 ChangeSet。`);
    return changeSet;
  }

  private async assertRunFinalState(changeSet: ChangeSet): Promise<void> {
    const expected = new Map<string, { exists: boolean; kind: ChangeSetChange["kind"]; fingerprint?: string }>();
    for (const change of changeSet.changes) {
      if (change.type === "delete") expected.set(change.path, { exists: false, kind: change.kind });
      else if (change.type === "move") {
        expected.set(change.path, { exists: false, kind: change.kind });
        if (change.targetPath) expected.set(change.targetPath, { exists: true, kind: change.kind, ...(change.afterFingerprint ? { fingerprint: change.afterFingerprint } : {}) });
      } else expected.set(change.path, { exists: true, kind: change.kind, ...(change.afterFingerprint ? { fingerprint: change.afterFingerprint } : {}) });
    }
    for (const [path, state] of expected) await this.assertPathState(path, state.exists, state.kind, state.fingerprint);
  }

  private async assertChangeAfterState(change: ChangeSetChange): Promise<void> {
    if (change.type === "delete") { await this.assertPathState(change.path, false, change.kind); return; }
    if (change.type === "move") {
      await this.assertPathState(change.path, false, change.kind);
      if (!change.targetPath) throw new Error("移动恢复项缺少目标路径。 ");
      await this.assertPathState(change.targetPath, true, change.kind, change.afterFingerprint);
      return;
    }
    await this.assertPathState(change.path, true, change.kind, change.afterFingerprint);
  }

  private async assertPathState(path: string, expectedExists: boolean, kind: ChangeSetChange["kind"], expectedFingerprint?: string): Promise<void> {
    const exists = await this.exists(path);
    if (exists !== expectedExists) throw new ChangeSetConflictError(path, expectedExists ? expectedFingerprint ?? `[${kind}]` : undefined, exists ? await this.pathFingerprint(path) : undefined);
    if (!exists || kind === "directory" || expectedFingerprint === undefined) return;
    const actual = await this.pathFingerprint(path);
    if (actual !== expectedFingerprint) throw new ChangeSetConflictError(path, expectedFingerprint, actual);
  }

  private async pathFingerprint(path: string): Promise<string | undefined> {
    try { return (await this.read(path)).fingerprint; }
    catch (error) { if (isTypeMismatch(error)) return "[directory]"; if (isNotFound(error)) return undefined; throw error; }
  }

  private async restoreChangeUnchecked(change: ChangeSetChange): Promise<void> {
    if (change.type === "create") {
      if (await this.exists(change.path)) await this.delete(change.path, "agent");
      return;
    }
    if (change.type === "modify") {
      await this.write(change.path, await this.backupData(change), { source: "agent" });
      return;
    }
    if (change.type === "delete") {
      if (change.kind === "directory") await this.ensureDirectory(change.path);
      else await this.write(change.path, await this.backupData(change), { source: "agent" });
      return;
    }
    if (!change.targetPath) throw new Error("移动恢复项缺少目标路径。 ");
    await this.write(change.path, await this.backupData(change), { source: "agent" });
    if (change.targetBackupRef) await this.write(change.targetPath, await this.readBackup(change.targetBackupRef), { source: "agent" });
    else if (await this.exists(change.targetPath)) await this.delete(change.targetPath, "agent");
  }

  private async backupData(change: ChangeSetChange): Promise<Uint8Array> {
    if (!change.backupRef) throw new Error(`恢复项“${change.id}”缺少内容备份。`);
    return this.readBackup(change.backupRef);
  }

  private async readBackup(backupRef: string): Promise<Uint8Array> {
    if (!this.journal.readBackup) throw new Error("当前恢复日志不支持读取备份内容。 ");
    return this.journal.readBackup(this.projectId, backupRef);
  }

  private async withJournalSuppressed<T>(operation: () => Promise<T>): Promise<T> {
    this.journalSuppression += 1;
    try { return await operation(); }
    finally { this.journalSuppression -= 1; }
  }

  private async walk(directory: BrowserDirectoryHandle, prefix: string, entries: ProjectFileEntry[]): Promise<void> {
    for await (const entry of directory.values()) {
      const path = `${prefix}/${entry.name}`.replace(/\/+/g, "/");
      if (isVersionControlMetadataPath(path)) continue;
      if (entry.kind === "directory") {
        entries.push({ path, kind: "directory" });
        if (!isRuntimeIgnoredPath(path)) await this.walk(entry, path, entries);
      } else {
        const file = await entry.getFile();
        entries.push({ path, kind: "file", size: file.size, lastModified: file.lastModified, fingerprint: fileFingerprint(file) });
      }
    }
  }

  private async tryRead(path: string): Promise<{ data: Uint8Array; fingerprint: string } | undefined> {
    try { return await this.read(path); } catch (error) { if (isNotFound(error)) return undefined; throw error; }
  }

  private async fileHandle(path: string, create: boolean): Promise<BrowserFileHandle> {
    const { parent, name } = await this.parent(path, create);
    return parent.getFileHandle(name, { create });
  }

  private async directoryHandle(path: string, create: boolean): Promise<BrowserDirectoryHandle> {
    const normalized = normalizeFilePath(path);
    let directory = this.root;
    for (const part of normalized.slice(1).split("/")) directory = await directory.getDirectoryHandle(part, { create });
    return directory;
  }

  private async parent(path: string, create: boolean): Promise<{ parent: BrowserDirectoryHandle; name: string }> {
    const normalized = normalizeFilePath(path);
    const parts = normalized.slice(1).split("/");
    const name = parts.pop();
    if (!name) throw new Error("不能直接修改项目根目录。 ");
    let parent = this.root;
    for (const part of parts) parent = await parent.getDirectoryHandle(part, { create });
    return { parent, name };
  }

  private async emit(change: ProjectFileChange): Promise<void> { await this.onChange?.(change); }
}

export function normalizeFilePath(input: string): string {
  const value = input.trim().replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(value) || /%2e|%2f/i.test(value)) throw new Error("项目路径不能包含盘符或编码遍历。 ");
  const parts = value.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || /[\u0000-\u001f]/.test(part))) throw new Error("项目路径无效或越界。 ");
  return `/${parts.join("/")}`;
}

/** 将 Agent 看到的逻辑 /workspace 根转换为 ProjectFileService 使用的项目相对路径。 */
export function normalizeAgentWorkspacePath(input: string): string {
  const value = input.trim().replace(/\\/g, "/");
  const projectPath = value === "/workspace"
    ? "/"
    : value.startsWith("/workspace/")
      ? value.slice("/workspace".length)
      : value;
  return projectPath === "/" ? "/" : normalizeFilePath(projectPath);
}

export function isRuntimeIgnoredPath(path: string): boolean {
  const normalized = `/${path.replace(/^\/+/, "")}`;
  return /\/(?:node_modules|\.git|\.pnpm-store|\.npm|\.cache|dist|build|coverage)(?:\/|$)/.test(normalized);
}

export function isBrowserAgentPackagePath(path: string): boolean {
  const normalized = `/${path.replace(/^\/+/, "")}`;
  return normalized === BROWSER_AGENT_PACKAGE_DIRECTORY || normalized.startsWith(`${BROWSER_AGENT_PACKAGE_DIRECTORY}/`);
}

/** Browser Agent 自身状态、日志与依赖缓存，不应作为用户源码、搜索结果或恢复产物展示。 */
export function isBrowserAgentInternalPath(path: string): boolean {
  const normalized = `/${path.replace(/^\/+/, "")}`;
  return normalized === BROWSER_AGENT_DIRECTORY || normalized.startsWith(`${BROWSER_AGENT_DIRECTORY}/`);
}

function isVersionControlMetadataPath(path: string): boolean {
  const normalized = `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  return normalized === "/.git" || normalized.startsWith("/.git/");
}

/** Browser Agent 自身数据和版本控制元数据均不属于用户任务产物。 */
export function isWorkspaceInternalMetadataPath(path: string): boolean {
  return isBrowserAgentInternalPath(path) || isVersionControlMetadataPath(path);
}

function normalizeDirectory(input: string): string { return input === "/" ? "" : normalizeFilePath(input); }
function fileFingerprint(file: File): string { return `${file.size}:${file.lastModified}`; }
function safeSegment(input: string): string { return input.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100); }
function normalizeRunId(runId: string): string {
  const value = runId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") throw new Error("运行 ID 无效。 ");
  return value;
}
function isNotFound(error: unknown): boolean { return error instanceof DOMException ? error.name === "NotFoundError" : error instanceof Error && /not.?found|不存在/i.test(error.message); }
function isTypeMismatch(error: unknown): boolean { return error instanceof DOMException ? error.name === "TypeMismatchError" : error instanceof Error && /type.?mismatch|EISDIR/i.test(error.message); }
