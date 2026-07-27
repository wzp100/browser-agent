import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserDatabase, BrowserLogStore, ConversationRepository, migrateLegacyConversations, ModelProbeRepository, ProjectRepository, SettingsRepository } from "../packages/persistence/src/index";

test("IndexedDB 按 projectId 持久化项目、对话和有序消息", async () => {
  const database = new BrowserDatabase();
  const projects = new ProjectRepository(database);
  const conversations = new ConversationRepository(database);
  const now = new Date().toISOString();
  await projects.put({ id: "project-1", name: "demo", directoryHandle: { kind: "directory", name: "demo" }, permissionHint: "prompt", legacyRelinkRequired: false, createdAt: now, lastOpenedAt: now });
  await conversations.putThread({ id: "thread-1", projectId: "project-1", title: "任务", createdAt: now, updatedAt: now });
  await conversations.appendMessage({ threadId: "thread-1", role: "user", kind: "user", content: "第一条" });
  await conversations.appendMessage({ threadId: "thread-1", role: "assistant", kind: "assistant", content: "第二条" });
  assert.equal((await projects.get("project-1"))?.name, "demo");
  assert.deepEqual((await conversations.messages("thread-1")).map((message) => message.content), ["第一条", "第二条"]);
  assert.equal((await conversations.listThreads("project-1"))[0]?.id, "thread-1");
});

test("并发写入消息时仍保持唯一递增序号", async () => {
  const conversations = new ConversationRepository(new BrowserDatabase());
  const now = new Date().toISOString();
  await conversations.putThread({ id: "thread-concurrent", projectId: "project-1", title: "并发", createdAt: now, updatedAt: now });
  await Promise.all(Array.from({ length: 8 }, (_, index) => conversations.appendMessage({ threadId: "thread-concurrent", role: "system", kind: "terminal", content: String(index) })));
  assert.deepEqual((await conversations.messages("thread-concurrent")).map((message) => message.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("工具调用与输出保留 runId 和 callId 以恢复折叠步骤", async () => {
  const conversations = new ConversationRepository(new BrowserDatabase());
  const now = new Date().toISOString();
  await conversations.putThread({ id: "thread-tools", projectId: "project-1", title: "工具步骤", createdAt: now, updatedAt: now });
  await conversations.appendMessage({ threadId: "thread-tools", role: "system", kind: "tool", content: "shell.exec {\"command\":\"pnpm test\"}", metadata: { runId: "run-1", callId: "call-1", eventKind: "tool-start", toolName: "shell.exec", arguments: { command: "pnpm test" } } });
  await conversations.appendMessage({ threadId: "thread-tools", role: "system", kind: "tool", content: "{\"exitCode\":0}", metadata: { runId: "run-1", callId: "call-1", eventKind: "tool-result", toolName: "shell.exec" } });
  const messages = await conversations.messages("thread-tools");
  assert.deepEqual(messages.map((message) => message.metadata?.eventKind), ["tool-start", "tool-result"]);
  assert.ok(messages.every((message) => message.metadata?.runId === "run-1" && message.metadata.callId === "call-1"));
});

test("Agent 运行记录保留模型来源且不包含密钥", async () => {
  const conversations = new ConversationRepository(new BrowserDatabase());
  const now = new Date().toISOString();
  await conversations.putThread({ id: "thread-provenance", projectId: "project-1", title: "运行来源", createdAt: now, updatedAt: now });
  await conversations.putRun({
    id: "run-provenance",
    threadId: "thread-provenance",
    status: "completed",
    intent: "生成汇总",
    providerMode: "direct",
    model: "gpt-5.6",
    endpointOrigin: "https://api.openai.com",
    events: [{ at: now, kind: "tool", content: "spreadsheet.aggregate" }],
    createdAt: now,
    updatedAt: now
  });
  const [run] = await conversations.runs("thread-provenance");
  assert.equal(run?.model, "gpt-5.6");
  assert.equal(run?.endpointOrigin, "https://api.openai.com");
  assert.equal(JSON.stringify(run).includes("apiKey"), false);
});

test("旧 LocalStorage 对话迁移为待重新关联的项目", async () => {
  const values = new Map<string, string>();
  values.set("browser-agent-runtime:conversations", JSON.stringify([{ id: "legacy-thread", projectName: "旧项目", title: "历史任务", updatedAt: "2026-07-01T00:00:00.000Z", messages: [{ role: "user", content: "旧消息", at: "2026-07-01T00:00:00.000Z" }] }]));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear(), key: () => null, get length() { return values.size; } } satisfies Storage });
  const database = new BrowserDatabase();
  assert.equal(await migrateLegacyConversations(database), 1);
  const project = (await new ProjectRepository(database).list()).find((item) => item.name === "旧项目");
  assert.equal(project?.legacyRelinkRequired, true);
  assert.equal(project?.permissionHint, "missing");
  assert.equal((await new ConversationRepository(database).messages("legacy-thread"))[0]?.content, "旧消息");
});

test("诊断日志写入 IndexedDB 后可读取和清空", async () => {
  const store = new BrowserLogStore(new BrowserDatabase());
  await store.clear();
  await store.write({ id: "log-1", timestamp: "2026-07-16T01:02:03.000Z", level: "error", scope: "runtime.webcontainer", message: "启动失败", errorMessage: "Unable to create more instances" });
  assert.equal((await store.list())[0]?.scope, "runtime.webcontainer");
  await store.clear();
  assert.equal((await store.list()).length, 0);
});

test("排队消息可原位更新并撤回", async () => {
  const conversations = new ConversationRepository(new BrowserDatabase());
  const now = new Date().toISOString();
  await conversations.putThread({ id: "thread-queue", projectId: "project-1", title: "队列", createdAt: now, updatedAt: now });
  const queued = await conversations.appendMessage({ threadId: "thread-queue", role: "user", kind: "user", content: "继续检查", metadata: { queueStatus: "pending" } });
  await conversations.putMessage({ ...queued, metadata: { queueStatus: "running" } });
  assert.equal((await conversations.messages("thread-queue"))[0]?.metadata?.queueStatus, "running");
  await conversations.deleteMessage(queued.id);
  assert.equal((await conversations.messages("thread-queue")).length, 0);
});

test("模型 Quick Test 结果按供应商和模型读取最新记录", async () => {
  const probes = new ModelProbeRepository(new BrowserDatabase());
  await probes.put({ id: "probe-old", providerProfileId: "provider", modelId: "model", endpointOrigin: "https://example.com", text: true, toolCalling: false, imageInput: false, streaming: true, testedAt: "2026-07-25T00:00:00.000Z" });
  await probes.put({ id: "probe-new", providerProfileId: "provider", modelId: "model", endpointOrigin: "https://example.com", text: true, toolCalling: true, imageInput: true, streaming: true, testedAt: "2026-07-26T00:00:00.000Z" });
  assert.equal((await probes.latest("provider", "model"))?.id, "probe-new");
});

test("MCP Server 配置持久保存且不包含鉴权密钥字段", async () => {
  const settings = new SettingsRepository(new BrowserDatabase());
  const now = new Date().toISOString();
  await settings.putMcpServers([{ id: "mcp-1", name: "知识库", url: "https://example.com/mcp", enabled: true, createdAt: now, updatedAt: now }]);
  const [server] = await settings.getMcpServers();
  assert.equal(server?.name, "知识库");
  assert.equal(JSON.stringify(server).includes("token"), false);
  assert.equal(JSON.stringify(server).includes("authorization"), false);
});
