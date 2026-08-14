import { logger } from "../../../packages/logging/src/index";
import { discoverProviderModels, type ModelDiscoveryResult } from "../../../packages/model-catalog/src/index";
import type { ModelProvider } from "../../../packages/model-adapters/src/index";
import { type ModelSettingsRecord, type ProviderProfile, SettingsRepository } from "../../../packages/persistence/src/index";
import { AppUi } from "./ui";
import { providerProfileFromLegacy, readProviderApiKey, validateModelSettings, writeProviderApiKey } from "./model-settings";

const DEFAULT_SETTINGS: ModelSettingsRecord = { key: "model", mode: "direct", endpoint: "https://api.openai.com/v1/responses", model: "gpt-5.6" };
const modelLog = logger("web.model-settings");

export class ModelSettingsController {
  current: ModelSettingsRecord = DEFAULT_SETTINGS;
  currentProfile: ProviderProfile = providerProfileFromLegacy(DEFAULT_SETTINGS);
  profiles: ProviderProfile[] = [];
  private globalProviderProfileId = this.currentProfile.id;
  private globalModelId = DEFAULT_SETTINGS.model;

  get globalSelection(): { providerProfileId: string; modelId: string } { return { providerProfileId: this.globalProviderProfileId, modelId: this.globalModelId }; }

  constructor(private readonly ui: AppUi, private readonly repository: SettingsRepository) {}

  async load(): Promise<void> {
    this.current = await this.repository.getModel() ?? DEFAULT_SETTINGS;
    this.profiles = await this.repository.listProviderProfiles();
    const migrated = providerProfileFromLegacy(this.current);
    this.currentProfile = this.profiles.find((profile) => profile.id === migrated.id) ?? migrated;
    if (!this.profiles.some((profile) => profile.id === this.currentProfile.id)) {
      await this.repository.putProviderProfile(this.currentProfile);
      this.profiles = await this.repository.listProviderProfiles();
    }
    this.globalProviderProfileId = this.currentProfile.id;
    this.globalModelId = this.current.model;
    this.ui.providerMode.value = this.current.mode;
    this.ui.providerUrl.value = this.current.endpoint;
    this.ui.modelName.value = this.current.model;
    this.ui.apiKey.value = readProviderApiKey(this.currentProfile.id);
    this.updateActiveModel();
    this.ui.modelHelp.textContent = "模型不会自动收到整个项目；文件内容只在工具按需读取后进入上下文。";
  }

  async createProvider(): Promise<ModelProvider> {
    const { createLangChainModelProvider, GatewayModelProvider } = await import("../../../packages/model-adapters/src/index");
    const apiKey = readProviderApiKey(this.currentProfile.id);
    if (this.current.mode === "gateway") return new GatewayModelProvider(this.current.endpoint, this.current.model);
    return createLangChainModelProvider({
      provider: this.current.mode === "deepseek" ? "deepseek" : "openai",
      endpoint: this.current.endpoint,
      model: this.current.model,
      apiKey
    });
  }

  hasConfiguration(): boolean {
    return Boolean(this.current.endpoint && this.current.model && (this.current.mode === "gateway" || readProviderApiKey(this.currentProfile.id)));
  }

  applyProviderDefaults(): void {
    if (this.ui.providerMode.value === "deepseek") { this.ui.providerUrl.value = "https://api.deepseek.com/chat/completions"; this.ui.modelName.value = "deepseek-chat"; }
    else if (this.ui.providerMode.value === "direct") { this.ui.providerUrl.value = "https://api.openai.com/v1/responses"; this.ui.modelName.value = "gpt-5.6"; }
    else { this.ui.providerUrl.value = "http://127.0.0.1:8787"; this.ui.modelName.value = "gpt-5.6"; }
  }

  async save(projectConnected: boolean): Promise<void> {
    const mode = this.ui.providerMode.value === "gateway" ? "gateway" : this.ui.providerMode.value === "direct" ? "direct" : "deepseek";
    const validation = validateModelSettings({ mode, endpoint: this.ui.providerUrl.value, model: this.ui.modelName.value });
    if (!validation.ok) { this.ui.modelHelp.textContent = validation.message; return; }

    const apiKey = this.ui.apiKey.value.trim();
    this.ui.saveModel.disabled = true;
    this.ui.modelHelp.textContent = mode === "gateway" && apiKey ? "正在连接 Gateway…" : "正在保存…";
    try {
      if (mode !== this.current.mode) {
        const targetId = mode === "gateway" ? "builtin-gateway" : mode === "deepseek" ? "builtin-deepseek" : "builtin-openai";
        this.currentProfile = this.profiles.find((profile) => profile.id === targetId) ?? providerProfileFromLegacy(validation.settings);
      }
      this.current = validation.settings;
      await this.repository.putModel(this.current);
      this.currentProfile = {
        ...this.currentProfile,
        endpoint: this.current.endpoint,
        defaultModelId: this.current.model,
        ...(mode === "gateway" ? {} : { modelsEndpoint: `${this.current.endpoint.replace(/\/(?:responses|chat\/completions)\/?$/i, "").replace(/\/$/, "")}/models` }),
        updatedAt: new Date().toISOString()
      };
      await this.repository.putProviderProfile(this.currentProfile);
      this.globalProviderProfileId = this.currentProfile.id;
      this.globalModelId = this.current.model;
      this.updateActiveModel();
      modelLog.info("模型配置已保存", { mode, endpointOrigin: safeOrigin(this.current.endpoint), model: this.current.model, apiKeyPresent: Boolean(apiKey) });
      writeProviderApiKey(this.currentProfile.id, apiKey);
      if (mode === "gateway" && apiKey && !await this.syncGateway(apiKey)) return;
      this.ui.modelHelp.textContent = mode !== "gateway" && !apiKey
        ? "模型配置已保存；发送任务前还需填写 API Key。"
        : "已保存。API Key 仅保留在当前浏览器会话。";
      this.ui.setBusy(false, projectConnected
        ? (this.hasConfiguration() ? "模型和项目已就绪" : "请在设置中配置模型 API")
        : (this.hasConfiguration() ? "项目未连接，文件工具不可用" : "请先配置模型 API"));
    } finally { this.ui.saveModel.disabled = false; }
  }

  async selectProfile(profileId: string, persistGlobal = true): Promise<void> {
    const profile = this.profiles.find((item) => item.id === profileId) ?? await this.repository.getProviderProfile(profileId);
    if (!profile) throw new Error(`找不到模型供应商：${profileId}`);
    this.currentProfile = profile;
    this.current = {
      key: "model",
      mode: profile.kind === "gateway" ? "gateway" : profile.kind === "deepseek" ? "deepseek" : "direct",
      endpoint: profile.endpoint,
      model: profile.defaultModelId
    };
    this.ui.providerMode.value = this.current.mode;
    this.ui.providerUrl.value = this.current.endpoint;
    this.ui.modelName.value = this.current.model;
    this.ui.apiKey.value = readProviderApiKey(profile.id);
    if (persistGlobal) {
      await this.repository.putModel(this.current);
      this.globalProviderProfileId = profile.id;
      this.globalModelId = profile.defaultModelId;
    }
    this.updateActiveModel();
  }

  async selectModel(modelId: string, persistGlobal = true): Promise<void> {
    const normalized = modelId.trim();
    if (!normalized) throw new Error("模型 ID 不能为空。");
    const updatedAt = new Date().toISOString();
    this.current = { ...this.current, model: normalized };
    if (persistGlobal) this.currentProfile = { ...this.currentProfile, defaultModelId: normalized, updatedAt };
    this.ui.modelName.value = normalized;
    if (persistGlobal) {
      await Promise.all([
        this.repository.putModel(this.current),
        this.repository.putProviderProfile(this.currentProfile)
      ]);
      this.globalProviderProfileId = this.currentProfile.id;
      this.globalModelId = normalized;
    }
    this.updateActiveModel();
  }

  refreshModels(signal?: AbortSignal): Promise<ModelDiscoveryResult> {
    const apiKey = readProviderApiKey(this.currentProfile.id);
    return discoverProviderModels(this.currentProfile, {
      apiKey,
      manualModelId: this.current.model,
      queryProvider: this.currentProfile.kind === "gateway" || Boolean(apiKey) || !this.currentProfile.builtIn,
      cache: this.repository,
      ...(signal ? { signal } : {})
    });
  }

  private async syncGateway(apiKey: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${this.current.endpoint.replace(/\/$/, "")}/v1/settings/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, model: this.current.model }),
        signal: controller.signal
      });
      if (!response.ok) {
        this.ui.modelHelp.textContent = `配置已保存，但 Gateway 返回 ${response.status}。请检查地址和服务日志。`;
        this.ui.setBusy(false, "Gateway 配置需要检查");
        return false;
      }
      return true;
    } catch (error) {
      modelLog.error("Gateway 配置同步失败", { endpointOrigin: safeOrigin(this.current.endpoint) }, error);
      this.ui.modelHelp.textContent = controller.signal.aborted
        ? "配置已保存，但 Gateway 连接超时。请确认服务已启动且地址正确。"
        : `配置已保存，但无法连接 Gateway：${errorMessage(error)}`;
      this.ui.setBusy(false, "Gateway 连接失败");
      return false;
    } finally { clearTimeout(timeout); }
  }

  private updateActiveModel(): void {
    const provider = this.currentProfile.name || (this.current.mode === "direct" ? "OpenAI" : this.current.mode === "gateway" ? "Gateway" : "DeepSeek");
    this.ui.activeModel.textContent = `${provider} · ${this.current.model}`;
    this.ui.activeModel.title = `Provider: ${provider}\nModel: ${this.current.model}\nEndpoint: ${safeOrigin(this.current.endpoint)}`;
  }
}

function safeOrigin(value: string): string { try { return new URL(value).origin; } catch { return "invalid-url"; } }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
