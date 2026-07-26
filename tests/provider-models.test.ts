import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import test from "node:test";
import { HumanMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import { createOpenAICompatibleProfile, providerApiKeySessionKey, readProviderApiKey, writeProviderApiKey } from "../apps/web/src/model-settings";
import { canRunAgent, canSendImages, discoverProviderModels, loadModelsDevCatalog, mergeModelCapabilities } from "../packages/model-catalog/src/index";
import { GatewayModelProvider, LangChainModelProvider } from "../packages/model-adapters/src/index";
import { AttachmentRepository, BrowserDatabase, ConversationRepository, SettingsRepository } from "../packages/persistence/src/index";
import type { ModelsDevCacheRecord, ProviderProfile } from "../packages/persistence/src/index";

const profile: ProviderProfile = {
  id: "profile-test",
  name: "测试供应商",
  kind: "openai-compatible",
  endpoint: "https://example.com/v1/responses",
  modelsEndpoint: "https://example.com/v1/models",
  defaultModelId: "manual-model",
  modelsDevProviderId: "openai",
  builtIn: false,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z"
};

test("模型能力按用户、供应商、models.dev 的优先级合并", () => {
  assert.deepEqual(mergeModelCapabilities(
    { imageInput: "unsupported" },
    { toolCalling: "supported", imageInput: "supported" },
    { toolCalling: "unsupported", imageInput: "supported", pdfInput: "supported", contextWindow: 128_000 }
  ), { toolCalling: "supported", imageInput: "unsupported", pdfInput: "supported", contextWindow: 128_000 });
});

test("供应商 /models 与 models.dev 元数据合并且保留手动模型", async () => {
  const cache = new MemoryCatalogCache({
    key: "models-dev-cache",
    fetchedAt: "2026-07-20T00:00:00.000Z",
    catalog: { openai: { models: { "served-model": { name: "Served", tool_call: true, limit: { context: 64_000 }, modalities: { input: ["text", "image"] } } } } }
  });
  const result = await discoverProviderModels(profile, {
    cache,
    now: () => new Date("2026-07-20T01:00:00.000Z"),
    fetcher: async () => Response.json({ data: [{ id: "served-model" }] })
  });
  const served = result.models.find((model) => model.id === "served-model");
  const manual = result.models.find((model) => model.id === "manual-model");
  assert.equal(canRunAgent(served!), true);
  assert.equal(canSendImages(served!), true);
  assert.equal(served?.capabilities.contextWindow, 64_000);
  assert.equal(manual?.capabilities.toolCalling, "unknown");
});

test("models.dev 缓存超过 24 小时后携带 ETag 并接受 304", async () => {
  const cache = new MemoryCatalogCache({ key: "models-dev-cache", etag: '"catalog-v1"', fetchedAt: "2026-07-18T00:00:00.000Z", catalog: { openai: { models: {} } } });
  let requestHeaders: Headers | undefined;
  const catalog = await loadModelsDevCatalog(cache, {
    now: () => new Date("2026-07-20T00:00:00.000Z"),
    fetcher: async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(null, { status: 304 });
    }
  });
  assert.equal(requestHeaders?.get("if-none-match"), '"catalog-v1"');
  assert.deepEqual(catalog, { openai: { models: {} } });
  assert.equal(cache.value?.fetchedAt, "2026-07-20T00:00:00.000Z");
});

test("API Key 按 Provider Profile 隔离并迁移旧会话键", () => {
  const storage = memoryStorage([["browser-agent-runtime:api-key", "legacy-secret"]]);
  assert.equal(readProviderApiKey("provider-a", storage), "legacy-secret");
  assert.equal(storage.getItem("browser-agent-runtime:api-key"), null);
  writeProviderApiKey("provider-b", "other-secret", storage);
  assert.equal(storage.getItem(providerApiKeySessionKey("provider-a")), "legacy-secret");
  assert.equal(storage.getItem(providerApiKeySessionKey("provider-b")), "other-secret");
});

test("OpenAI-compatible Profile 校验网址且不持久化 API Key", () => {
  const value = createOpenAICompatibleProfile({ id: "custom", name: " Local ", endpoint: " https://models.example/v1/responses ", defaultModelId: " model-a " });
  assert.equal(value.kind, "openai-compatible");
  assert.equal(value.modelsEndpoint, "https://models.example/v1/models");
  assert.equal(JSON.stringify(value).includes("apiKey"), false);
});

test("图片内容块转换为 LangChain data URL", async () => {
  const model = fakeModel().respond((messages) => {
    assert.ok(messages[0] instanceof HumanMessage);
    assert.deepEqual(messages[0].content, [
      { type: "text", text: "识别图片" },
      { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }
    ]);
    return new AIMessage("完成");
  });
  await new LangChainModelProvider(model, "test").runTurn({
    messages: [{ role: "user", content: [{ type: "text", text: "识别图片" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }],
    tools: []
  });
});

test("Gateway 每个请求携带所选 modelId 并传递取消信号", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let receivedBody: Record<string, unknown> | undefined;
  let receivedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    receivedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    receivedSignal = init?.signal;
    return Response.json({ text: "完成", toolCalls: [] });
  };
  try {
    await new GatewayModelProvider("http://127.0.0.1:8787", "model-per-thread").runTurn({ messages: [], tools: [] }, undefined, controller.signal);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(receivedBody?.modelId, "model-per-thread");
  assert.equal(receivedSignal, controller.signal);
});

test("删除对话时级联删除独立附件 Blob", async () => {
  const database = new BrowserDatabase();
  const conversations = new ConversationRepository(database);
  const attachments = new AttachmentRepository(database);
  const now = new Date().toISOString();
  const threadId = `thread-attachment-${crypto.randomUUID()}`;
  await conversations.putThread({ id: threadId, projectId: "project-1", title: "附件", createdAt: now, updatedAt: now });
  await attachments.put({ id: `attachment-${crypto.randomUUID()}`, threadId, name: "image.png", mimeType: "image/png", size: 3, blob: new Blob(["png"]), createdAt: now });
  assert.equal((await attachments.listForThread(threadId)).length, 1);
  await conversations.deleteThread(threadId);
  assert.equal((await attachments.listForThread(threadId)).length, 0);
});

test("数据库首次打开会建立内置 Provider Profiles", async () => {
  const profiles = await new SettingsRepository(new BrowserDatabase()).listProviderProfiles();
  assert.ok(["builtin-openai", "builtin-deepseek", "builtin-gateway"].every((id) => profiles.some((profile) => profile.id === id)));
});

class MemoryCatalogCache {
  constructor(public value?: ModelsDevCacheRecord) {}
  async getModelsDevCache(): Promise<ModelsDevCacheRecord | undefined> { return this.value; }
  async putModelsDevCache(value: ModelsDevCacheRecord): Promise<void> { this.value = value; }
}

function memoryStorage(entries: Array<[string, string]>): Storage {
  const values = new Map(entries);
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}
