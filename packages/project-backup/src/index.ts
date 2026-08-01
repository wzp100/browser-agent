import type {
  AttachmentRecord,
  MessageRecord,
  ModelDescriptor,
  ProjectRecord,
  ProviderProfile,
  RunRecord,
  ThreadRecord
} from "../../persistence/src/types";
import type { SkillDescriptor } from "../../skill-core/src/index";
import type { ChangeSet, RecoveryBackupPayload } from "../../workspace-contracts/src/index";

export const PROJECT_BACKUP_SCHEMA = "browser-agent.project-backup";
export const PROJECT_BACKUP_VERSION = 1 as const;
export const DEFAULT_MAX_BACKUP_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_BACKUP_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_BACKUP_RECORDS = 100_000;

export type PortableProjectRecord = Omit<ProjectRecord, "directoryHandle">;
export type EncodedAttachmentRecord = Omit<AttachmentRecord, "blob"> & { dataBase64: string };
export type EncodedRecoveryBackup = Omit<RecoveryBackupPayload, "data"> & { dataBase64: string };

export interface ProjectBackupPayload {
  schema: typeof PROJECT_BACKUP_SCHEMA;
  version: typeof PROJECT_BACKUP_VERSION;
  exportedAt: string;
  project: PortableProjectRecord;
  threads: ThreadRecord[];
  messages: MessageRecord[];
  runs: RunRecord[];
  providerProfiles: ProviderProfile[];
  models: ModelDescriptor[];
  skills: SkillDescriptor[];
  /** ChangeSet 索引与其引用的内容备份一起导出，导入后可继续恢复。 */
  changeSets: ChangeSet[];
  recoveryBackups: EncodedRecoveryBackup[];
  attachments: EncodedAttachmentRecord[];
}

export interface ProjectBackupSource extends Omit<ProjectBackupPayload, "schema" | "version" | "exportedAt" | "project" | "attachments" | "recoveryBackups"> {
  project: ProjectRecord;
  attachments: AttachmentRecord[];
  recoveryBackups?: RecoveryBackupPayload[];
  exportedAt?: string;
}

export interface ProjectBackupLimits {
  maxBytes?: number;
  maxAttachmentBytes?: number;
  maxRecords?: number;
}

export interface ProjectBackupImportBundle extends Omit<ProjectBackupPayload, "attachments" | "recoveryBackups"> {
  attachments: AttachmentRecord[];
  recoveryBackups: RecoveryBackupPayload[];
}

/** 应用层应在 commit 中使用单个事务或自行回滚，避免跨 store 的半导入状态。 */
export interface ProjectBackupImporter {
  commit(bundle: ProjectBackupImportBundle): Promise<void>;
}

export interface ProjectBackupImportResult {
  projectId: string;
  threads: number;
  messages: number;
  runs: number;
  attachments: number;
  changeSets: number;
  recoveryBackups: number;
}

export async function serializeProjectBackup(source: ProjectBackupSource, limits: ProjectBackupLimits = {}): Promise<Uint8Array> {
  const { directoryHandle: _directoryHandle, ...project } = source.project;
  const attachments = await Promise.all(source.attachments.map(async ({ blob, ...record }): Promise<EncodedAttachmentRecord> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assertAttachmentSize(bytes.byteLength, record.name, limits);
    return { ...record, dataBase64: bytesToBase64(bytes) };
  }));
  const recoveryBackups = (source.recoveryBackups ?? []).map(({ record, data }): EncodedRecoveryBackup => {
    assertRecoverySize(data.byteLength, `恢复备份 ${record.id}`, limits);
    return { record, dataBase64: bytesToBase64(data) };
  });
  const payload: ProjectBackupPayload = {
    schema: PROJECT_BACKUP_SCHEMA,
    version: PROJECT_BACKUP_VERSION,
    exportedAt: source.exportedAt ?? new Date().toISOString(),
    project,
    threads: [...source.threads],
    messages: [...source.messages],
    runs: [...source.runs],
    providerProfiles: [...source.providerProfiles],
    models: [...source.models],
    skills: [...source.skills],
    changeSets: [...source.changeSets],
    recoveryBackups,
    attachments
  };
  validateProjectBackup(payload, limits);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  assertArchiveSize(bytes.byteLength, limits);
  return bytes;
}

export function parseProjectBackup(source: string | Uint8Array, limits: ProjectBackupLimits = {}): ProjectBackupPayload {
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
  assertArchiveSize(bytes.byteLength, limits);
  let value: unknown;
  try { value = JSON.parse(typeof source === "string" ? source : new TextDecoder("utf-8", { fatal: true }).decode(source)); }
  catch (error) { throw new Error(`项目备份不是有效的 UTF-8 JSON：${errorMessage(error)}`); }
  validateProjectBackup(value, limits);
  return value;
}

export async function importProjectBackup(source: string | Uint8Array | Blob, importer: ProjectBackupImporter, limits: ProjectBackupLimits = {}): Promise<ProjectBackupImportResult> {
  const bytes = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source;
  const payload = parseProjectBackup(bytes, limits);
  const attachments = payload.attachments.map(({ dataBase64, ...record }): AttachmentRecord => {
    const data = base64ToBytes(dataBase64);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    return { ...record, blob: new Blob([buffer], { type: record.mimeType }) };
  });
  const recoveryBackups = (payload.recoveryBackups ?? []).map(({ dataBase64, record }): RecoveryBackupPayload => ({ record, data: base64ToBytes(dataBase64) }));
  const { attachments: _encodedAttachments, recoveryBackups: _encodedRecovery, ...metadata } = payload;
  await importer.commit({ ...metadata, attachments, recoveryBackups });
  return {
    projectId: payload.project.id,
    threads: payload.threads.length,
    messages: payload.messages.length,
    runs: payload.runs.length,
    attachments: attachments.length,
    changeSets: payload.changeSets.length,
    recoveryBackups: recoveryBackups.length
  };
}

export function validateProjectBackup(value: unknown, limits: ProjectBackupLimits = {}): asserts value is ProjectBackupPayload {
  const payload = object(value, "项目备份根对象");
  if (payload.schema !== PROJECT_BACKUP_SCHEMA) throw new Error("项目备份 schema 不受支持。 ");
  if (payload.version !== PROJECT_BACKUP_VERSION) throw new Error(`项目备份版本不受支持：${String(payload.version)}`);
  requiredString(payload.exportedAt, "exportedAt");
  if (!Number.isFinite(Date.parse(payload.exportedAt as string))) throw new Error("项目备份 exportedAt 无效。 ");
  const project = object(payload.project, "project");
  const projectId = requiredString(project.id, "project.id");
  requiredString(project.name, "project.name");
  oneOf(project.permissionHint, ["granted", "prompt", "denied", "missing"], "project.permissionHint");
  requiredBoolean(project.legacyRelinkRequired, "project.legacyRelinkRequired");
  requiredString(project.createdAt, "project.createdAt");
  requiredString(project.lastOpenedAt, "project.lastOpenedAt");
  if ("directoryHandle" in project) throw new Error("项目备份不能包含目录句柄。 ");

  const threads = records(payload.threads, "threads", limits);
  const messages = records(payload.messages, "messages", limits);
  const runs = records(payload.runs, "runs", limits);
  const providers = records(payload.providerProfiles, "providerProfiles", limits);
  const models = records(payload.models, "models", limits);
  const skills = records(payload.skills, "skills", limits);
  const changeSets = records(payload.changeSets, "changeSets", limits);
  const recoveryBackups = records(payload.recoveryBackups ?? [], "recoveryBackups", limits);
  const attachments = records(payload.attachments, "attachments", limits);
  const maxRecords = positiveInteger(limits.maxRecords, DEFAULT_MAX_BACKUP_RECORDS);
  if ([threads, messages, runs, providers, models, skills, changeSets, recoveryBackups, attachments].reduce((sum, entries) => sum + entries.length, 0) > maxRecords) throw new Error(`项目备份总记录数超过 ${maxRecords} 条限制。`);

  const threadIds = uniqueIds(threads, "threads");
  for (const entry of threads) {
    if (requiredString(entry.projectId, "thread.projectId") !== projectId) throw new Error("对话不属于备份项目。 ");
    requiredString(entry.title, "thread.title");
    requiredString(entry.createdAt, "thread.createdAt");
    requiredString(entry.updatedAt, "thread.updatedAt");
  }
  const messageIds = uniqueIds(messages, "messages");
  for (const entry of messages) {
    if (!threadIds.has(requiredString(entry.threadId, "message.threadId"))) throw new Error("消息引用了不存在的对话。 ");
    nonNegativeInteger(entry.sequence, "message.sequence");
    oneOf(entry.role, ["user", "assistant", "system"], "message.role");
    oneOf(entry.kind, ["user", "assistant", "tool", "terminal", "error"], "message.kind");
    if (typeof entry.content !== "string") throw new Error("项目备份 message.content 必须是字符串。 ");
    requiredString(entry.createdAt, "message.createdAt");
  }
  uniqueIds(runs, "runs");
  for (const entry of runs) {
    if (!threadIds.has(requiredString(entry.threadId, "run.threadId"))) throw new Error("运行记录引用了不存在的对话。 ");
    oneOf(entry.status, ["running", "paused", "completed", "failed", "cancelled", "interrupted"], "run.status");
    if (typeof entry.intent !== "string") throw new Error("项目备份 run.intent 必须是字符串。 ");
    if (!Array.isArray(entry.events)) throw new Error("项目备份 run.events 必须是数组。 ");
    requiredString(entry.createdAt, "run.createdAt");
    requiredString(entry.updatedAt, "run.updatedAt");
  }

  const providerIds = uniqueIds(providers, "providerProfiles");
  for (const provider of providers) validateProvider(provider);
  uniqueIds(models, "models");
  for (const model of models) {
    if (!providerIds.has(requiredString(model.providerProfileId, "model.providerProfileId"))) throw new Error("模型引用了不存在的 Provider Profile。 ");
    requiredString(model.name, "model.name");
    oneOf(model.source, ["provider", "models.dev", "manual"], "model.source");
    const capabilities = object(model.capabilities, "model.capabilities");
    for (const name of ["toolCalling", "imageInput", "pdfInput"] as const) oneOf(capabilities[name], ["supported", "unsupported", "unknown"], `model.capabilities.${name}`);
  }
  uniqueIds(skills, "skills");
  for (const skill of skills) {
    requiredString(skill.name, "skill.name");
    requiredString(skill.description, "skill.description");
    oneOf(skill.source, ["builtin", "user", "organization", "generated"], "skill.source");
    requiredString(skill.instructions, "skill.instructions");
    if (!Array.isArray(skill.files)) throw new Error("项目备份 skill.files 必须是数组。 ");
    requiredString(skill.updatedAt, "skill.updatedAt");
  }
  uniqueIds(changeSets, "changeSets");
  for (const entry of changeSets) {
    if (requiredString(entry.projectId, "changeSet.projectId") !== projectId) throw new Error("ChangeSet 不属于备份项目。 ");
    requiredString(entry.runId, "changeSet.runId");
    oneOf(entry.status, ["active", "paused", "completed", "failed", "cancelled", "interrupted", "restored"], "changeSet.status");
    if (!Array.isArray(entry.changes)) throw new Error("项目备份 changeSet.changes 必须是数组。 ");
    requiredString(entry.createdAt, "changeSet.createdAt");
    requiredString(entry.updatedAt, "changeSet.updatedAt");
  }
  const backupRefs = new Set<string>();
  for (const entry of recoveryBackups) {
    const record = object(entry.record, "recoveryBackup.record");
    const id = requiredString(record.id, "recoveryBackup.record.id");
    if (backupRefs.has(id)) throw new Error(`恢复备份包含重复 id：${id}`);
    backupRefs.add(id);
    if (requiredString(record.projectId, "recoveryBackup.record.projectId") !== projectId) throw new Error("恢复备份不属于备份项目。 ");
    requiredString(record.path, "recoveryBackup.record.path");
    oneOf(record.operation, ["create", "modify", "delete", "move", "external"], "recoveryBackup.record.operation");
    requiredString(record.createdAt, "recoveryBackup.record.createdAt");
    const declaredSize = nonNegativeInteger(record.bytes, "recoveryBackup.record.bytes");
    const data = base64ToBytes(requiredString(entry.dataBase64, "recoveryBackup.dataBase64"));
    assertRecoverySize(data.byteLength, `恢复备份 ${id}`, limits);
    if (data.byteLength !== declaredSize) throw new Error(`恢复备份“${id}”的声明大小与内容不一致。`);
  }
  for (const changeSet of changeSets) for (const change of records(changeSet.changes, "changeSet.changes", limits)) {
    for (const key of ["backupRef", "targetBackupRef"] as const) if (change[key] !== undefined && !backupRefs.has(requiredString(change[key], `change.${key}`))) throw new Error(`ChangeSet 引用了未导出的恢复备份：${String(change[key])}`);
  }

  uniqueIds(attachments, "attachments");
  for (const attachment of attachments) {
    const threadId = requiredString(attachment.threadId, "attachment.threadId");
    if (!threadIds.has(threadId)) throw new Error("附件引用了不存在的对话。 ");
    if (attachment.messageId !== undefined && !messageIds.has(requiredString(attachment.messageId, "attachment.messageId"))) throw new Error("附件引用了不存在的消息。 ");
    const mimeType = requiredString(attachment.mimeType, "attachment.mimeType");
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(mimeType)) throw new Error(`附件格式不受支持：${mimeType}`);
    const name = requiredString(attachment.name, "attachment.name");
    requiredString(attachment.createdAt, "attachment.createdAt");
    const declaredSize = nonNegativeInteger(attachment.size, "attachment.size");
    const encoded = requiredString(attachment.dataBase64, "attachment.dataBase64");
    const data = base64ToBytes(encoded);
    assertAttachmentSize(data.byteLength, name, limits);
    if (data.byteLength !== declaredSize) throw new Error(`附件“${name}”的声明大小与内容不一致。`);
  }
  assertNoSensitiveProperties(payload);
}

function validateProvider(provider: Record<string, unknown>): void {
  requiredString(provider.id, "provider.id");
  requiredString(provider.name, "provider.name");
  oneOf(provider.kind, ["openai", "deepseek", "gateway", "openai-compatible"], "provider.kind");
  requiredString(provider.defaultModelId, "provider.defaultModelId");
  requiredBoolean(provider.builtIn, "provider.builtIn");
  requiredString(provider.createdAt, "provider.createdAt");
  requiredString(provider.updatedAt, "provider.updatedAt");
  requiredString(provider.endpoint, "provider.endpoint");
  for (const key of ["endpoint", "modelsEndpoint"] as const) {
    if (provider[key] === undefined) continue;
    const value = requiredString(provider[key], `provider.${key}`);
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`Provider ${key} 不是有效网址。`); }
    if (url.username || url.password) throw new Error(`Provider ${key} 不能包含凭据。`);
  }
}

function records(value: unknown, name: string, limits: ProjectBackupLimits): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`项目备份 ${name} 必须是数组。`);
  const max = positiveInteger(limits.maxRecords, DEFAULT_MAX_BACKUP_RECORDS);
  if (value.length > max) throw new Error(`项目备份 ${name} 超过 ${max} 条记录限制。`);
  return value.map((entry, index) => object(entry, `${name}[${index}]`));
}

function uniqueIds(values: Record<string, unknown>[], name: string): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    const id = requiredString(value.id, `${name}.id`);
    if (ids.has(id)) throw new Error(`项目备份 ${name} 包含重复 id：${id}`);
    ids.add(id);
  }
  return ids;
}

function assertNoSensitiveProperties(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) { for (const entry of value) assertNoSensitiveProperties(entry, seen); return; }
  for (const [key, entry] of Object.entries(value)) {
    if (/^(?:api[-_]?key|authorization|password|passwd|secret|cookie|access[-_]?token|refresh[-_]?token|token)$/i.test(key)) throw new Error(`项目备份包含禁止导出的敏感字段：${key}`);
    assertNoSensitiveProperties(entry, seen);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`项目备份 ${name} 必须是对象。`);
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`项目备份 ${name} 必须是非空字符串。`); return value; }
function requiredBoolean(value: unknown, name: string): boolean { if (typeof value !== "boolean") throw new Error(`项目备份 ${name} 必须是布尔值。`); return value; }
function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`项目备份 ${name} 的值无效。`); return value as T; }
function nonNegativeInteger(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`项目备份 ${name} 必须是非负整数。`); return value; }
function positiveInteger(value: number | undefined, fallback: number): number { return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function assertArchiveSize(bytes: number, limits: ProjectBackupLimits): void { const max = positiveInteger(limits.maxBytes, DEFAULT_MAX_BACKUP_BYTES); if (bytes > max) throw new Error(`项目备份超过 ${max} 字节限制。`); }
function assertAttachmentSize(bytes: number, name: string, limits: ProjectBackupLimits): void { const max = positiveInteger(limits.maxAttachmentBytes, DEFAULT_MAX_BACKUP_ATTACHMENT_BYTES); if (bytes > max) throw new Error(`附件“${name}”超过 ${max} 字节限制。`); }
function assertRecoverySize(bytes: number, name: string, limits: ProjectBackupLimits): void { const max = positiveInteger(limits.maxBytes, DEFAULT_MAX_BACKUP_BYTES); if (bytes > max) throw new Error(`${name} 超过 ${max} 字节限制。`); }

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary);
}
function base64ToBytes(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("附件 base64 编码无效。 ");
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("附件 base64 编码无效。 "); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
