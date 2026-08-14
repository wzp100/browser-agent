import type { CapabilityState, ModelCapabilities, ModelDescriptor, ModelsDevCacheRecord, ProviderProfile } from "../../persistence/src/index";

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const MODELS_DEV_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface ModelsDevCacheStore {
  getModelsDevCache(): Promise<ModelsDevCacheRecord | undefined>;
  putModelsDevCache(record: ModelsDevCacheRecord): Promise<void>;
}

export interface ModelDiscoveryOptions {
  apiKey?: string;
  manualModelId?: string;
  queryProvider?: boolean;
  cache?: ModelsDevCacheStore;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface ModelDiscoveryResult {
  models: ModelDescriptor[];
  providerError?: string;
  catalogError?: string;
}

interface ProviderModel {
  id?: unknown;
  name?: unknown;
  context_window?: unknown;
  input_modalities?: unknown;
  capabilities?: unknown;
  tool_call?: unknown;
}

interface ModelsDevModel {
  id?: unknown;
  name?: unknown;
  tool_call?: unknown;
  attachment?: unknown;
  limit?: { context?: unknown };
  modalities?: { input?: unknown };
}

export async function discoverProviderModels(profile: ProviderProfile, options: ModelDiscoveryOptions = {}): Promise<ModelDiscoveryResult> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  let providerModels: ProviderModel[] = [];
  let providerError: string | undefined;
  if (options.queryProvider !== false) {
    try {
      const response = await fetcher(modelsEndpoint(profile), {
        ...(options.apiKey ? { headers: { Authorization: `Bearer ${options.apiKey}` } } : {}),
        ...(options.signal ? { signal: options.signal } : {})
      });
      if (!response.ok) throw new Error(`模型列表接口返回 ${response.status}`);
      const body = await response.json() as { data?: unknown; models?: unknown } | unknown[];
      const candidates = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
      providerModels = candidates.filter((item): item is ProviderModel => Boolean(item && typeof item === "object" && typeof (item as ProviderModel).id === "string"));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      providerError = errorMessage(error);
    }
  }

  let catalog: unknown;
  let catalogError: string | undefined;
  try { catalog = options.cache ? await loadModelsDevCatalog(options.cache, { fetcher, now, ...(options.signal ? { signal: options.signal } : {}) }) : undefined; }
  catch (error) {
    if (options.signal?.aborted) throw error;
    catalogError = errorMessage(error);
  }

  const ids = new Set(providerModels.map((item) => String(item.id)));
  const manualModelId = options.manualModelId?.trim() || profile.defaultModelId.trim();
  if (manualModelId) ids.add(manualModelId);
  const metadata = modelsDevModels(catalog, profile.modelsDevProviderId);
  const providerById = new Map(providerModels.map((item) => [String(item.id), item]));
  const descriptors = [...ids].map((id) => {
    const providerModel = providerById.get(id);
    const catalogModel = metadata.get(id);
    const capabilities = mergeModelCapabilities(
      profile.capabilityOverrides?.[id],
      providerCapabilities(providerModel),
      modelsDevCapabilities(catalogModel)
    );
    return {
      id,
      name: stringValue(providerModel?.name) ?? stringValue(catalogModel?.name) ?? id,
      providerProfileId: profile.id,
      capabilities,
      source: providerModel ? "provider" : catalogModel ? "models.dev" : "manual"
    } satisfies ModelDescriptor;
  });
  descriptors.sort((left, right) => left.name.localeCompare(right.name));
  return {
    models: descriptors,
    ...(providerError ? { providerError } : {}),
    ...(catalogError ? { catalogError } : {})
  };
}

export async function loadModelsDevCatalog(
  cache: ModelsDevCacheStore,
  options: { fetcher?: typeof fetch; signal?: AbortSignal; now?: () => Date } = {}
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  const cached = await cache.getModelsDevCache();
  const nowDate = now();
  if (cached && nowDate.getTime() - new Date(cached.fetchedAt).getTime() < MODELS_DEV_MAX_AGE_MS) return cached.catalog;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  const response = await fetcher(MODELS_DEV_URL, { headers, ...(options.signal ? { signal: options.signal } : {}) });
  if (response.status === 304 && cached) {
    await cache.putModelsDevCache({ ...cached, fetchedAt: nowDate.toISOString() });
    return cached.catalog;
  }
  if (!response.ok) {
    if (cached) return cached.catalog;
    throw new Error(`models.dev 返回 ${response.status}`);
  }
  const catalog = await response.json() as unknown;
  const etag = response.headers.get("etag") ?? undefined;
  await cache.putModelsDevCache({ key: "models-dev-cache", fetchedAt: nowDate.toISOString(), catalog, ...(etag ? { etag } : {}) });
  return catalog;
}

export function mergeModelCapabilities(
  user: Partial<ModelCapabilities> | undefined,
  provider: Partial<ModelCapabilities> | undefined,
  catalog: Partial<ModelCapabilities> | undefined
): ModelCapabilities {
  const merged: ModelCapabilities = {
    toolCalling: pickState(user?.toolCalling, provider?.toolCalling, catalog?.toolCalling),
    imageInput: pickState(user?.imageInput, provider?.imageInput, catalog?.imageInput),
    pdfInput: pickState(user?.pdfInput, provider?.pdfInput, catalog?.pdfInput)
  };
  const contextWindow = pickPositiveInteger(user?.contextWindow, provider?.contextWindow, catalog?.contextWindow);
  if (contextWindow !== undefined) merged.contextWindow = contextWindow;
  return merged;
}

export function canRunAgent(model: ModelDescriptor): boolean { return model.capabilities.toolCalling === "supported"; }
export function canSendImages(model: ModelDescriptor): boolean { return model.capabilities.imageInput === "supported"; }

export function modelsEndpoint(profile: ProviderProfile): string {
  if (profile.modelsEndpoint) return profile.modelsEndpoint;
  const endpoint = profile.endpoint.trim().replace(/\/$/, "");
  if (profile.kind === "gateway") return `${endpoint}/v1/models`;
  return `${endpoint.replace(/\/(?:responses|chat\/completions)$/i, "")}/models`;
}

function providerCapabilities(model: ProviderModel | undefined): Partial<ModelCapabilities> | undefined {
  if (!model) return undefined;
  const source = model.capabilities && typeof model.capabilities === "object" ? model.capabilities as Record<string, unknown> : {};
  const modalities = arrayValue(model.input_modalities ?? source.input_modalities);
  return compactCapabilities({
    toolCalling: stateValue(model.tool_call ?? source.tool_call ?? source.toolCalling),
    imageInput: modalities ? stateFromIncludes(modalities, "image") : stateValue(source.imageInput),
    pdfInput: modalities ? stateFromIncludes(modalities, "pdf") : stateValue(source.pdfInput),
    contextWindow: positiveInteger(model.context_window ?? source.context_window ?? source.contextWindow)
  });
}

function modelsDevCapabilities(model: ModelsDevModel | undefined): Partial<ModelCapabilities> | undefined {
  if (!model) return undefined;
  const modalities = arrayValue(model.modalities?.input);
  return compactCapabilities({
    toolCalling: stateValue(model.tool_call),
    imageInput: modalities ? stateFromIncludes(modalities, "image") : undefined,
    pdfInput: modalities ? stateFromIncludes(modalities, "pdf") : undefined,
    contextWindow: positiveInteger(model.limit?.context)
  });
}

function modelsDevModels(catalog: unknown, providerId: string | undefined): Map<string, ModelsDevModel> {
  if (!providerId || !catalog || typeof catalog !== "object") return new Map();
  const provider = (catalog as Record<string, unknown>)[providerId];
  if (!provider || typeof provider !== "object") return new Map();
  const models = (provider as { models?: unknown }).models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return new Map();
  return new Map(Object.entries(models as Record<string, ModelsDevModel>).map(([id, model]) => [id, model]));
}

function compactCapabilities(value: { toolCalling?: CapabilityState | undefined; imageInput?: CapabilityState | undefined; pdfInput?: CapabilityState | undefined; contextWindow?: number | undefined }): Partial<ModelCapabilities> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<ModelCapabilities>;
}
function pickState(...values: Array<CapabilityState | undefined>): CapabilityState { return values.find((value) => value !== undefined) ?? "unknown"; }
function pickPositiveInteger(...values: Array<number | undefined>): number | undefined { return values.find((value) => value !== undefined); }
function stateValue(value: unknown): CapabilityState | undefined {
  if (value === true || value === "supported") return "supported";
  if (value === false || value === "unsupported") return "unsupported";
  if (value === "unknown") return "unknown";
  return undefined;
}
function stateFromIncludes(values: string[], expected: string): CapabilityState { return values.includes(expected) ? "supported" : "unsupported"; }
function positiveInteger(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined; }
function arrayValue(value: unknown): string[] | undefined { return Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => item.toLowerCase()) : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
