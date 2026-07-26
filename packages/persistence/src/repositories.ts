import type { AppLogRecord, AppLogSink } from "../../logging/src/index";
import { BrowserDatabase } from "./database";
import type { AttachmentRecord, LoggingSettingsRecord, MessageKind, MessageRecord, ModelSettingsRecord, ModelsDevCacheRecord, PersistedDirectoryHandle, ProjectRecord, ProviderProfile, RunRecord, ThreadModelSelection, ThreadRecord } from "./types";

export class ProjectRepository {
  constructor(private readonly database: BrowserDatabase) {}
  async list(): Promise<ProjectRecord[]> { return (await this.database.getAll<ProjectRecord>("projects")).sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt)); }
  get(id: string): Promise<ProjectRecord | undefined> { return this.database.get<ProjectRecord>("projects", id); }
  put(project: ProjectRecord): Promise<void> { return this.database.put("projects", project); }
  async findByHandle(handle: PersistedDirectoryHandle): Promise<ProjectRecord | undefined> {
    for (const project of await this.list()) {
      if (!project.directoryHandle) continue;
      try { if (project.directoryHandle.isSameEntry && await project.directoryHandle.isSameEntry(handle)) return project; }
      catch { /* Stale handles are re-linked explicitly. */ }
    }
    return undefined;
  }
  delete(id: string): Promise<void> { return this.database.delete("projects", id); }
}

export class ConversationRepository {
  private readonly messageQueues = new Map<string, Promise<unknown>>();
  constructor(private readonly database: BrowserDatabase) {}
  async listThreads(projectId?: string): Promise<ThreadRecord[]> {
    const values = projectId
      ? await this.database.getAllFromIndex<ThreadRecord>("threads", "projectId", projectId)
      : await this.database.getAll<ThreadRecord>("threads");
    return values.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  getThread(id: string): Promise<ThreadRecord | undefined> { return this.database.get<ThreadRecord>("threads", id); }
  putThread(thread: ThreadRecord): Promise<void> { return this.database.put("threads", thread); }
  async messages(threadId: string): Promise<MessageRecord[]> { return (await this.database.getAllFromIndex<MessageRecord>("messages", "threadId", threadId)).sort((left, right) => left.sequence - right.sequence); }
  appendMessage(message: Omit<MessageRecord, "id" | "sequence" | "createdAt"> & { id?: string; createdAt?: string }): Promise<MessageRecord> {
    const previous = this.messageQueues.get(message.threadId) ?? Promise.resolve();
    const operation = previous.then(() => this.appendMessageNow(message));
    this.messageQueues.set(message.threadId, operation.catch(() => undefined));
    return operation;
  }
  private async appendMessageNow(message: Omit<MessageRecord, "id" | "sequence" | "createdAt"> & { id?: string; createdAt?: string }): Promise<MessageRecord> {
    const previous = await this.messages(message.threadId);
    const record: MessageRecord = { ...message, id: message.id ?? crypto.randomUUID(), sequence: (previous.at(-1)?.sequence ?? 0) + 1, createdAt: message.createdAt ?? new Date().toISOString() };
    await this.database.put("messages", record);
    const thread = await this.getThread(record.threadId);
    if (thread) await this.putThread({ ...thread, updatedAt: record.createdAt });
    return record;
  }
  async deleteThread(id: string): Promise<void> {
    await this.database.deleteByIndex("messages", "threadId", id);
    await this.database.deleteByIndex("runs", "threadId", id);
    await this.database.deleteByIndex("attachments", "threadId", id);
    await this.database.delete("threads", id);
  }
  async deleteMessagesByKind(threadId: string, kind: MessageKind): Promise<void> { for (const message of await this.messages(threadId)) if (message.kind === kind) await this.database.delete("messages", message.id); }
  async deleteProjectThreads(projectId: string): Promise<void> { for (const thread of await this.listThreads(projectId)) await this.deleteThread(thread.id); }
  putRun(run: RunRecord): Promise<void> { return this.database.put("runs", run); }
  runs(threadId: string): Promise<RunRecord[]> { return this.database.getAllFromIndex<RunRecord>("runs", "threadId", threadId); }
  async setModelSelection(threadId: string, selection: ThreadModelSelection): Promise<void> {
    const thread = await this.getThread(threadId);
    if (!thread) throw new Error(`找不到对话：${threadId}`);
    await this.putThread({ ...thread, modelSelection: selection, modelConfigId: selection.providerProfileId, updatedAt: new Date().toISOString() });
  }
}

export class AttachmentRepository {
  constructor(private readonly database: BrowserDatabase) {}
  get(id: string): Promise<AttachmentRecord | undefined> { return this.database.get<AttachmentRecord>("attachments", id); }
  async put(record: AttachmentRecord): Promise<void> {
    validateAttachment(record);
    if (record.messageId) await this.assertMessageBudget(record.messageId, record.size, record.id);
    await this.database.put("attachments", record);
  }
  listForThread(threadId: string): Promise<AttachmentRecord[]> { return this.database.getAllFromIndex<AttachmentRecord>("attachments", "threadId", threadId); }
  listForMessage(messageId: string): Promise<AttachmentRecord[]> { return this.database.getAllFromIndex<AttachmentRecord>("attachments", "messageId", messageId); }
  delete(id: string): Promise<void> { return this.database.delete("attachments", id); }
  async attachToMessage(id: string, messageId: string): Promise<void> {
    const record = await this.get(id);
    if (!record) throw new Error(`找不到附件：${id}`);
    await this.assertMessageBudget(messageId, record.size, record.id);
    await this.put({ ...record, messageId });
  }
  private async assertMessageBudget(messageId: string, incomingSize: number, excludeId: string): Promise<void> {
    const existing = await this.listForMessage(messageId);
    const total = existing.filter((record) => record.id !== excludeId).reduce((sum, record) => sum + record.size, 0) + incomingSize;
    if (total > MAX_MESSAGE_IMAGE_BYTES) throw new Error("单条消息的图片附件合计不能超过 16 MiB。");
  }
}

export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_MESSAGE_IMAGE_BYTES = 16 * 1024 * 1024;

function validateAttachment(record: AttachmentRecord): void {
  if (!(record.blob instanceof Blob)) throw new Error("附件内容必须是 Blob。");
  if (!["image/jpeg", "image/png", "image/webp"].includes(record.mimeType)) throw new Error("仅支持 JPEG、PNG 和 WebP 图片。");
  if (record.size !== record.blob.size) throw new Error("附件大小与 Blob 内容不一致。");
  if (record.size > MAX_IMAGE_ATTACHMENT_BYTES) throw new Error("单张图片不能超过 8 MiB。");
}

export class ProviderProfileRepository {
  constructor(private readonly database: BrowserDatabase) {}
  async list(): Promise<ProviderProfile[]> { return (await this.database.getAll<ProviderProfile>("providerProfiles")).sort((left, right) => left.name.localeCompare(right.name)); }
  get(id: string): Promise<ProviderProfile | undefined> { return this.database.get<ProviderProfile>("providerProfiles", id); }
  put(profile: ProviderProfile): Promise<void> { return this.database.put("providerProfiles", profile); }
  async delete(id: string): Promise<void> {
    const profile = await this.get(id);
    if (profile?.builtIn) throw new Error("内置模型供应商不能删除。");
    await this.database.delete("providerProfiles", id);
  }
}

export class SettingsRepository {
  constructor(private readonly database: BrowserDatabase) {}
  getModel(): Promise<ModelSettingsRecord | undefined> { return this.database.get<ModelSettingsRecord>("settings", "model"); }
  putModel(settings: ModelSettingsRecord): Promise<void> { return this.database.put("settings", settings); }
  getLogging(): Promise<LoggingSettingsRecord | undefined> { return this.database.get<LoggingSettingsRecord>("settings", "logging"); }
  putLogging(settings: LoggingSettingsRecord): Promise<void> { return this.database.put("settings", settings); }
  getModelsDevCache(): Promise<ModelsDevCacheRecord | undefined> { return this.database.get<ModelsDevCacheRecord>("settings", "models-dev-cache"); }
  putModelsDevCache(cache: ModelsDevCacheRecord): Promise<void> { return this.database.put("settings", cache); }
  async listProviderProfiles(): Promise<ProviderProfile[]> { return new ProviderProfileRepository(this.database).list(); }
  getProviderProfile(id: string): Promise<ProviderProfile | undefined> { return new ProviderProfileRepository(this.database).get(id); }
  putProviderProfile(profile: ProviderProfile): Promise<void> { return new ProviderProfileRepository(this.database).put(profile); }
}

export class BrowserLogStore implements AppLogSink {
  constructor(private readonly database: BrowserDatabase) {}
  write(record: AppLogRecord): Promise<void> { return this.database.put("logs", record); }
  async list(limit?: number): Promise<AppLogRecord[]> {
    const records = (await this.database.getAll<AppLogRecord>("logs")).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    return limit === undefined ? records : records.slice(0, limit);
  }
  clear(): Promise<void> { return this.database.clear("logs"); }
}
