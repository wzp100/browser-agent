import type { AppLogLevel } from "../../logging/src/index";

export type ProjectPermissionHint = "granted" | "prompt" | "denied" | "missing";
export type MessageRole = "user" | "assistant" | "system";
export type MessageKind = "user" | "assistant" | "tool" | "terminal" | "error";
export type CapabilityState = "supported" | "unsupported" | "unknown";
export type ProviderKind = "openai" | "deepseek" | "gateway" | "openai-compatible";

export interface ModelCapabilities {
  toolCalling: CapabilityState;
  imageInput: CapabilityState;
  pdfInput: CapabilityState;
  contextWindow?: number;
}

export interface ModelDescriptor {
  id: string;
  name: string;
  providerProfileId: string;
  capabilities: ModelCapabilities;
  source: "provider" | "models.dev" | "manual";
}

export interface ProviderProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  endpoint: string;
  modelsEndpoint?: string;
  defaultModelId: string;
  modelsDevProviderId?: string;
  builtIn: boolean;
  capabilityOverrides?: Record<string, Partial<ModelCapabilities>>;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadModelSelection {
  providerProfileId: string;
  modelId: string;
}

export interface PersistedDirectoryHandle {
  readonly kind: "directory";
  readonly name: string;
  isSameEntry?(other: PersistedDirectoryHandle): Promise<boolean>;
  queryPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}

export interface ProjectRecord {
  id: string;
  name: string;
  directoryHandle?: PersistedDirectoryHandle;
  permissionHint: ProjectPermissionHint;
  legacyRelinkRequired: boolean;
  permissionMode?: "readOnly" | "confirmWrites" | "auto";
  instructionsEnabled?: boolean;
  networkAllowlist?: string[];
  createdAt: string;
  lastOpenedAt: string;
}

export interface ThreadRecord {
  id: string;
  projectId: string;
  title: string;
  modelConfigId?: string;
  modelSelection?: ThreadModelSelection;
  contextSummary?: ContextSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ContextSummary {
  content: string;
  throughSequence: number;
  sourceMessageCount: number;
  model: string;
  updatedAt: string;
}

export interface AttachmentRecord {
  id: string;
  threadId: string;
  messageId?: string;
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  size: number;
  blob: Blob;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  threadId: string;
  sequence: number;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  threadId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  intent: string;
  providerMode?: ModelSettingsRecord["mode"];
  model?: string;
  endpointOrigin?: string;
  retryOf?: string;
  inputMessageId?: string;
  changeSetId?: string;
  checkpoint?: unknown;
  events: Array<{ at: string; kind: "phase" | "tool" | "error"; content: string; eventKind?: "tool-start" | "tool-result" | "error"; toolName?: string; networkHost?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProbeRecord {
  id: string;
  providerProfileId: string;
  modelId: string;
  endpointOrigin: string;
  text: boolean;
  toolCalling: boolean;
  imageInput: boolean;
  streaming: boolean;
  testedAt: string;
  details?: Record<string, string>;
}

export interface ModelSettingsRecord {
  key: "model";
  mode: "direct" | "deepseek" | "gateway";
  endpoint: string;
  model: string;
}

export interface LoggingSettingsRecord {
  key: "logging";
  level: AppLogLevel;
  enabled?: boolean;
  projectFileEnabled?: boolean;
}

export interface ModelsDevCacheRecord {
  key: "models-dev-cache";
  etag?: string;
  fetchedAt: string;
  catalog: unknown;
}

export interface McpServerRecord {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastTestedAt?: string;
  lastToolCount?: number;
  lastError?: string;
  cachedTools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  createdAt: string;
  updatedAt: string;
}

export interface McpSettingsRecord {
  key: "mcp-servers";
  servers: McpServerRecord[];
}
