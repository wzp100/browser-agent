import type { ModelSettingsRecord, ProviderProfile } from "../../../packages/persistence/src/index";

const LEGACY_API_KEY = "browser-agent-runtime:api-key";
const PROFILE_API_KEY_PREFIX = "browser-agent-runtime:provider-api-key:";

export interface ModelSettingsDraft {
  mode: ModelSettingsRecord["mode"];
  endpoint: string;
  model: string;
}

export interface ProviderProfileDraft {
  id?: string;
  name: string;
  endpoint: string;
  modelsEndpoint?: string;
  defaultModelId: string;
  modelsDevProviderId?: string;
}

export type ModelSettingsValidation =
  | { ok: true; settings: ModelSettingsRecord }
  | { ok: false; message: string };

export function validateModelSettings(draft: ModelSettingsDraft): ModelSettingsValidation {
  const endpoint = draft.endpoint.trim();
  const model = draft.model.trim();
  if (!endpoint || !model) return { ok: false, message: "Endpoint 和模型不能为空。" };

  let url: URL;
  try { url = new URL(endpoint); }
  catch { return { ok: false, message: "API Endpoint 不是有效的网址。" }; }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "API Endpoint 仅支持 HTTP 或 HTTPS。" };
  }
  if (url.username || url.password) {
    return { ok: false, message: "请勿在 API Endpoint 中包含用户名或密码。" };
  }

  return { ok: true, settings: { key: "model", mode: draft.mode, endpoint, model } };
}

export function providerApiKeySessionKey(profileId: string): string {
  return `${PROFILE_API_KEY_PREFIX}${encodeURIComponent(profileId)}`;
}

export function readProviderApiKey(profileId: string, storage: Storage = sessionStorage): string {
  const key = providerApiKeySessionKey(profileId);
  const value = storage.getItem(key);
  if (value !== null) return value;
  const legacy = storage.getItem(LEGACY_API_KEY);
  if (legacy !== null) {
    storage.setItem(key, legacy);
    storage.removeItem(LEGACY_API_KEY);
    return legacy;
  }
  return "";
}

export function writeProviderApiKey(profileId: string, apiKey: string, storage: Storage = sessionStorage): void {
  const key = providerApiKeySessionKey(profileId);
  const normalized = apiKey.trim();
  if (normalized) storage.setItem(key, normalized);
  else storage.removeItem(key);
}

export function providerProfileFromLegacy(settings: ModelSettingsRecord, now = new Date().toISOString()): ProviderProfile {
  const id = settings.mode === "gateway" ? "builtin-gateway" : settings.mode === "deepseek" ? "builtin-deepseek" : "builtin-openai";
  const profile: ProviderProfile = {
    id,
    name: settings.mode === "gateway" ? "Gateway" : settings.mode === "deepseek" ? "DeepSeek" : "OpenAI",
    kind: settings.mode === "direct" ? "openai" : settings.mode,
    endpoint: settings.endpoint,
    defaultModelId: settings.model,
    modelsDevProviderId: settings.mode === "deepseek" ? "deepseek" : "openai",
    builtIn: true,
    createdAt: now,
    updatedAt: now
  };
  if (settings.mode !== "gateway") profile.modelsEndpoint = `${settings.endpoint.replace(/\/(?:responses|chat\/completions)\/?$/i, "").replace(/\/$/, "")}/models`;
  return profile;
}

export function createOpenAICompatibleProfile(draft: ProviderProfileDraft, now = new Date().toISOString()): ProviderProfile {
  const name = draft.name.trim();
  const endpoint = validateHttpEndpoint(draft.endpoint, "API Endpoint");
  const defaultModelId = draft.defaultModelId.trim();
  if (!name || !defaultModelId) throw new Error("供应商名称和默认模型不能为空。");
  const modelsEndpoint = draft.modelsEndpoint?.trim()
    ? validateHttpEndpoint(draft.modelsEndpoint, "模型列表 Endpoint")
    : `${endpoint.replace(/\/(?:responses|chat\/completions)\/?$/i, "").replace(/\/$/, "")}/models`;
  return {
    id: draft.id?.trim() || crypto.randomUUID(),
    name,
    kind: "openai-compatible",
    endpoint,
    modelsEndpoint,
    defaultModelId,
    ...(draft.modelsDevProviderId?.trim() ? { modelsDevProviderId: draft.modelsDevProviderId.trim() } : {}),
    builtIn: false,
    createdAt: now,
    updatedAt: now
  };
}

function validateHttpEndpoint(value: string, label: string): string {
  const endpoint = value.trim();
  let url: URL;
  try { url = new URL(endpoint); }
  catch { throw new Error(`${label} 不是有效的网址。`); }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) throw new Error(`${label} 仅支持 HTTP 或 HTTPS。`);
  if (url.username || url.password) throw new Error(`请勿在 ${label} 中包含用户名或密码。`);
  return endpoint;
}
