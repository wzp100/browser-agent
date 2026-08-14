import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AgentCheckpointV2, AgentEvent, SteeringRecord } from "../../../packages/agent-kernel/src/index";
import { AgentSession, shouldAutoStartFollowUp } from "../../../packages/agent-session/src/index";
import { chunkContextMessagesForSummary, formatAgentTaskCompactionState, selectCompleteToolRounds, selectContextMessages } from "../../../packages/context-manager/src/index";
import { composeLogSinks, configureLogging, flushLogs, logger, type AppLogLevel } from "../../../packages/logging/src/index";
import { McpHttpClient, registerConfiguredMcpTools, validateMcpUrl } from "../../../packages/mcp-client/src/index";
import type { AgentModelMessage, ConversationTurn, ModelContentPart, ModelProvider } from "../../../packages/model-adapters/src/index";
import { canRunAgent, canSendImages } from "../../../packages/model-catalog/src/index";
import { registerOfficeAgentTools } from "../../../packages/office-pack/src/index";
import {
  BrowserLogStore,
  BrowserDatabase,
  ConversationRepository,
  AttachmentRepository,
  migrateLegacyConversations,
  ProjectRepository,
  requestPersistentBrowserStorage,
  SettingsRepository,
  ModelProbeRepository,
  queuedMessageMetadata,
  type MessageKind,
  type McpServerRecord,
  type MessageRecord,
  type AttachmentRecord,
  type ModelDescriptor,
  type PersistedDirectoryHandle,
  type ProjectRecord,
  type RunRecord,
  type QueuedMessageKind,
  type ThreadRecord
} from "../../../packages/persistence/src/index";
import { loadProjectInstructions } from "../../../packages/project-context/src/index";
import { importProjectBackup, serializeProjectBackup, type ProjectBackupImportBundle } from "../../../packages/project-backup/src/index";
import type { InteractiveRuntimeSession, RuntimeSession, ScriptExecutionRequest, ScriptExecutionResult, ScriptRuntimeProvider, TerminalDimensions } from "../../../packages/runtime-contracts/src/index";
import { ProjectVirtualFileSystem, VirtualRuntimeProvider } from "../../../packages/runtime-virtual/src/index";
import { BrowserSkillStore, SkillRegistry, skillFromMarkdown, type SkillDescriptor, type SkillFile } from "../../../packages/skill-core/src/index";
import { appendWorkspaceFileLinks, browserAgentRunScratchDirectory, BROWSER_AGENT_PACKAGE_DIRECTORY, BROWSER_AGENT_STATE_DIRECTORY, isBrowserAgentInternalPath, OpfsChangeJournal, ProjectFileLogSink, ProjectFileService, resolveDirectoryPermission, type BrowserDirectoryHandle } from "../../../packages/workspace-contracts/src/index";
import { AppUi } from "./ui";
import { ModelSettingsController } from "./model-settings-controller";
import { createOpenAICompatibleProfile } from "./model-settings";
import { probeModel } from "./model-probe";
import { appLocale, readLocalePreference, saveLocalePreference, t, type AppLocalePreference } from "./i18n";

type DirectoryPickerWindow = Window & { showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<BrowserDirectoryHandle> };

const LAST_THREAD = "browser-agent-runtime:last-thread";
const DEFAULT_LOG_LEVEL: AppLogLevel = "debug";
const appLog = logger("web.app");

export class BrowserAgentApp {
  private readonly ui = new AppUi();
  private readonly database = new BrowserDatabase();
  private readonly projects = new ProjectRepository(this.database);
  private readonly conversations = new ConversationRepository(this.database);
  private readonly attachments = new AttachmentRepository(this.database);
  private readonly settings = new SettingsRepository(this.database);
  private readonly modelProbes = new ModelProbeRepository(this.database);
  private readonly models = new ModelSettingsController(this.ui, this.settings);
  private readonly logStore = new BrowserLogStore(this.database);
  private readonly skills = new SkillRegistry(new BrowserSkillStore());
  private runtime: VirtualRuntimeProvider | undefined;
  private readonly terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.25,
    theme: { background: "#0c1113", foreground: "#c6d0d5", cursor: "#dce2e5", black: "#0c1113", green: "#75c89b", cyan: "#76cbd2", red: "#ef8585" }
  });
  private readonly fit = new FitAddon();
  private activeProject: ProjectRecord | undefined;
  private activeThread: ThreadRecord | undefined;
  private activeMessages: MessageRecord[] = [];
  private composerAttachments: AttachmentRecord[] = [];
  private attachmentPreviewUrls = new Map<string, string>();
  private historyAttachmentPreviewUrls = new Map<string, string>();
  private availableModels: ModelDescriptor[] = [];
  private fileService: ProjectFileService | undefined;
  private interactiveSession: InteractiveRuntimeSession | undefined;
  private terminalBuffer = "";
  private terminalFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private runtimeStartPromise: Promise<void> | undefined;
  private busy = false;
  private activeRunController: AbortController | undefined;
  private activeAgentSession: AgentSession | undefined;
  private activeRunId: string | undefined;
  private allowWritesForCurrentRun = false;
  private loggingEnabled = true;
  private projectLoggingEnabled = false;
  private terminalCollapsed = true;
  private mcpServers: McpServerRecord[] = [];

  async boot(): Promise<void> {
    appLog.info("开始启动 Browser Agent", { url: location.href, userAgent: navigator.userAgent, runtime: "QuickJS/WASM" });
    this.terminal.loadAddon(this.fit);
    this.terminal.open(this.ui.terminalHost);
    this.fit.fit();
    this.terminal.writeln("\x1b[90mBrowser Agent Virtual Runtime · QuickJS/WASM\x1b[0m");
    this.terminal.writeln(`\x1b[90m${t("选择项目后点击“启动 Runtime”。", "Select a project, then choose Start Runtime.")}\x1b[0m`);
    new ResizeObserver(() => { this.fit.fit(); this.interactiveSession?.resize(this.dimensions()); }).observe(this.ui.terminalHost);
    this.terminal.onData((data) => { if (this.interactiveSession) void this.interactiveSession.write(data); });
    this.bindEvents();
    this.ui.appLanguage.value = readLocalePreference();
    await this.database.open();
    this.mcpServers = await this.settings.getMcpServers();
    this.renderMcpManager();
    const loggingSettings = await this.settings.getLogging();
    const loggingLevel = loggingSettings?.level ?? DEFAULT_LOG_LEVEL;
    this.loggingEnabled = loggingSettings?.enabled !== false;
    this.projectLoggingEnabled = loggingSettings?.projectFileEnabled === true;
    this.ui.logLevel.value = loggingLevel;
    this.ui.loggingEnabled.checked = this.loggingEnabled;
    this.ui.projectLoggingEnabled.checked = this.projectLoggingEnabled;
    this.configureAppLogging();
    appLog.info("诊断日志系统已就绪", { level: loggingLevel, storage: "IndexedDB" });
    const migrated = await migrateLegacyConversations(this.database);
    void requestPersistentBrowserStorage();
    await this.models.load();
    this.ui.setComposerModelOptions(this.models.profiles, []);
    this.ui.setModelSelection(this.models.currentProfile.id, this.models.current.model);
    await this.loadSkills();
    await this.refreshSidebar();
    const requestedThread = sessionStorage.getItem(LAST_THREAD);
    const threads = await this.conversations.listThreads();
    await this.interruptStaleRuns(threads);
    const initial = threads.find((thread) => thread.id === requestedThread) ?? threads[0];
    if (initial) await this.openThread(initial.id);
    if (migrated) this.ui.toast(`已迁移 ${migrated} 条历史对话；旧项目需要重新关联一次文件夹。`);
    await this.updateStorageUsage();
    appLog.info("Browser Agent 启动完成", { projects: (await this.projects.list()).length, threads: threads.length, migrated });
  }

  private bindEvents(): void {
    this.ui.setWorkspaceFileOpener((path) => this.openWorkspaceFile(path));
    this.ui.setAttachmentHandler((files) => this.addComposerAttachments(files), (id) => this.removeComposerAttachment(id));
    this.ui.setQueuedMessageHandler((messageId) => this.withdrawQueuedMessage(messageId));
    this.ui.newProject.addEventListener("click", () => void this.newProject());
    this.ui.pluginsTrigger.addEventListener("click", () => {
      this.renderSkillManager();
      this.renderMcpManager();
      this.ui.pluginsDialog.showModal();
    });
    this.ui.send.addEventListener("click", () => void this.send());
    this.ui.stopRun.addEventListener("click", () => this.stopActiveRun());
    this.ui.composerProvider.addEventListener("change", () => void this.changeComposerProvider());
    this.ui.composerModel.addEventListener("change", () => void this.changeComposerModel());
    this.ui.refreshModels.addEventListener("click", () => void this.refreshModelCatalog(true));
    this.ui.compressContext.addEventListener("click", () => void this.compressContextNow());
    this.ui.permissionMode.addEventListener("change", () => void this.changeProjectPermissionMode());
    this.ui.projectInstructionsEnabled.addEventListener("change", () => void this.changeProjectInstructions());
    this.ui.filePanelTrigger.addEventListener("click", () => void this.refreshProjectPanels());
    this.ui.runPanelTrigger.addEventListener("click", () => void this.refreshProjectPanels());
    this.ui.exportLocalData.addEventListener("click", () => void this.exportProjectData());
    this.ui.importLocalDataInput.addEventListener("change", () => void this.importProjectData());
    this.ui.intent.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.send(); }
    });
    this.ui.terminalStart.addEventListener("click", () => { void this.ensureRuntime(true).catch(() => undefined); });
    this.ui.terminalToggle.addEventListener("click", () => this.setTerminalCollapsed(!this.terminalCollapsed));
    this.ui.terminalClear.addEventListener("click", () => void this.clearTerminalHistory());
    this.ui.settingsTrigger.addEventListener("click", () => { this.ui.settingsDialog.showModal(); void this.updateStorageUsage(); void this.refreshLogs(); });
    this.ui.appLanguage.addEventListener("change", () => {
      if (!saveLocalePreference(this.ui.appLanguage.value as AppLocalePreference)) {
        this.ui.toast("无法保存语言设置。");
        this.ui.appLanguage.value = readLocalePreference();
        return;
      }
      location.reload();
    });
    this.ui.providerMode.addEventListener("change", () => this.models.applyProviderDefaults());
    this.ui.saveModel.addEventListener("click", () => void this.models.save(Boolean(this.fileService)));
    this.ui.quickTestModel.addEventListener("click", () => void this.quickTestModel());
    this.ui.addProvider.addEventListener("click", () => void this.addCompatibleProvider());
    this.ui.installSkill.addEventListener("click", () => void this.installSkillFolder());
    this.ui.refreshProjectSkills.addEventListener("click", () => void this.loadProjectSkills());
    this.ui.addMcpServer.addEventListener("click", () => void this.addMcpServer());
    this.ui.logLevel.addEventListener("change", () => void this.changeLogLevel());
    this.ui.loggingEnabled.addEventListener("change", () => void this.changeLoggingSettings());
    this.ui.projectLoggingEnabled.addEventListener("change", () => void this.changeLoggingSettings());
    this.ui.refreshLogs.addEventListener("click", () => void this.refreshLogs());
    this.ui.exportLogs.addEventListener("click", () => void this.exportLogs());
    this.ui.clearLogs.addEventListener("click", () => void this.clearLogs());
    window.addEventListener("focus", () => { if (this.fileService) void this.fileService.refresh(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && this.fileService) void this.fileService.refresh(); });
  }

  private async newProject(): Promise<void> {
    appLog.info("用户开始新建项目任务");
    const handle = await this.pickDirectory("readwrite");
    if (!handle) { appLog.debug("用户取消选择新项目文件夹"); return; }
    let project = await this.projects.findByHandle(handle as unknown as PersistedDirectoryHandle);
    const existing = Boolean(project);
    const now = new Date().toISOString();
    if (project) project = { ...project, name: handle.name, directoryHandle: handle as unknown as PersistedDirectoryHandle, permissionHint: "granted", legacyRelinkRequired: false, lastOpenedAt: now };
    else project = { id: crypto.randomUUID(), name: handle.name, directoryHandle: handle as unknown as PersistedDirectoryHandle, permissionHint: "granted", legacyRelinkRequired: false, permissionMode: "confirmWrites", instructionsEnabled: false, networkAllowlist: [], createdAt: now, lastOpenedAt: now };
    await this.projects.put(project);
    appLog.info("项目目录已注册", { projectId: project.id, projectName: project.name, existing });
    const thread = await this.createThreadRecord(project.id);
    await this.refreshSidebar();
    await this.openThread(thread.id);
  }

  private async createThread(projectId: string): Promise<void> {
    const thread = await this.createThreadRecord(projectId);
    await this.refreshSidebar();
    await this.openThread(thread.id);
  }

  private async createThreadRecord(projectId: string): Promise<ThreadRecord> {
    const now = new Date().toISOString();
    const thread: ThreadRecord = { id: crypto.randomUUID(), projectId, title: "新建项目", modelSelection: this.models.globalSelection, createdAt: now, updatedAt: now };
    await this.conversations.putThread(thread);
    appLog.info("项目对话已创建", { projectId, threadId: thread.id });
    return thread;
  }

  private async openThread(threadId: string): Promise<void> {
    if (this.busy && threadId !== this.activeThread?.id) {
      this.ui.toast("当前运行结束前不能切换对话；你仍可在当前对话中排队消息。");
      return;
    }
    appLog.info("开始恢复对话", { threadId });
    await this.flushTerminalTranscript();
    this.interactiveSession?.kill();
    this.interactiveSession = undefined;
    if (this.activeThread?.projectId !== (await this.conversations.getThread(threadId))?.projectId) this.runtime = undefined;
    this.fileService = undefined;
    this.skills.clearSource("project");
    this.renderSkillManager();
    await this.clearComposerAttachments();
    this.clearHistoryAttachmentPreviews();
    const thread = await this.conversations.getThread(threadId);
    if (!thread) return;
    const project = await this.projects.get(thread.projectId);
    if (!project) return;
    this.activeThread = thread;
    this.activeProject = project;
    this.activeMessages = await this.conversations.messages(thread.id);
    if (thread.modelSelection) {
      try {
        await this.models.selectProfile(thread.modelSelection.providerProfileId, false);
        await this.models.selectModel(thread.modelSelection.modelId, false);
      } catch (error) { appLog.warn("恢复对话模型选择失败，已使用当前默认模型", { threadId, error: errorMessage(error) }); }
    } else {
      await this.models.selectProfile(this.models.globalSelection.providerProfileId, false);
      await this.models.selectModel(this.models.globalSelection.modelId, false);
    }
    this.ui.setComposerModelOptions(this.models.profiles, this.availableModels);
    this.ui.setModelSelection(this.models.currentProfile.id, this.models.current.model);
    sessionStorage.setItem(LAST_THREAD, thread.id);
    this.ui.setActiveThread(thread, project);
    this.ui.renderMessages(this.activeMessages);
    await this.renderHistoricalAttachments();
    this.ui.setBusy(false, "正在恢复项目连接…");
    this.restoreTerminalTranscript();
    await this.refreshSidebar();
    await this.restoreProjectConnection(project);
    await this.refreshModelCatalog(false);
    this.updateContextUsage();
    await this.refreshProjectControls();
    await this.refreshProjectPanels();
    appLog.info("对话恢复完成", { threadId: thread.id, projectId: project.id, messages: this.activeMessages.length });
  }

  private async restoreProjectConnection(project: ProjectRecord): Promise<void> {
    const handle = project.directoryHandle as BrowserDirectoryHandle | undefined;
    if (!handle) {
      appLog.warn("项目缺少可恢复的目录句柄", { projectId: project.id, projectName: project.name });
      this.disconnectUi("待重新关联", "missing", { label: "重新关联文件夹", run: () => void this.relinkProject() });
      return;
    }
    try {
      const permission = await resolveDirectoryPermission(handle, "query");
      appLog.info("项目目录权限检查完成", { projectId: project.id, permission });
      if (permission === "granted") { await this.connectProject(project, handle); return; }
      if (permission === "denied") {
        this.disconnectUi("权限已拒绝", "missing", { label: "重新关联文件夹", run: () => void this.relinkProject() });
        return;
      }
      this.disconnectUi("需要恢复权限", "permission", { label: "恢复文件夹访问", run: () => void this.requestProjectPermission() });
    } catch (error) {
      appLog.error("恢复项目目录句柄失败", { projectId: project.id }, error);
      this.disconnectUi("目录句柄已失效", "missing", { label: "重新关联文件夹", run: () => void this.relinkProject() });
    }
  }

  private async requestProjectPermission(): Promise<void> {
    const project = this.activeProject;
    const handle = project?.directoryHandle as BrowserDirectoryHandle | undefined;
    if (!project || !handle) return;
    try {
      const permission = await resolveDirectoryPermission(handle, "request");
      appLog.info("用户完成目录权限请求", { projectId: project.id, permission });
      if (permission === "granted") await this.connectProject(project, handle);
      else this.disconnectUi("权限已拒绝", "missing", { label: "重新关联文件夹", run: () => void this.relinkProject() });
    } catch (error) { appLog.error("目录权限请求失败", { projectId: project.id }, error); this.ui.toast(errorMessage(error)); }
  }

  private async relinkProject(): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    const handle = await this.pickDirectory("readwrite");
    if (!handle) return;
    const previous = project.directoryHandle as BrowserDirectoryHandle | undefined;
    if (previous && !project.legacyRelinkRequired && previous.isSameEntry) {
      try { if (!await previous.isSameEntry(handle)) { this.ui.toast("所选文件夹不是该项目原来的目录；请重新选择。 "); return; } }
      catch { /* A stale handle may be explicitly replaced. */ }
    }
    const updated: ProjectRecord = { ...project, name: handle.name, directoryHandle: handle as unknown as PersistedDirectoryHandle, permissionHint: "granted", legacyRelinkRequired: false, lastOpenedAt: new Date().toISOString() };
    await this.projects.put(updated);
    this.activeProject = updated;
    await this.connectProject(updated, handle);
    await this.refreshSidebar();
  }

  private async connectProject(project: ProjectRecord, handle: BrowserDirectoryHandle): Promise<void> {
    const service = new ProjectFileService(project.id, handle, new OpfsChangeJournal());
    const createdState = await service.ensureDirectory(BROWSER_AGENT_STATE_DIRECTORY);
    const createdPackages = await service.ensureDirectory(BROWSER_AGENT_PACKAGE_DIRECTORY);
    const interruptedChangeSets = await service.interruptActiveChangeSets();
    const entries = await service.captureBaseline();
    const projectFileCount = entries.filter((entry) => entry.kind === "file" && !isBrowserAgentInternalPath(entry.path)).length;
    appLog.info("真实项目文件服务已连接", { projectId: project.id, projectName: project.name, files: projectFileCount, interruptedChangeSets, browserAgentDirectoriesCreated: createdState || createdPackages });
    this.fileService = service;
    this.interactiveSession?.kill();
    this.interactiveSession = undefined;
    this.runtime = new VirtualRuntimeProvider(new ProjectVirtualFileSystem(service));
    await this.loadProjectSkills(service);
    this.configureAppLogging();
    const updated: ProjectRecord = { ...project, permissionHint: "granted", legacyRelinkRequired: false, lastOpenedAt: new Date().toISOString() };
    await this.projects.put(updated);
    this.activeProject = updated;
    this.ui.setConnection("connected", `已连接 · ${projectFileCount} 个文件`);
    this.ui.terminalStart.disabled = false;
    this.ui.runtimeStatus.textContent = "可启动 · 无需容器密钥";
    this.ui.setBusy(false, this.models.hasConfiguration() ? "模型和项目已就绪" : "请在设置中配置模型 API");
    await this.refreshProjectControls();
    await this.refreshProjectPanels();
  }

  private disconnectUi(label: string, status: "permission" | "missing", action: { label: string; run(): void }): void {
    this.fileService = undefined;
    this.skills.clearSource("project");
    this.renderSkillManager();
    this.configureAppLogging();
    this.ui.setConnection(status, label, action);
    this.ui.terminalStart.disabled = true;
    this.ui.setBusy(false, this.models.hasConfiguration() ? "项目未连接，工作模式暂不可用" : "请先配置模型 API");
  }

  private async ensureRuntime(interactive: boolean): Promise<void> {
    if (!this.fileService) {
      const message = "项目文件夹尚未连接。";
      this.ui.toast(message);
      appLog.warn("Runtime 启动被拒绝：项目未连接", { interactive });
      throw new Error(message);
    }
    if (interactive) this.setTerminalCollapsed(false);
    if (!this.runtime || !await this.runtime.available()) throw new Error("当前浏览器缺少 WebAssembly 或 Web Worker，无法启动虚拟 Runtime。");
    if (this.runtimeStartPromise) {
      appLog.debug("等待正在进行的 Runtime 启动", { interactive });
      await this.runtimeStartPromise;
      return;
    }
    this.ui.terminalStart.disabled = true;
    this.runtimeStartPromise = this.startRuntime(interactive).finally(() => {
      this.runtimeStartPromise = undefined;
      if (!this.interactiveSession) this.ui.terminalStart.disabled = !this.fileService;
    });
    await this.runtimeStartPromise;
  }

  private async startRuntime(interactive: boolean): Promise<void> {
    const projectId = this.fileService?.projectId;
    try {
      appLog.info("请求启动 Runtime", { projectId, interactive, engine: "QuickJS/WASM" });
      this.ui.runtimeStatus.textContent = "正在启动…";
      const runtime = this.requireRuntime();
      if (interactive && !this.interactiveSession) {
        this.terminal.reset();
        this.terminalBuffer = "";
        this.terminal.writeln(`\x1b[90m${t("正在建立新的虚拟 Bash 会话…", "Starting a new virtual Bash session…")}\x1b[0m`);
        this.interactiveSession = await runtime.startInteractive((data) => this.onTerminalOutput(data), this.dimensions());
        this.ui.terminalStart.textContent = "Runtime 已启动";
        this.ui.terminalStart.disabled = true;
        this.terminal.focus();
      }
      this.ui.runtimeStatus.textContent = "Virtual Runtime 已连接";
      appLog.info("Runtime 启动完成", { projectId, interactive, shellStarted: Boolean(this.interactiveSession) });
    } catch (error) {
      this.ui.runtimeStatus.textContent = "启动失败";
      appLog.error("Runtime 启动失败", { projectId, interactive }, error);
      this.ui.toast(errorMessage(error));
      this.terminal.writeln(`\r\n\x1b[31m[Runtime] ${errorMessage(error)}\x1b[0m`);
      throw error;
    }
  }

  private async send(options: { intent?: string; retryOf?: RunRecord; resumeRun?: RunRecord; skipUserMessage?: boolean; queuedMessage?: MessageRecord; resumeCheckpoint?: unknown } = {}): Promise<void> {
    const typedIntent = options.queuedMessage?.content.trim() ?? options.intent?.trim() ?? this.ui.intent.value.trim();
    const intent = typedIntent || (this.composerAttachments.length ? "请分析这些图片。" : "");
    if (!intent || !this.activeThread) return;
    if (this.busy) {
      await this.enqueueComposerMessage(intent);
      return;
    }
    if (!this.models.hasConfiguration()) {
      this.ui.modelHelp.textContent = this.models.current.mode === "gateway"
        ? "请检查 Gateway 配置。"
        : "发送任务前需要填写 API Key。";
      if (!this.ui.settingsDialog.open) this.ui.settingsDialog.showModal();
      this.ui.apiKey.focus();
      this.ui.toast("请先完成模型 API 配置；当前输入已保留。 ");
      return;
    }
    const fileService = this.fileService;
    if (!fileService) {
      this.ui.toast("项目尚未连接，已阻止无工具模型回合。请重新选择项目文件夹。 ");
      return;
    }
    const historicalAttachments = await this.attachments.listForThread(this.activeThread.id);
    const activeMessageIds = new Set(this.activeMessages
      .filter((message) => !this.activeThread?.contextSummary || message.sequence > this.activeThread.contextSummary.throughSequence)
      .map((message) => message.id));
    const needsImages = this.composerAttachments.length > 0 || historicalAttachments.some((attachment) => attachment.messageId && activeMessageIds.has(attachment.messageId));
    if (!await this.ensureSelectedModelCapabilities(needsImages)) return;
    const previousMessages = this.activeMessages.filter((message) => message.id !== options.queuedMessage?.id && !["pending", "running", "delivered", "withdrawn"].includes(String(message.metadata?.queueStatus ?? "")));
    const attachmentsForRun = options.queuedMessage
      ? await this.attachments.listForMessage(options.queuedMessage.id)
      : options.skipUserMessage ? [] : this.composerAttachments;
    const attachmentParts = await Promise.all(attachmentsForRun.map(async (attachment): Promise<ModelContentPart> => ({
      type: "image",
      mimeType: attachment.mimeType,
      data: await blobToBase64(attachment.blob),
      attachmentId: attachment.id
    })));
    appLog.info("开始 Agent 回合", { threadId: this.activeThread.id, projectId: this.activeProject?.id, inputCharacters: intent.length, attachments: attachmentParts.length, connected: Boolean(this.fileService) });
    this.ui.intent.value = "";
    this.ui.resizeComposer();
    const userMessage = options.queuedMessage ?? (options.skipUserMessage ? undefined : await this.appendMessage("user", "user", intent, attachmentParts.length ? {
      attachments: attachmentsForRun.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
    } : undefined));
    if (options.queuedMessage) {
      const index = this.activeMessages.findIndex((message) => message.id === options.queuedMessage?.id);
      const runningMessage = await this.conversations.transitionQueuedMessage(options.queuedMessage.id, "delivered");
      if (index >= 0) this.activeMessages[index] = runningMessage;
      this.ui.renderMessages(this.activeMessages);
      await this.renderHistoricalAttachments();
    } else if (userMessage) {
      await Promise.all(attachmentsForRun.map((attachment) => this.attachments.attachToMessage(attachment.id, userMessage.id)));
      const items = attachmentsForRun.map((attachment) => {
        const previewUrl = URL.createObjectURL(attachment.blob);
        this.historyAttachmentPreviewUrls.set(attachment.id, previewUrl);
        return { id: attachment.id, name: attachment.name, size: attachment.size, mimeType: attachment.mimeType, previewUrl };
      });
      this.ui.renderMessageAttachments(userMessage.id, items);
    }
    if (!options.skipUserMessage && !options.queuedMessage) await this.clearComposerAttachments(false);
    if (!options.skipUserMessage && (this.activeThread.title === "新建任务" || this.activeThread.title === "新建项目")) {
      this.activeThread = { ...this.activeThread, title: intent.slice(0, 42), updatedAt: new Date().toISOString() };
      await this.conversations.putThread(this.activeThread);
      this.ui.setActiveThread(this.activeThread, this.activeProject);
      await this.refreshSidebar();
    }
    this.busy = true;
    const controller = new AbortController();
    this.activeRunController = controller;
    this.allowWritesForCurrentRun = false;
    this.ui.setBusy(true, "Agent 正在工作…");
    const run: RunRecord = options.resumeRun ?? {
      id: crypto.randomUUID(),
      threadId: this.activeThread.id,
      status: "running",
      intent,
      providerMode: this.models.current.mode,
      model: this.models.current.model,
      endpointOrigin: safeOrigin(this.models.current.endpoint),
      ...(userMessage ? { inputMessageId: userMessage.id } : options.retryOf?.inputMessageId ? { inputMessageId: options.retryOf.inputMessageId } : {}),
      ...(options.retryOf ? { retryOf: options.retryOf.id } : {}),
      changeSetId: "pending",
      events: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    run.changeSetId = run.id;
    this.activeRunId = run.id;
    await this.conversations.putRun(run);
    try {
      const [provider, agentKernel] = await Promise.all([
        this.models.createProvider(),
        import("../../../packages/agent-kernel/src/index")
      ]);
      const previousConversation = await this.prepareConversation(provider, previousMessages, false, controller.signal);
      await fileService.refresh();
      await fileService.ensureDirectory(browserAgentRunScratchDirectory(run.id));
      const runtime = this.lazyRuntime();
      const onWorkspaceWrite = async (_path: string): Promise<void> => undefined;
      const tools = agentKernel.createCoreToolRegistry({
        workspace: fileService,
        runtime,
        skills: this.skills,
        conversation: () => this.conversationTurns(),
        scratchDirectory: browserAgentRunScratchDirectory(run.id),
        onWorkspaceWrite,
        permissionMode: this.activeProject?.permissionMode ?? "auto",
        authorize: (request) => this.authorizeTool(request.tool.id, request.argumentsValue),
        authorizeNetwork: (url) => this.authorizeNetwork(url)
      });
      registerOfficeAgentTools(tools, { workspace: fileService, onWorkspaceWrite });
      const mcpConnections = await registerConfiguredMcpTools(tools, this.mcpServers, (url) => this.authorizeNetwork(url), controller.signal);
      const projectInstructions = await loadProjectInstructions(fileService, this.activeProject?.instructionsEnabled === true);
      const environment = {
        runtime: {
          id: runtime.id,
          available: await runtime.available(),
          shell: "浏览器虚拟 Bash（持久化 VFS + QuickJS/WASM，不是宿主系统 Shell）",
          workingDirectory: ".",
          runtimeCommandsUseRelativePaths: true as const,
          limitations: runtime.limitations?.() ?? ["Runtime 能力信息不可用"]
        },
        skills: this.skills.list(),
        mcpServers: mcpConnections.map((connection) => ({ name: connection.server.name, toolCount: connection.tools.length })),
        scratchDirectory: browserAgentRunScratchDirectory(run.id),
        ...(projectInstructions ? { projectInstructions } : {})
      };
      const session = new AgentSession(run, {
        conversations: this.conversations,
        changeSets: fileService,
        driver: {
          run: async (request) => {
            const result = await new agentKernel.AgentLoop(provider).run({
              intent: request.intent,
              workspaceId: this.activeProject?.id ?? "project",
              runId: request.runId,
              tools,
              conversation: previousConversation,
              ...(request.attachments?.length ? { attachments: request.attachments } : {}),
              allowImageToolResults: this.selectedModel()?.capabilities.imageInput === "supported",
              ...(request.resumeCheckpoint ? { resumeCheckpoint: request.resumeCheckpoint } : {}),
              onCheckpoint: request.onCheckpoint,
              hooks: {
                prepareNextTurn: async () => this.steeringMessages(await request.takeSteering()),
                transformContext: async (messages) => {
                  const delivered = request.resumeCheckpoint?.steering.filter((item) => item.status === "delivered") ?? [];
                  const existing = new Set(delivered.filter((item) => messages.some((message) => modelMessageContainsSteering(message, item.id))).map((item) => item.id));
                  return [...messages, ...await this.steeringMessages(delivered.filter((item) => !existing.has(item.id)))];
                }
              },
              signal: request.signal,
              environment
            }, request.onEvent);
            return { status: result.status, reply: result.reply, checkpoint: result.checkpoint, metrics: result.metrics, ...(result.errorKind ? { errorKind: result.errorKind } : {}), ...(result.task.failure ? { error: result.task.failure } : {}) };
          }
        },
        compactCheckpoint: (checkpoint) => this.compactAgentCheckpoint(checkpoint),
        takeSteering: (runId) => this.takeSteering(runId),
        consumeSteering: (runId, steeringIds) => this.consumeDeliveredSteering(runId, steeringIds),
        onEvent: (event) => this.recordAgentEvent(run, event)
      });
      this.activeAgentSession = session;
      const result = options.resumeRun
        ? await session.resume({ run, ...(agentKernel.isAgentCheckpoint(options.resumeCheckpoint) ? { checkpoint: options.resumeCheckpoint } : {}) })
        : await session.prompt({ intent, ...(attachmentParts.length ? { attachments: attachmentParts } : {}) });
      const completedRun = session.run;
      this.ui.completeToolRun(run.id, completedRun.status === "running" ? "failed" : completedRun.status);
      if (result.status === "completed" && result.reply) await this.appendMessage("assistant", "assistant", await this.withOutputFileLinks(result.reply, "本次输出文件：", completedRun.outputPaths ?? []));
      else if (result.error) await this.appendMessage("system", "error", result.error);
      appLog.info("Agent 回合结束", { threadId: this.activeThread.id, runId: run.id, status: completedRun.status, events: completedRun.events.length });
    } catch (error) {
      if (!this.activeAgentSession) {
        run.status = controller.signal.aborted ? "cancelled" : "failed";
        run.settledAt = new Date().toISOString();
        run.updatedAt = run.settledAt;
        await this.conversations.putRun(run);
      }
      appLog.error("Agent 回合失败", { threadId: this.activeThread.id, runId: run.id, events: this.activeAgentSession?.run.events.length ?? run.events.length }, error);
      this.ui.discardAssistantStream();
      this.ui.completeToolRun(run.id, "failed");
      await this.appendMessage("system", "error", controller.signal.aborted ? "运行已由用户停止。" : errorMessage(error));
    } finally {
      if (options.queuedMessage) {
        const index = this.activeMessages.findIndex((message) => message.id === options.queuedMessage?.id);
        if (index >= 0) {
          const consumed = await this.conversations.transitionQueuedMessage(options.queuedMessage.id, "consumed", run.id);
          this.activeMessages[index] = consumed;
        }
      }
      const completedRun = this.activeAgentSession?.run;
      this.activeAgentSession = undefined;
      this.activeRunId = undefined;
      this.activeRunController = undefined;
      this.busy = false;
      this.ui.setBusy(false, this.fileService ? "模型和项目已就绪" : "项目未连接，文件工具不可用");
      this.updateContextUsage();
      await this.refreshProjectPanels();
      queueMicrotask(() => { void this.runNextQueuedMessage(completedRun); });
    }
  }

  private async ensureSelectedModelCapabilities(needsImages: boolean): Promise<boolean> {
    let descriptor = this.availableModels.find((model) => model.id === this.models.current.model);
    if (!descriptor) {
      await this.refreshModelCatalog(false);
      descriptor = this.availableModels.find((model) => model.id === this.models.current.model);
    }
    if (!descriptor) { this.ui.toast("无法取得当前模型的能力信息，请刷新模型列表。 "); return false; }
    const overrides = { ...(this.models.currentProfile.capabilityOverrides?.[descriptor.id] ?? {}) };
    const probe = await this.modelProbes.latest(this.models.currentProfile.id, descriptor.id);
    if (probe?.endpointOrigin === safeOrigin(this.models.current.endpoint)) {
      if (probe.toolCalling) overrides.toolCalling = "supported";
      if (probe.imageInput) overrides.imageInput = "supported";
    }
    if (!canRunAgent(descriptor)) {
      if (descriptor.capabilities.toolCalling === "unsupported") { this.ui.toast("当前模型明确不支持工具调用，不能运行项目 Agent。 "); return false; }
      if (overrides.toolCalling !== "supported") {
        this.ui.modelProbeStatus.textContent = `模型 ${descriptor.name} 尚未通过工具调用测试。`;
        if (!this.ui.settingsDialog.open) this.ui.settingsDialog.showModal();
        this.ui.quickTestModel.focus();
        this.ui.toast("请先运行 Quick Test，验证工具调用能力。");
        return false;
      }
    }
    if (needsImages && !canSendImages(descriptor)) {
      if (descriptor.capabilities.imageInput === "unsupported") { this.ui.toast("当前模型不支持图片输入，请切换模型后重试。 "); return false; }
      if (overrides.imageInput !== "supported") {
        this.ui.modelProbeStatus.textContent = `模型 ${descriptor.name} 尚未通过图片输入测试。`;
        if (!this.ui.settingsDialog.open) this.ui.settingsDialog.showModal();
        this.ui.quickTestModel.focus();
        this.ui.toast("请先运行 Quick Test，验证图片输入能力。");
        return false;
      }
    }
    if (Object.keys(overrides).length) {
      const profile = {
        ...this.models.currentProfile,
        capabilityOverrides: { ...(this.models.currentProfile.capabilityOverrides ?? {}), [descriptor.id]: overrides },
        updatedAt: new Date().toISOString()
      };
      this.models.currentProfile = profile;
      await this.settings.putProviderProfile(profile);
      await this.refreshModelCatalog(false);
    }
    return true;
  }

  private async quickTestModel(): Promise<void> {
    if (!this.models.hasConfiguration()) {
      this.ui.modelProbeStatus.textContent = "请先保存有效的模型配置和 API Key。";
      return;
    }
    this.ui.quickTestModel.disabled = true;
    this.ui.modelProbeStatus.textContent = "正在测试文本、流式、工具调用和图片输入…";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const provider = await this.models.createProvider();
      const descriptor = this.selectedModel();
      const imageUnsupported = descriptor?.capabilities.imageInput === "unsupported";
      const result = await probeModel(provider, controller.signal, { imageInput: !imageUnsupported });
      const record = {
        id: crypto.randomUUID(),
        providerProfileId: this.models.currentProfile.id,
        modelId: this.models.current.model,
        endpointOrigin: safeOrigin(this.models.current.endpoint),
        text: result.text,
        toolCalling: result.toolCalling,
        imageInput: result.imageInput,
        streaming: result.streaming,
        testedAt: new Date().toISOString(),
        details: result.details
      };
      await this.modelProbes.put(record);
      const existing = this.models.currentProfile.capabilityOverrides?.[record.modelId] ?? {};
      const overrides = {
        ...existing,
        ...(result.toolCalling ? { toolCalling: "supported" as const } : {}),
        ...(result.imageInput ? { imageInput: "supported" as const } : {})
      };
      this.models.currentProfile = {
        ...this.models.currentProfile,
        capabilityOverrides: { ...(this.models.currentProfile.capabilityOverrides ?? {}), [record.modelId]: overrides },
        updatedAt: record.testedAt
      };
      await this.settings.putProviderProfile(this.models.currentProfile);
      await this.refreshModelCatalog(false);
      const label = (value: boolean): string => value ? "通过" : "失败";
      this.ui.modelProbeStatus.textContent = `文本 ${label(result.text)} · 流式 ${label(result.streaming)} · 工具 ${label(result.toolCalling)} · 图片 ${imageUnsupported ? "不支持" : label(result.imageInput)}`;
      if (!result.toolCalling) this.ui.toast("Quick Test 未通过工具调用测试；已保留原有能力设置，未自动降级。");
    } catch (error) {
      this.ui.modelProbeStatus.textContent = controller.signal.aborted ? "Quick Test 超时。" : `Quick Test 失败：${errorMessage(error)}`;
    } finally {
      clearTimeout(timeout);
      this.ui.quickTestModel.disabled = false;
    }
  }

  private async prepareConversation(provider: ModelProvider, source: MessageRecord[], force: boolean, signal?: AbortSignal): Promise<ConversationTurn[]> {
    if (!this.activeThread) return [];
    const summary = this.activeThread.contextSummary;
    const eligible = source.filter((message): message is MessageRecord & { role: "user" | "assistant" } =>
      (message.role === "user" || message.role === "assistant") && (!summary || message.sequence > summary.throughSequence));
    const contextWindow = this.selectedModel()?.capabilities.contextWindow;
    const selection = selectContextMessages(eligible, {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(summary?.content ? { existingSummary: summary.content } : {})
    });
    let toSummarize = selection.messagesToSummarize;
    let retained = selection.retainedMessages;
    if (force && !toSummarize.length && eligible.length > 8) {
      toSummarize = eligible.slice(0, -8);
      retained = eligible.slice(-8);
    }
    let currentSummary = summary;
    if (toSummarize.length) {
      try {
        const chunks = chunkContextMessagesForSummary(toSummarize, (message) => `${message.role === "user" ? t("用户", "User") : t("助手", "Assistant")}: ${message.content}`);
        let completedMessages = 0;
        let rollingContent = summary?.content ?? "";
        for (const chunk of chunks) {
          const response = await provider.runTurn({
            messages: [
              { role: "system", content: appLocale === "zh-CN" ? "你是上下文压缩器。禁止调用工具，只输出简洁、准确的中文滚动摘要；保留目标、约束、用户决策、项目事实、已完成事项和待办，不得补充原文没有的内容。" : "You are a context compressor. Do not call tools. Return only a concise, accurate rolling summary in English. Preserve goals, constraints, user decisions, project facts, completed work, and remaining tasks. Never invent information." },
              { role: "user", content: appLocale === "zh-CN" ? `已有摘要：\n${rollingContent || "（无）"}\n\n新增历史：\n${chunk.content}` : `Existing summary:\n${rollingContent || "(none)"}\n\nNew history:\n${chunk.content}` }
            ],
            tools: [],
            toolChoice: "none"
          }, undefined, signal);
          rollingContent = response.text.trim();
          if (!rollingContent) throw new Error("上下文摘要模型返回了空内容。 ");
          completedMessages += chunk.completedMessages;
          if (!completedMessages) continue;
          const last = toSummarize[completedMessages - 1]!;
          currentSummary = {
            content: rollingContent,
            throughSequence: last.sequence,
            sourceMessageCount: (summary?.sourceMessageCount ?? 0) + completedMessages,
            model: this.models.current.model,
            updatedAt: new Date().toISOString()
          };
          this.activeThread = { ...this.activeThread, contextSummary: currentSummary, updatedAt: currentSummary.updatedAt };
          await this.conversations.putThread(this.activeThread);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        appLog.warn("上下文摘要失败，回退到预算内最近消息", { messages: toSummarize.length, error: errorMessage(error) });
      }
    }
    const turns: ConversationTurn[] = [];
    if (currentSummary?.content) turns.push({ role: "user", content: appLocale === "zh-CN" ? `以下是更早对话的滚动摘要（仅作为上下文）：\n${currentSummary.content}` : `Rolling summary of the earlier conversation (context only):\n${currentSummary.content}` });
    const canIncludeImages = this.selectedModel()?.capabilities.imageInput === "supported";
    const attachmentMap = new Map<string, AttachmentRecord[]>();
    if (canIncludeImages) {
      for (const attachment of await this.attachments.listForThread(this.activeThread.id)) {
        if (!attachment.messageId) continue;
        const list = attachmentMap.get(attachment.messageId) ?? [];
        list.push(attachment);
        attachmentMap.set(attachment.messageId, list);
      }
    }
    for (const message of retained) {
      const messageAttachments = message.role === "user" ? attachmentMap.get(message.id) ?? [] : [];
      if (!messageAttachments.length) { turns.push({ role: message.role, content: message.content }); continue; }
      const parts: ModelContentPart[] = [{ type: "text", text: message.content }];
      for (const attachment of messageAttachments) parts.push({ type: "image", mimeType: attachment.mimeType, data: await blobToBase64(attachment.blob), attachmentId: attachment.id });
      turns.push({ role: message.role, content: parts });
    }
    return turns;
  }

  private async recordAgentEvent(run: RunRecord, event: AgentEvent): Promise<void> {
    if (event.kind === "agent_start") { this.ui.setBusy(true, "Agent 正在工作…"); return; }
    if (event.kind === "turn_start") { this.ui.setBusy(true, t(`Agent 正在执行第 ${event.turn} 轮…`)); return; }
    if (event.kind === "message_start") return;
    if (event.kind === "message_update") {
      if (event.updateKind === "text_delta") this.ui.appendAssistantDelta(event.content);
      else if (event.updateKind === "phase" || event.updateKind === "compaction_progress") this.ui.setBusy(true, event.content);
      return;
    }
    if (event.kind === "message_end") return;
    if (event.kind === "tool_execution_update") { this.ui.setBusy(true, `${event.toolName}：${event.content}`); return; }
    if (event.kind === "turn_end") { this.ui.setBusy(true, event.action === "pause" ? "Agent 正在暂停…" : "Agent 正在准备下一轮…"); return; }
    if (event.kind === "agent_end") {
      this.ui.discardAssistantStream();
      return;
    }
    if (event.kind === "agent_settled") return;
    const callId = event.callId;
    const isStart = event.kind === "tool_execution_start";
    let networkHost: string | undefined;
    if (isStart && event.toolName === "network.fetch") {
      const url = event.arguments.url;
      if (typeof url === "string") try { networkHost = new URL(url).hostname; } catch { /* 无效 URL 会由工具本身报告。 */ }
    }
    if (!isStart && event.toolName === "network.fetch") {
      try {
        const finalUrl = (JSON.parse(event.content) as { finalUrl?: unknown }).finalUrl;
        if (typeof finalUrl === "string") networkHost = new URL(finalUrl).hostname;
      } catch { /* 工具失败或截断结果不会影响运行记录。 */ }
    }
    const isError = !isStart && event.isError;
    if (isError) appLog.error("Agent 工具事件失败", { runId: run.id, toolName: event.toolName, eventKind: event.kind, errorOrigin: event.errorOrigin, errorFingerprint: event.errorFingerprint });
    else appLog.info("Agent 工具事件", { runId: run.id, toolName: event.toolName, eventKind: event.kind });
    const metadata: Record<string, unknown> = {
      runId: run.id,
      callId,
      eventKind: isStart ? "tool-start" : isError ? "error" : "tool-result",
      toolName: event.toolName,
      ...(isStart ? { arguments: event.arguments } : { isError, errorOrigin: event.errorOrigin, errorFingerprint: event.errorFingerprint, terminate: event.terminate }),
      ...(networkHost ? { networkHost } : {})
    };
    await this.appendMessage("system", "tool", isStart ? `${event.toolName} ${JSON.stringify(event.arguments)}` : event.content, metadata);
  }

  private lazyRuntime(): ScriptRuntimeProvider {
    return {
      id: "browser-agent-virtual",
      available: async () => this.runtime?.available() ?? false,
      start: async (): Promise<RuntimeSession> => { await this.ensureRuntime(false); return this.requireRuntime().start(); },
      execute: (session: RuntimeSession, request: ScriptExecutionRequest): Promise<ScriptExecutionResult> => this.requireRuntime().execute(session, request),
      startInteractive: (onOutput: (data: string) => void, dimensions: TerminalDimensions) => this.requireRuntime().startInteractive(onOutput, dimensions),
      terminate: (session: RuntimeSession) => this.requireRuntime().terminate(session),
      limitations: () => this.runtime?.limitations() ?? ["Runtime 尚未连接项目"]
    };
  }

  private requireRuntime(): VirtualRuntimeProvider {
    if (!this.runtime) throw new Error("Runtime 尚未连接项目");
    return this.runtime;
  }

  private async withOutputFileLinks(content: string, heading: string, outputPaths: readonly string[]): Promise<string> {
    const service = this.fileService;
    if (!service || !outputPaths.length) return content;
    const files: string[] = [];
    for (const path of outputPaths) {
      try { await service.getFile(path); files.push(path); } catch { /* 目录或本回合已删除的路径不进入最终链接。 */ }
    }
    return appendWorkspaceFileLinks(content, files, heading);
  }

  private async openWorkspaceFile(path: string): Promise<void> {
    const preview = window.open("about:blank", "_blank");
    if (preview) {
      preview.opener = null;
      preview.document.title = "正在打开项目文件…";
      preview.document.body.textContent = "正在读取项目文件…";
    }
    const service = this.fileService;
    if (!service) { preview?.close(); this.ui.toast("项目文件夹尚未连接。"); return; }
    try {
      const file = await service.getFile(path);
      const objectUrl = URL.createObjectURL(file.type ? file : new Blob([file], { type: mimeTypeForPath(path) }));
      if (preview) preview.location.replace(objectUrl);
      else {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = file.name;
        anchor.click();
        this.ui.toast("浏览器阻止了新窗口，文件已改为下载。");
      }
      setTimeout(() => URL.revokeObjectURL(objectUrl), 300_000);
    } catch (error) {
      preview?.close();
      appLog.error("打开项目文件失败", { path }, error);
      this.ui.toast(`无法打开项目文件：${errorMessage(error)}`);
    }
  }

  private async loadSkills(): Promise<void> {
    const builtin = import.meta.glob("../../../skills/builtin/*/SKILL.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    for (const [path, markdown] of Object.entries(builtin)) {
      const id = path.split("/").at(-2);
      if (id) this.skills.register(skillFromMarkdown(id, markdown, "builtin"));
    }
    await this.skills.loadPersisted();
    if (this.fileService) await this.loadProjectSkills(this.fileService);
    this.renderSkillManager();
  }

  private async loadProjectSkills(service = this.fileService): Promise<void> {
    this.skills.clearSource("project");
    const project = this.activeProject;
    if (!service || !project) {
      this.ui.projectSkillHelp.textContent = "连接项目后，将自动读取 .browser-agent/skills。";
      this.renderSkillManager();
      return;
    }
    let entries: Awaited<ReturnType<ProjectFileService["list"]>> = [];
    try {
      if (await service.exists("/.browser-agent/skills")) entries = await service.list("/.browser-agent/skills");
    } catch (error) {
      appLog.warn("读取项目 Skills 目录失败", { projectId: project.id }, error);
    }
    const manifests = entries.filter((entry) => entry.kind === "file" && /\/SKILL\.md$/i.test(entry.path)).slice(0, 100);
    let loaded = 0;
    for (const manifest of manifests) {
      const directory = manifest.path.slice(0, -"/SKILL.md".length);
      const folderName = directory.split("/").at(-1) ?? "";
      const id = folderName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
      if (!id) continue;
      try {
        const markdown = (await service.readText(manifest.path)).content;
        const files: SkillFile[] = [];
        const resourceEntries = entries
          .filter((candidate) => candidate.kind === "file" && candidate.path.startsWith(`${directory}/`) && candidate.path !== manifest.path)
          .slice(0, 100);
        for (const entry of resourceEntries) {
          if ((entry.size ?? 0) > 1_000_000) continue;
          try { files.push({ path: entry.path.slice(directory.length + 1), content: (await service.readText(entry.path)).content }); }
          catch { /* 二进制或读取失败的项目 Skill 资源不注入模型上下文。 */ }
        }
        const enabled = readProjectSkillEnabled(project.id, id);
        this.skills.register({ ...skillFromMarkdown(id, markdown, "project", files), scopeId: project.id, enabled });
        loaded += 1;
      } catch (error) {
        appLog.warn("项目 Skill 加载失败", { projectId: project.id, path: manifest.path }, error);
      }
    }
    this.ui.projectSkillHelp.textContent = loaded
      ? `已从当前项目加载 ${loaded} 个 Skill。`
      : "当前项目未发现 .browser-agent/skills/<name>/SKILL.md。";
    this.renderSkillManager();
  }

  private async installSkillFolder(): Promise<void> {
    const handle = await this.pickDirectory("read");
    if (!handle) return;
    try {
      const markdown = await (await (await handle.getFileHandle("SKILL.md")).getFile()).text();
      const files = await collectSkillFiles(handle);
      const id = handle.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
      const skill = skillFromMarkdown(id || `skill-${Date.now()}`, markdown, "user", files);
      const sensitivePermissions = skill.permissions?.filter((permission) => permission === "network" || permission === "workspace-write" || permission === "runtime-execute") ?? [];
      if (sensitivePermissions.length && !window.confirm(`Skill“${skill.name}”声明了以下敏感权限：\n${sensitivePermissions.join("、")}\n\n是否继续安装？`)) return;
      const existingSummary = this.skills.listAll().find((item) => item.id === skill.id && item.source === "user");
      const existing = existingSummary ? this.skills.inspectInstalled(existingSummary.key ?? existingSummary.id) : undefined;
      if (existing) {
        const diff = skillUpdateDiff(existing, skill).slice(0, 12_000);
        if (!window.confirm(`即将更新 Skill“${skill.name}” ${existing.version ?? "未声明版本"} → ${skill.version ?? "未声明版本"}。\n\n权限：${skill.permissions?.join("、") || "无"}\n\n更新 Diff：\n${diff}\n\n是否继续？`)) return;
      }
      await this.skills.install(skill);
      appLog.info("用户 Skill 已安装", { skillId: id || "generated", files: files.length });
      this.renderSkillManager();
      this.ui.toast(`已安装 Skill：${handle.name}`);
    } catch (error) { appLog.error("用户 Skill 安装失败", undefined, error); this.ui.toast(`Skill 安装失败：${errorMessage(error)}`); }
  }

  private async refreshSidebar(): Promise<void> {
    const [projects, threads] = await Promise.all([this.projects.list(), this.conversations.listThreads()]);
    this.ui.renderSidebar(projects, threads, this.activeThread?.id, {
      openThread: (id) => void this.openThread(id),
      createThread: (projectId) => void this.createThread(projectId),
      deleteThread: (id) => void this.deleteThread(id)
    });
  }

  private async deleteThread(id: string): Promise<void> {
    const thread = await this.conversations.getThread(id);
    if (!thread || !window.confirm(`确定删除对话“${thread.title}”吗？\n\n其中的消息和运行记录将永久删除。`)) return;
    await this.conversations.deleteThread(id);
    if (this.activeThread?.id === id) {
      this.interactiveSession?.kill();
      this.interactiveSession = undefined;
      this.runtime = undefined;
      this.clearHistoryAttachmentPreviews();
      this.activeThread = undefined; this.activeProject = undefined; this.activeMessages = []; this.fileService = undefined;
      this.skills.clearSource("project");
      this.renderSkillManager();
      this.ui.setActiveThread(undefined, undefined); this.ui.renderMessages([]); this.ui.setConnection("disconnected", "未连接");
    }
    await this.refreshSidebar();
  }

  private async appendMessage(role: MessageRecord["role"], kind: MessageKind, content: string, metadata?: Record<string, unknown>): Promise<MessageRecord | undefined> {
    if (!this.activeThread) return undefined;
    const base = { threadId: this.activeThread.id, role, kind, content };
    const record = await this.conversations.appendMessage(metadata ? { ...base, metadata } : base);
    this.activeMessages.push(record);
    if (record.kind === "assistant") this.ui.completeAssistantMessage(record);
    else this.ui.appendMessage(record);
    return record;
  }

  private conversationTurns(): ConversationTurn[] {
    return this.activeMessages
      .filter((message): message is MessageRecord & { role: "user" | "assistant" } =>
        (message.role === "user" || message.role === "assistant")
        && message.metadata?.queueStatus !== "pending"
        && message.metadata?.queueStatus !== "running")
      .map(({ role, content }) => ({ role, content }));
  }

  private onTerminalOutput(data: string): void {
    this.terminal.write(data);
    this.terminalBuffer += stripAnsi(data);
    if (!this.terminalFlushTimer) this.terminalFlushTimer = setTimeout(() => { this.terminalFlushTimer = undefined; void this.flushTerminalTranscript(); }, 900);
  }

  private async flushTerminalTranscript(): Promise<void> {
    if (this.terminalFlushTimer) { clearTimeout(this.terminalFlushTimer); this.terminalFlushTimer = undefined; }
    const content = this.terminalBuffer.trim();
    this.terminalBuffer = "";
    const normalized = content.slice(0, 40_000);
    const previous = this.activeMessages.at(-1);
    if (normalized && this.activeThread && !(previous?.kind === "terminal" && previous.content === normalized)) await this.appendMessage("system", "terminal", normalized);
  }

  private restoreTerminalTranscript(): void {
    this.terminal.reset();
    this.terminal.writeln(`\x1b[90m${t("上次终端进程已结束；以下为保存的终端记录。", "The previous terminal process has ended. Saved terminal output follows.")}\x1b[0m`);
    for (const message of this.activeMessages.filter((item) => item.kind === "terminal").slice(-30)) this.terminal.writeln(message.content.replace(/\n/g, "\r\n"));
    this.terminal.writeln(`\x1b[90m${t("点击“启动 Runtime”建立新的 jsh 会话。", "Choose Start Runtime to create a new jsh session.")}\x1b[0m`);
    this.ui.terminalStart.textContent = "启动 Runtime";
    this.ui.runtimeStatus.textContent = "未启动";
  }

  private async clearTerminalHistory(): Promise<void> {
    this.terminal.clear();
    this.terminalBuffer = "";
    if (!this.activeThread) return;
    await this.conversations.deleteMessagesByKind(this.activeThread.id, "terminal");
    this.activeMessages = this.activeMessages.filter((message) => message.kind !== "terminal");
    this.ui.renderMessages(this.activeMessages);
    this.ui.toast("终端显示和已保存的终端记录已清空。 ");
  }

  private setTerminalCollapsed(collapsed: boolean): void {
    this.terminalCollapsed = collapsed;
    this.ui.setTerminalCollapsed(collapsed);
    if (!collapsed) requestAnimationFrame(() => this.fit.fit());
  }

  private dimensions(): TerminalDimensions { return { cols: Math.max(20, this.terminal.cols), rows: Math.max(5, this.terminal.rows) }; }

  private async interruptStaleRuns(threads: ThreadRecord[]): Promise<void> {
    for (const thread of threads) {
      for (const run of await this.conversations.runs(thread.id)) {
        if (run.status !== "running") continue;
        await this.conversations.putRun({ ...run, status: "interrupted", updatedAt: new Date().toISOString() });
      }
    }
  }

  private async addComposerAttachments(files: File[]): Promise<void> {
    const thread = this.activeThread;
    if (!thread) return;
    const accepted = new Set(["image/jpeg", "image/png", "image/webp"]);
    let total = this.composerAttachments.reduce((sum, item) => sum + item.size, 0);
    for (const file of files) {
      if (!accepted.has(file.type)) { this.ui.toast(`${file.name} 不是支持的 JPEG、PNG 或 WebP 图片。`); continue; }
      if (file.size > 8 * 1024 * 1024) { this.ui.toast(`${file.name} 超过单图 8 MiB 限制。`); continue; }
      if (total + file.size > 16 * 1024 * 1024) { this.ui.toast("单条消息的图片合计不能超过 16 MiB。 "); break; }
      const record: AttachmentRecord = {
        id: crypto.randomUUID(),
        threadId: thread.id,
        name: file.name,
        mimeType: file.type as AttachmentRecord["mimeType"],
        size: file.size,
        blob: file,
        createdAt: new Date().toISOString()
      };
      await this.attachments.put(record);
      this.composerAttachments.push(record);
      this.attachmentPreviewUrls.set(record.id, URL.createObjectURL(file));
      total += file.size;
    }
    this.renderComposerAttachments();
  }

  private async enqueueComposerMessage(intent: string): Promise<void> {
    const thread = this.activeThread;
    if (!thread) return;
    const queuedAttachments = [...this.composerAttachments];
    const queueKind: QueuedMessageKind = this.ui.composerSendMode.value === "follow-up" ? "follow-up" : "steering";
    const message = await this.appendMessage("user", "user", intent, {
      queueKind,
      queueStatus: "pending",
      queuedAt: new Date().toISOString(),
      ...(this.activeRunId ? { runId: this.activeRunId } : {}),
      ...(queuedAttachments.length ? {
        attachments: queuedAttachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
      } : {})
    });
    if (!message) return;
    await Promise.all(queuedAttachments.map((attachment) => this.attachments.attachToMessage(attachment.id, message.id)));
    const items = queuedAttachments.map((attachment) => {
      const previewUrl = URL.createObjectURL(attachment.blob);
      this.historyAttachmentPreviewUrls.set(attachment.id, previewUrl);
      return { id: attachment.id, name: attachment.name, size: attachment.size, mimeType: attachment.mimeType, previewUrl };
    });
    this.ui.renderMessageAttachments(message.id, items);
    this.ui.intent.value = "";
    this.ui.resizeComposer();
    await this.clearComposerAttachments(false);
    this.ui.toast(queueKind === "steering" ? "消息将在当前完整工具批次后引导本次任务。" : "消息将在当前任务成功完成后执行。 ");
  }

  private async withdrawQueuedMessage(messageId: string): Promise<void> {
    const message = this.activeMessages.find((item) => item.id === messageId);
    if (!message || message.metadata?.queueStatus !== "pending") {
      this.ui.toast("该消息已开始执行，不能再撤回。");
      return;
    }
    for (const attachment of await this.attachments.listForMessage(message.id)) {
      await this.attachments.delete(attachment.id);
      const preview = this.historyAttachmentPreviewUrls.get(attachment.id);
      if (preview) URL.revokeObjectURL(preview);
      this.historyAttachmentPreviewUrls.delete(attachment.id);
    }
    const withdrawn = await this.conversations.transitionQueuedMessage(message.id, "withdrawn");
    this.activeMessages = this.activeMessages.map((item) => item.id === message.id ? withdrawn : item);
    this.ui.renderMessages(this.activeMessages);
    await this.renderHistoricalAttachments();
    this.ui.toast("已撤回排队消息。");
  }

  private async runNextQueuedMessage(previousRun?: RunRecord, runtimeDeterministicFailure = false): Promise<void> {
    if (this.busy || !this.activeThread || !this.fileService || !previousRun || !shouldAutoStartFollowUp(previousRun, runtimeDeterministicFailure)) return;
    const message = this.activeMessages.find((item) => {
      const metadata = queuedMessageMetadata(item);
      return item.role === "user" && metadata?.queueKind === "follow-up" && metadata.queueStatus === "pending" && metadata.runId === previousRun.id;
    });
    if (!message) return;
    await this.send({ queuedMessage: message, skipUserMessage: true });
  }

  private async takeSteering(runId: string): Promise<SteeringRecord[]> {
    if (!this.activeThread) return [];
    const pending = (await this.conversations.queuedMessages(this.activeThread.id, "steering")).filter((message) => queuedMessageMetadata(message)?.runId === runId);
    const delivered: SteeringRecord[] = [];
    for (const message of pending) {
      const updated = await this.conversations.transitionQueuedMessage(message.id, "delivered", runId);
      const index = this.activeMessages.findIndex((item) => item.id === message.id);
      if (index >= 0) this.activeMessages[index] = updated;
      delivered.push({ id: message.id, content: message.content, status: "delivered", attachments: await this.attachments.listForMessage(message.id) });
    }
    if (delivered.length) this.ui.renderMessages(this.activeMessages);
    return delivered;
  }

  private async steeringMessages(records: readonly SteeringRecord[]): Promise<AgentModelMessage[]> {
    const messages: AgentModelMessage[] = [];
    const supportsImages = this.selectedModel()?.capabilities.imageInput === "supported";
    for (const record of records) {
      const attachments: AttachmentRecord[] = [];
      for (const value of record.attachments ?? []) {
        if (!value || typeof value !== "object" || typeof (value as { id?: unknown }).id !== "string") continue;
        const stored = await this.attachments.get((value as { id: string }).id);
        if (stored) attachments.push(stored);
      }
      const text = `${steeringMessage(record)}${attachments.length && !supportsImages ? `\n[附件未发送：当前模型不支持图片输入；${attachments.map((item) => item.name).join("、")}]` : ""}`;
      if (!supportsImages || !attachments.length) { messages.push({ role: "user", content: text }); continue; }
      const parts: ModelContentPart[] = [{ type: "text", text }];
      for (const attachment of attachments) parts.push({ type: "image", mimeType: attachment.mimeType, data: await blobToBase64(attachment.blob), attachmentId: attachment.id });
      messages.push({ role: "user", content: parts });
    }
    return messages;
  }

  private async consumeDeliveredSteering(runId: string, steeringIds: readonly string[]): Promise<void> {
    const delivered = this.activeMessages.filter((message) => {
      const metadata = queuedMessageMetadata(message);
      return metadata?.queueKind === "steering" && metadata.queueStatus === "delivered" && metadata.runId === runId && steeringIds.includes(message.id);
    });
    for (const message of delivered) {
      const consumed = await this.conversations.transitionQueuedMessage(message.id, "consumed", runId);
      const index = this.activeMessages.findIndex((item) => item.id === message.id);
      if (index >= 0) this.activeMessages[index] = consumed;
    }
    if (delivered.length) {
      this.ui.renderMessages(this.activeMessages);
      await this.renderHistoricalAttachments();
    }
  }

  private async compactAgentCheckpoint(checkpoint: AgentCheckpointV2): Promise<AgentCheckpointV2> {
    const summary = formatAgentTaskCompactionState({
      goal: this.activeAgentSession?.run.intent ?? "继续当前任务",
      completedWork: checkpoint.evidence.map((item) => `${item.toolName}（callId=${item.callId}）`),
      changedFiles: checkpoint.accumulatedFiles,
      completedToolCallIds: checkpoint.completedToolCallIds,
      runtimeErrors: checkpoint.runtimeErrors.map((item) => `${item.toolName ?? "Runtime"}：${item.message}`),
      steering: checkpoint.steering.filter((item) => item.status !== "withdrawn").map((item) => item.content),
      remainingWork: checkpoint.pendingToolCalls.map((call) => `${call.name}（callId=${call.id}）`),
      nextStep: checkpoint.pendingToolCalls.length ? "继续执行尚未完成的工具批次。" : "根据目标和已有证据继续下一模型回合。"
    });
    const firstSystem = checkpoint.messages[0]?.role === "system" ? checkpoint.messages[0] : undefined;
    const candidates = firstSystem ? checkpoint.messages.slice(1) : checkpoint.messages;
    const selected = selectCompleteToolRounds(candidates, 8_000);
    return {
      ...checkpoint,
      stage: "compacted",
      messages: [...(firstSystem ? [firstSystem] : []), { role: "system", content: `【任务内压缩摘要】\n${summary}` }, ...selected.retainedMessages],
      compactionSummary: summary,
      updatedAt: new Date().toISOString()
    };
  }

  private async removeComposerAttachment(id: string): Promise<void> {
    const index = this.composerAttachments.findIndex((item) => item.id === id);
    if (index < 0) return;
    this.composerAttachments.splice(index, 1);
    const preview = this.attachmentPreviewUrls.get(id);
    if (preview) URL.revokeObjectURL(preview);
    this.attachmentPreviewUrls.delete(id);
    await this.attachments.delete(id);
    this.renderComposerAttachments();
  }

  private async clearComposerAttachments(deleteRecords = true): Promise<void> {
    const records = this.composerAttachments.splice(0);
    if (deleteRecords) await Promise.all(records.map((record) => this.attachments.delete(record.id)));
    for (const url of this.attachmentPreviewUrls.values()) URL.revokeObjectURL(url);
    this.attachmentPreviewUrls.clear();
    this.renderComposerAttachments();
  }

  private renderComposerAttachments(): void {
    this.ui.renderAttachments(this.composerAttachments.map((attachment) => {
      const previewUrl = this.attachmentPreviewUrls.get(attachment.id);
      return {
        id: attachment.id,
        name: attachment.name,
        size: attachment.size,
        mimeType: attachment.mimeType,
        ...(previewUrl ? { previewUrl } : {})
      };
    }));
  }

  private async renderHistoricalAttachments(): Promise<void> {
    if (!this.activeThread) return;
    const records = await this.attachments.listForThread(this.activeThread.id);
    const grouped = new Map<string, AttachmentRecord[]>();
    for (const attachment of records) {
      if (!attachment.messageId) continue;
      const list = grouped.get(attachment.messageId) ?? [];
      list.push(attachment);
      grouped.set(attachment.messageId, list);
    }
    for (const [messageId, items] of grouped) {
      this.ui.renderMessageAttachments(messageId, items.map((attachment) => {
        const previewUrl = URL.createObjectURL(attachment.blob);
        this.historyAttachmentPreviewUrls.set(attachment.id, previewUrl);
        return { id: attachment.id, name: attachment.name, size: attachment.size, mimeType: attachment.mimeType, previewUrl };
      }));
    }
  }

  private clearHistoryAttachmentPreviews(): void {
    for (const url of this.historyAttachmentPreviewUrls.values()) URL.revokeObjectURL(url);
    this.historyAttachmentPreviewUrls.clear();
  }

  private async refreshModelCatalog(showToast: boolean): Promise<void> {
    this.ui.setModelSelectorBusy(true);
    try {
      const result = await this.models.refreshModels();
      this.availableModels = result.models;
      this.ui.setComposerModelOptions(this.models.profiles, this.availableModels);
      this.ui.setModelSelection(this.models.currentProfile.id, this.models.current.model);
      this.updateContextUsage();
      if (showToast) {
        const warnings = [result.providerError, result.catalogError].filter(Boolean);
        this.ui.toast(warnings.length ? `已保留手动模型；目录刷新有提示：${warnings.join("；")}` : `已刷新 ${result.models.length} 个模型。`);
      }
    } catch (error) {
      if (showToast) this.ui.toast(`模型列表刷新失败：${errorMessage(error)}`);
    } finally { this.ui.setModelSelectorBusy(false); }
  }

  private async addCompatibleProvider(): Promise<void> {
    const name = window.prompt("供应商显示名称：", "自定义 Provider")?.trim();
    if (!name) return;
    const endpoint = window.prompt("OpenAI-compatible API Endpoint：", "https://example.com/v1/chat/completions")?.trim();
    if (!endpoint) return;
    const defaultModelId = window.prompt("默认模型 ID：", "model-name")?.trim();
    if (!defaultModelId) return;
    try {
      const profile = createOpenAICompatibleProfile({ name, endpoint, defaultModelId });
      await this.settings.putProviderProfile(profile);
      this.models.profiles = await this.settings.listProviderProfiles();
      await this.models.selectProfile(profile.id, false);
      await this.refreshModelCatalog(false);
      await this.persistThreadModelSelection();
      this.ui.apiKey.focus();
      this.ui.toast("兼容供应商已添加；请填写本会话使用的 API Key。 ");
    } catch (error) { this.ui.toast(errorMessage(error)); }
  }

  private async changeComposerProvider(): Promise<void> {
    if (this.busy) return;
    try {
      await this.models.selectProfile(this.ui.composerProvider.value, false);
      await this.refreshModelCatalog(false);
      await this.persistThreadModelSelection();
    } catch (error) { this.ui.toast(errorMessage(error)); }
  }

  private async changeComposerModel(): Promise<void> {
    if (this.busy) return;
    try {
      await this.models.selectModel(this.ui.composerModel.value, false);
      await this.persistThreadModelSelection();
      this.updateContextUsage();
    } catch (error) { this.ui.toast(errorMessage(error)); }
  }

  private async persistThreadModelSelection(): Promise<void> {
    if (!this.activeThread) return;
    const selection = { providerProfileId: this.models.currentProfile.id, modelId: this.models.current.model };
    await this.conversations.setModelSelection(this.activeThread.id, selection);
    this.activeThread = { ...this.activeThread, modelSelection: selection, updatedAt: new Date().toISOString() };
  }

  private selectedModel(): ModelDescriptor | undefined {
    return this.availableModels.find((model) => model.id === this.models.current.model && model.providerProfileId === this.models.currentProfile.id);
  }

  private updateContextUsage(): void {
    const summary = this.activeThread?.contextSummary;
    const messages = this.activeMessages.filter((message) => (message.role === "user" || message.role === "assistant") && (!summary || message.sequence > summary.throughSequence));
    const contextWindow = this.selectedModel()?.capabilities.contextWindow;
    const selection = selectContextMessages(messages, {
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(summary?.content ? { existingSummary: summary.content } : {})
    });
    this.ui.setContextUsage({
      estimatedTokens: selection.totalEstimatedTokens,
      contextWindow: selection.contextWindow,
      compressedMessages: summary?.sourceMessageCount ?? 0,
      canCompress: messages.length > 8 && !this.busy
    });
  }

  private async compressContextNow(): Promise<void> {
    if (!this.activeThread || this.busy || !this.models.hasConfiguration()) return;
    this.ui.compressContext.disabled = true;
    try {
      const provider = await this.models.createProvider();
      await this.prepareConversation(provider, [...this.activeMessages], true);
      this.updateContextUsage();
      this.ui.toast("上下文滚动摘要已更新；原始消息仍完整保留。 ");
    } catch (error) { this.ui.toast(`压缩失败，原始历史未受影响：${errorMessage(error)}`); }
    finally { this.updateContextUsage(); }
  }

  private stopActiveRun(): void {
    if (!this.activeRunController || this.activeRunController.signal.aborted) return;
    this.activeAgentSession?.abort(new DOMException("用户停止了运行。", "AbortError"));
    this.activeRunController.abort(new DOMException("用户停止了运行。", "AbortError"));
    this.ui.stopRun.disabled = true;
    this.ui.toast("正在停止模型、工具与 Runtime…");
  }

  private async authorizeTool(toolId: string, argumentsValue: Record<string, unknown>): Promise<void> {
    if (this.allowWritesForCurrentRun) return;
    const detail = await this.authorizationPreview(toolId, argumentsValue);
    if (!window.confirm(`Agent 请求执行需要授权的工具：${toolId}\n\n${detail}\n\n仅允许此次调用？`)) throw new Error(`用户拒绝执行工具：${toolId}`);
    if (window.confirm("是否允许本次运行后续所有写入和执行操作？\n\n选择“取消”只授权刚才这一项。")) this.allowWritesForCurrentRun = true;
  }

  private async authorizationPreview(toolId: string, argumentsValue: Record<string, unknown>): Promise<string> {
    const service = this.fileService;
    const path = typeof argumentsValue.path === "string" ? argumentsValue.path : undefined;
    if (service && toolId === "workspace.write" && path && typeof argumentsValue.content === "string") {
      const before = await readOptionalProjectBytes(service, path);
      return formatChangePreview(path, before, new TextEncoder().encode(argumentsValue.content)).slice(0, 12_000);
    }
    if (service && toolId === "workspace.apply_patch" && path && Array.isArray(argumentsValue.edits)) {
      const before = await readOptionalProjectBytes(service, path);
      const oldText = decodeTextPreview(before);
      if (oldText !== undefined) {
        const after = applyEditsForPreview(oldText, argumentsValue.edits);
        if (after !== undefined) return unifiedTextDiff(path, oldText, after).slice(0, 12_000);
      }
    }
    if (service && toolId === "workspace.delete" && path) {
      const target = await projectTargetSummary(service, path);
      return `删除：${path}\n目标：${target.description}\n大小：${formatBytes(target.bytes)}`;
    }
    if (service && toolId === "workspace.move" && typeof argumentsValue.from === "string" && typeof argumentsValue.to === "string") {
      const target = await projectTargetSummary(service, argumentsValue.from);
      return `移动：${argumentsValue.from} → ${argumentsValue.to}\n目标：${target.description}\n大小：${formatBytes(target.bytes)}`;
    }
    const outputPath = typeof argumentsValue.targetPath === "string" ? argumentsValue.targetPath : path;
    if (service && outputPath && /^(?:document|presentation|pdf|spreadsheet)\./.test(toolId)) {
      const existing = await readOptionalProjectBytes(service, outputPath);
      return `${toolId.includes("render") ? "渲染" : "生成"}二进制产物：${outputPath}\n现有目标大小：${formatBytes(existing.byteLength)}\n新产物将在授权后生成并重新读盘验证。`;
    }
    const safeArguments = Object.fromEntries(Object.entries(argumentsValue).map(([key, value]) =>
      /^(?:content|source|markdown|spec)$/i.test(key) && typeof value !== "number"
        ? [key, `[${typeof value === "string" ? `${value.length} 个字符` : "结构化内容"}]`]
        : [key, value]));
    return JSON.stringify(safeArguments, null, 2).slice(0, 4_000);
  }

  private async authorizeNetwork(url: URL): Promise<void> {
    const project = this.activeProject;
    if (!project) throw new Error("项目未连接。 ");
    if (project.networkAllowlist?.includes(url.hostname)) return;
    if (!window.confirm(`Agent 首次请求访问外部域名：\n${url.hostname}\n\n最终 URL：${url.href}\n\n网页内容将作为不可信输入处理。是否仅允许此次访问？`)) throw new Error(`用户拒绝访问域名：${url.hostname}`);
    if (window.confirm(`是否把 ${url.hostname} 保存到当前项目的网络白名单？`)) {
      const networkAllowlist = [...new Set([...(project.networkAllowlist ?? []), url.hostname])];
      this.activeProject = { ...project, networkAllowlist };
      await this.projects.put(this.activeProject);
    }
  }

  private async changeLoggingSettings(): Promise<void> {
    this.loggingEnabled = this.ui.loggingEnabled.checked;
    this.projectLoggingEnabled = this.ui.projectLoggingEnabled.checked;
    const level = isLogLevel(this.ui.logLevel.value) ? this.ui.logLevel.value : DEFAULT_LOG_LEVEL;
    await this.settings.putLogging({ key: "logging", level, enabled: this.loggingEnabled, projectFileEnabled: this.projectLoggingEnabled });
    this.configureAppLogging();
    this.ui.toast(this.loggingEnabled ? "诊断日志设置已更新。" : "持久日志已关闭；控制台仅保留 warn/error。 ");
  }

  private configureAppLogging(): void {
    const level = isLogLevel(this.ui.logLevel.value) ? this.ui.logLevel.value : DEFAULT_LOG_LEVEL;
    const projectSink = this.projectLoggingEnabled && this.fileService ? new ProjectFileLogSink(this.fileService) : undefined;
    const sink = composeLogSinks(this.logStore, projectSink);
    configureLogging({ ...(sink ? { sink } : {}), level, enabled: this.loggingEnabled });
    this.ui.projectLoggingEnabled.disabled = !this.fileService || !this.loggingEnabled;
  }

  private async refreshProjectControls(): Promise<void> {
    const project = this.activeProject;
    const service = this.fileService;
    if (!project) return;
    this.ui.setPermissionMode(project.permissionMode ?? "auto");
    let source: string | undefined;
    if (service) {
      if (await service.exists("/.browser-agent/instructions.md")) source = "/.browser-agent/instructions.md";
      else if (await service.exists("/AGENTS.md")) source = "/AGENTS.md";
    }
    this.ui.setProjectInstructions(project.instructionsEnabled === true, source);
  }

  private async changeProjectPermissionMode(): Promise<void> {
    const project = this.activeProject;
    const value = this.ui.permissionMode.value;
    if (!project || (value !== "readOnly" && value !== "confirmWrites" && value !== "auto")) return;
    this.activeProject = { ...project, permissionMode: value };
    await this.projects.put(this.activeProject);
    this.ui.toast(`项目权限模式已设为 ${value}。`);
  }

  private async changeProjectInstructions(): Promise<void> {
    const project = this.activeProject;
    if (!project) return;
    this.activeProject = { ...project, instructionsEnabled: this.ui.projectInstructionsEnabled.checked };
    await this.projects.put(this.activeProject);
    await this.refreshProjectControls();
  }

  private async refreshProjectPanels(): Promise<void> {
    const service = this.fileService;
    const thread = this.activeThread;
    if (!service || !thread) {
      this.ui.renderFileTree([]);
      this.ui.renderRuns([]);
      this.ui.renderChangeSets([]);
      return;
    }
    const [entries, runs, changeSets] = await Promise.all([service.list("/"), this.conversations.runs(thread.id), service.listChangeSets()]);
    const changesByRun = new Map(changeSets.map((changeSet) => [changeSet.runId, changeSet]));
    const currentChangeSet = changeSets.filter((changeSet) => changeSet.status !== "restored").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    const changedPaths = new Set(currentChangeSet?.changes.flatMap((change) => [change.path, ...(change.targetPath ? [change.targetPath] : [])]) ?? []);
    this.ui.renderFileTree(entries.filter((entry) => !isBrowserAgentInternalPath(entry.path)).map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(changedPaths.has(entry.path) ? { changed: true } : {})
    })), {
      open: (path) => this.openWorkspaceFile(path),
      viewDiff: (path) => this.showFileChangeHistory(path),
      restore: (path) => this.restoreLatestFileChange(path)
    });
    this.ui.renderRuns(runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((run) => {
      const changeSet = changesByRun.get(run.id);
      const error = [...run.events].reverse().find((event) => event.kind === "error")?.content;
      return {
        id: run.id,
        status: run.status,
        ...(run.model ? { model: run.model } : {}),
        durationMs: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)),
        toolCount: run.metrics?.toolCalls ?? (run.events.filter((event) => event.eventKind === "tool-start").length || Math.ceil(run.events.filter((event) => event.kind === "tool").length / 2)),
        networkHosts: [...new Set(run.events.flatMap((event) => event.networkHost ? [event.networkHost] : []))],
        changedFiles: [...new Set([...(run.outputPaths ?? []), ...(changeSet?.changes.flatMap((change) => [change.path, ...(change.targetPath ? [change.targetPath] : [])]) ?? [])])].filter((path) => !isBrowserAgentInternalPath(path)),
        createdAt: run.createdAt,
        canResume: (run.status === "paused" || run.status === "interrupted" || run.status === "failed") && Boolean(run.checkpoint),
        ...(error ? { error } : {})
      };
    }), {
      viewDiff: (runId) => this.showRunDiff(runId),
      restore: async (runId) => { await this.restoreRun(runId); },
      resume: (runId) => this.resumeRun(runId),
      retry: (runId, mode) => this.retryRun(runId, mode)
    });
    this.ui.renderChangeSets(changeSets.map((changeSet) => ({
      runId: changeSet.runId,
      status: changeSet.status,
      changeCount: changeSet.changes.length,
      updatedAt: changeSet.updatedAt
    })), async (runId) => { await this.restoreRun(runId); });
  }

  private async showFileChangeHistory(path: string): Promise<void> {
    const changeSets = await this.fileService?.listChangeSets() ?? [];
    const matches = changeSets.flatMap((changeSet) => changeSet.changes
      .filter((change) => change.path === path || change.targetPath === path)
      .map((change) => ({ changeSet, change }))).sort((left, right) => right.changeSet.updatedAt.localeCompare(left.changeSet.updatedAt));
    if (!matches.length || !this.fileService) { this.ui.showDiff(path, "该文件尚无 Agent ChangeSet 记录。 "); return; }
    const latest = matches[0]!;
    const preview = await this.fileService.previewChange(latest.changeSet.runId, latest.change.id);
    const history = matches.map(({ changeSet, change }) => `${changeSet.updatedAt}  ${changeSet.runId.slice(0, 8)}  ${change.type}  ${change.path}${change.targetPath ? ` → ${change.targetPath}` : ""}`).join("\n");
    this.ui.showDiff(path, `${formatChangePreview(preview.change.path, preview.before, preview.after)}\n\n变更历史：\n${history}`);
  }

  private async restoreLatestFileChange(path: string): Promise<void> {
    const service = this.fileService;
    if (!service) return;
    const changeSets = (await service.listChangeSets()).filter((changeSet) => changeSet.status !== "active" && changeSet.status !== "restored").sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const match = changeSets.flatMap((changeSet) => changeSet.changes.map((change) => ({ changeSet, change }))).find(({ change }) => change.path === path || change.targetPath === path);
    if (!match) { this.ui.toast("没有找到可恢复的文件变更。 "); return; }
    if (!window.confirm(`恢复 ${path} 在运行 ${match.changeSet.runId.slice(0, 8)} 中的变更吗？`)) return;
    try { await service.restoreChange(match.changeSet.runId, match.change.id); }
    catch (error) {
      if (!window.confirm(`${errorMessage(error)}\n\n是否强制恢复这一个变更？`)) throw error;
      await service.restoreChange(match.changeSet.runId, match.change.id, { force: true });
    }
    await service.refresh();
    await this.refreshProjectPanels();
  }

  private async showRunDiff(runId: string): Promise<void> {
    const changeSet = await this.fileService?.readChangeSet(runId);
    if (!changeSet) { this.ui.showDiff(`运行 ${runId.slice(0, 8)}`, "没有找到 ChangeSet。 "); return; }
    const lines: string[] = [];
    for (const change of changeSet.changes) {
      const preview = await this.fileService!.previewChange(runId, change.id);
      lines.push(`${change.type.toUpperCase()}  ${change.path}${change.targetPath ? ` → ${change.targetPath}` : ""}\n${formatChangePreview(change.targetPath ?? change.path, preview.before, preview.after)}`);
    }
    this.ui.showDiff(`运行 ${runId.slice(0, 8)} · ${changeSet.status}`, lines.join("\n\n"));
  }

  private async restoreRun(runId: string): Promise<boolean> {
    const service = this.fileService;
    if (!service || !window.confirm(`确定恢复运行 ${runId.slice(0, 8)} 的全部文件变更吗？`)) return false;
    try { await service.restoreRun(runId); }
    catch (error) {
      if (!window.confirm(`${errorMessage(error)}\n\n是否忽略指纹冲突并强制恢复？`)) return false;
      await service.restoreRun(runId, { force: true });
    }
    await service.refresh();
    await this.refreshProjectPanels();
    this.ui.toast("运行变更已恢复。 ");
    return true;
  }

  private async retryRun(runId: string, mode: "current" | "rollback"): Promise<void> {
    if (!this.activeThread || this.busy) return;
    const run = (await this.conversations.runs(this.activeThread.id)).find((item) => item.id === runId);
    if (!run) return;
    if (mode === "rollback" && !await this.restoreRun(runId)) return;
    await this.send({ intent: run.intent, retryOf: run, skipUserMessage: true });
  }

  private async resumeRun(runId: string): Promise<void> {
    if (!this.activeThread || this.busy) return;
    const run = (await this.conversations.runs(this.activeThread.id)).find((item) => item.id === runId);
    if (!run?.checkpoint) return;
    const { isAgentCheckpoint } = await import("../../../packages/agent-kernel/src/index");
    if (!isAgentCheckpoint(run.checkpoint)) {
      this.ui.toast("该运行的检查点无效，不能安全继续。");
      return;
    }
    await this.send({ intent: run.intent, resumeRun: run, skipUserMessage: true, resumeCheckpoint: run.checkpoint });
  }

  private renderSkillManager(): void {
    this.ui.renderSkillGroups(this.skills.listAll(), {
      inspect: (reference) => {
        const skill = this.skills.inspectInstalled(reference);
        window.alert(`${skill.name}\n版本：${skill.version ?? "未声明"}\n来源：${skill.source}\n权限：${skill.permissions?.join("、") || "无"}\n\n${skill.description}`);
      },
      setEnabled: async (reference, enabled) => {
        const skill = this.skills.inspectInstalled(reference);
        await this.skills.setEnabled(reference, enabled, skill.source !== "project");
        if (skill.source === "project" && skill.scopeId) saveProjectSkillEnabled(skill.scopeId, skill.id, enabled);
        this.renderSkillManager();
      },
      uninstall: async (reference) => {
        const skill = this.skills.inspectInstalled(reference);
        if (skill.source === "builtin" || skill.source === "project") { this.ui.toast("系统和项目 Skill 不能在此卸载，可选择禁用。"); return; }
        if (!window.confirm(`确定卸载 Skill“${skill.name}”吗？`)) return;
        await this.skills.uninstall(reference);
        this.renderSkillManager();
      }
    });
  }

  private renderMcpManager(): void {
    this.ui.renderMcpServers(this.mcpServers, {
      test: (id) => this.testMcpServer(id),
      setEnabled: async (id, enabled) => {
        this.mcpServers = this.mcpServers.map((server) => server.id === id ? { ...server, enabled, updatedAt: new Date().toISOString() } : server);
        await this.settings.putMcpServers(this.mcpServers);
        this.renderMcpManager();
      },
      remove: async (id) => {
        const server = this.mcpServers.find((candidate) => candidate.id === id);
        if (!server || !window.confirm(`确定移除 MCP Server“${server.name}”吗？`)) return;
        this.mcpServers = this.mcpServers.filter((candidate) => candidate.id !== id);
        await this.settings.putMcpServers(this.mcpServers);
        this.renderMcpManager();
      }
    });
  }

  private async addMcpServer(): Promise<void> {
    const name = this.ui.mcpName.value.trim();
    const urlValue = this.ui.mcpUrl.value.trim();
    if (!name || !urlValue) { this.ui.toast("请填写 MCP Server 名称和 Endpoint。"); return; }
    let url: URL;
    try { url = validateMcpUrl(urlValue); }
    catch (error) { this.ui.toast(errorMessage(error)); return; }
    if (this.mcpServers.some((server) => server.url === url.href)) { this.ui.toast("该 MCP Endpoint 已经配置。"); return; }
    const now = new Date().toISOString();
    const server: McpServerRecord = { id: crypto.randomUUID(), name, url: url.href, enabled: true, createdAt: now, updatedAt: now };
    this.mcpServers = [...this.mcpServers, server];
    await this.settings.putMcpServers(this.mcpServers);
    this.ui.mcpName.value = "";
    this.ui.mcpUrl.value = "";
    this.renderMcpManager();
    this.ui.toast(`已添加 MCP Server：${name}`);
  }

  private async testMcpServer(id: string): Promise<void> {
    const server = this.mcpServers.find((candidate) => candidate.id === id);
    if (!server) return;
    if (!this.activeProject) { this.ui.toast("请先打开一个项目，再测试 MCP 网络连接。"); return; }
    const testedAt = new Date().toISOString();
    try {
      const tools = await new McpHttpClient(server, (url) => this.authorizeNetwork(url)).listTools();
      this.mcpServers = this.mcpServers.map((candidate) => {
        if (candidate.id !== id) return candidate;
        const { lastError: _lastError, ...rest } = candidate;
        return {
          ...rest,
          lastTestedAt: testedAt,
          lastToolCount: tools.length,
          cachedTools: tools.map((tool) => ({
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema as unknown as Record<string, unknown>
          })),
          updatedAt: testedAt
        };
      });
      this.ui.toast(`MCP 连接正常：发现 ${tools.length} 个工具。`);
    } catch (error) {
      this.mcpServers = this.mcpServers.map((candidate) => candidate.id === id
        ? { ...candidate, lastTestedAt: testedAt, lastError: errorMessage(error).slice(0, 500), updatedAt: testedAt }
        : candidate);
      this.ui.toast(`MCP 测试失败：${errorMessage(error)}`);
    }
    await this.settings.putMcpServers(this.mcpServers);
    this.renderMcpManager();
  }

  private async exportProjectData(): Promise<void> {
    const project = this.activeProject;
    const service = this.fileService;
    if (!project || !service) { this.ui.toast("请先连接要导出的项目。 "); return; }
    const threads = await this.conversations.listThreads(project.id);
    const [messages, runs, attachments] = await Promise.all([
      Promise.all(threads.map((thread) => this.conversations.messages(thread.id))).then((items) => items.flat()),
      Promise.all(threads.map((thread) => this.conversations.runs(thread.id))).then((items) => items.flat()),
      Promise.all(threads.map((thread) => this.attachments.listForThread(thread.id))).then((items) => items.flat())
    ]);
    const bytes = await serializeProjectBackup({
      project,
      threads,
      messages,
      runs,
      providerProfiles: this.models.profiles,
      models: this.availableModels,
      skills: this.skills.listAll()
        .filter((skill) => skill.source !== "project")
        .map((skill) => this.skills.inspectInstalled(skill.key ?? skill.id)),
      changeSets: await service.listChangeSets(),
      recoveryBackups: await service.exportRecoveryBackups(),
      attachments
    });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const url = URL.createObjectURL(new Blob([buffer], { type: "application/json;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${project.name}-browser-agent-backup.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    this.ui.toast("项目配置、对话、Skill、附件和恢复索引已导出；不含 API Key。 ");
  }

  private async importProjectData(): Promise<void> {
    const file = this.ui.importLocalDataInput.files?.[0];
    this.ui.importLocalDataInput.value = "";
    if (!file) return;
    if (!window.confirm("导入会写入本地 Browser Agent 数据库；同 ID 记录将被覆盖。是否继续？")) return;
    const result = await importProjectBackup(file, { commit: (bundle) => this.commitProjectBackup(bundle) });
    await this.models.load();
    await this.loadSkills();
    await this.refreshSidebar();
    this.ui.toast(`导入完成：${result.threads} 个对话、${result.messages} 条消息、${result.attachments} 个附件。项目目录需要重新关联。`);
  }

  private async commitProjectBackup(bundle: ProjectBackupImportBundle): Promise<void> {
    const database = await this.database.open();
    const stores = ["projects", "threads", "messages", "runs", "providerProfiles", "attachments"] as const;
    const transaction = database.transaction(stores, "readwrite");
    transaction.objectStore("projects").put({ ...bundle.project, permissionHint: "missing", legacyRelinkRequired: true });
    for (const thread of bundle.threads) transaction.objectStore("threads").put(thread);
    for (const message of bundle.messages) transaction.objectStore("messages").put(message);
    for (const run of bundle.runs) transaction.objectStore("runs").put(run.status === "running" ? { ...run, status: "interrupted" } : run);
    for (const profile of bundle.providerProfiles) transaction.objectStore("providerProfiles").put(profile);
    for (const attachment of bundle.attachments) transaction.objectStore("attachments").put(attachment);
    await idbTransactionDone(transaction);
    await new OpfsChangeJournal().importRecovery(bundle.project.id, bundle.changeSets, bundle.recoveryBackups);
    for (const skill of bundle.skills) await this.skills.install(skill);
  }

  private async updateStorageUsage(): Promise<void> {
    try {
      const estimate = await navigator.storage.estimate();
      const used = formatBytes(estimate.usage ?? 0); const quota = estimate.quota ? formatBytes(estimate.quota) : "未知";
      this.ui.storageUsage.textContent = `${used} / ${quota}`;
    } catch { this.ui.storageUsage.textContent = "浏览器未提供存储统计"; }
  }

  private async changeLogLevel(): Promise<void> {
    const candidate = this.ui.logLevel.value;
    if (!isLogLevel(candidate)) return;
    await this.settings.putLogging({ key: "logging", level: candidate, enabled: this.loggingEnabled, projectFileEnabled: this.projectLoggingEnabled });
    this.configureAppLogging();
    appLog.info("诊断日志级别已更新", { level: candidate });
    await this.refreshLogs();
  }

  private async refreshLogs(): Promise<void> {
    await flushLogs();
    this.ui.renderLogs(await this.logStore.list(500));
  }

  private async exportLogs(): Promise<void> {
    appLog.info("用户导出诊断日志");
    await flushLogs();
    const records = (await this.logStore.list()).reverse();
    const body = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const url = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `browser-agent-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    this.ui.toast(`已导出 ${records.length} 条诊断日志。`);
  }

  private async clearLogs(): Promise<void> {
    appLog.warn("用户清空诊断日志");
    await flushLogs();
    await this.logStore.clear();
    this.ui.renderLogs([]);
    this.ui.toast("诊断日志已清空。 ");
  }

  private async pickDirectory(mode: "read" | "readwrite"): Promise<BrowserDirectoryHandle | undefined> {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) { this.ui.toast("当前浏览器不支持文件夹读写，请使用桌面版 Chrome 或 Edge。 "); return undefined; }
    try { return await picker({ mode }); }
    catch (error) { if (error instanceof DOMException && error.name === "AbortError") return undefined; this.ui.toast(errorMessage(error)); return undefined; }
  }
}

async function collectSkillFiles(directory: BrowserDirectoryHandle, prefix = ""): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  for await (const entry of directory.values()) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === "SKILL.md") continue;
    if (entry.kind === "directory") files.push(...await collectSkillFiles(entry, path));
    else {
      const file = await entry.getFile();
      if (file.size <= 1_000_000 && files.length < 100) files.push({ path, content: await file.text() });
    }
  }
  return files;
}
function stripAnsi(value: string): string { return value.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\r/g, ""); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function mimeTypeForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    csv: "text/csv;charset=utf-8", html: "text/html;charset=utf-8", jpeg: "image/jpeg", jpg: "image/jpeg", json: "application/json;charset=utf-8",
    md: "text/markdown;charset=utf-8", pdf: "application/pdf", png: "image/png", svg: "image/svg+xml", txt: "text/plain;charset=utf-8", webp: "image/webp"
  };
  return extension ? types[extension] ?? "application/octet-stream" : "application/octet-stream";
}
function formatBytes(value: number): string { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`; if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`; return `${(value / 1024 ** 3).toFixed(1)} GB`; }
function isLogLevel(value: string): value is AppLogLevel { return value === "trace" || value === "debug" || value === "info" || value === "warn" || value === "error"; }
function safeOrigin(value: string): string { try { return new URL(value).origin; } catch { return "invalid-url"; } }
function projectSkillStateKey(projectId: string, skillId: string): string { return `browser-agent-runtime:project-skill:${projectId}:${skillId}`; }
function readProjectSkillEnabled(projectId: string, skillId: string): boolean {
  try { return localStorage.getItem(projectSkillStateKey(projectId, skillId)) !== "disabled"; }
  catch { return true; }
}
function saveProjectSkillEnabled(projectId: string, skillId: string, enabled: boolean): void {
  try { localStorage.setItem(projectSkillStateKey(projectId, skillId), enabled ? "enabled" : "disabled"); }
  catch { /* 浏览器禁用本地存储时，项目 Skill 状态仅保留到当前页面。 */ }
}
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  return btoa(binary);
}
function idbTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB 导入事务已中止。"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB 导入事务失败。"));
  });
}
function formatChangePreview(path: string, before: Uint8Array, after: Uint8Array): string {
  const oldText = decodeTextPreview(before);
  const newText = decodeTextPreview(after);
  if (oldText === undefined || newText === undefined) return `二进制变更：${path}\n修改前 ${formatBytes(before.byteLength)}，修改后 ${formatBytes(after.byteLength)}`;
  return unifiedTextDiff(path, oldText, newText);
}
async function readOptionalProjectBytes(service: ProjectFileService, path: string): Promise<Uint8Array> {
  try { return (await service.read(path)).data; }
  catch { return new Uint8Array(); }
}
async function projectTargetSummary(service: ProjectFileService, path: string): Promise<{ description: string; bytes: number }> {
  try {
    const file = await service.read(path);
    return { description: "文件", bytes: file.data.byteLength };
  } catch {
    const entries = await service.list(path).catch(() => []);
    return {
      description: entries.length ? `目录（${entries.filter((entry) => entry.kind === "file").length} 个文件）` : "路径",
      bytes: entries.reduce((total, entry) => total + (entry.size ?? 0), 0)
    };
  }
}
function applyEditsForPreview(content: string, edits: unknown[]): string | undefined {
  let result = content;
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") return undefined;
    const { search, replace } = edit as { search?: unknown; replace?: unknown };
    if (typeof search !== "string" || typeof replace !== "string") return undefined;
    const first = result.indexOf(search);
    if (first < 0 || result.indexOf(search, first + search.length) >= 0) return undefined;
    result = `${result.slice(0, first)}${replace}${result.slice(first + search.length)}`;
  }
  return result;
}
function skillUpdateDiff(existing: SkillDescriptor, next: SkillDescriptor): string {
  const sections = [unifiedTextDiff(`/skills/${next.id}/SKILL.md`, existing.instructions, next.instructions)];
  const oldFiles = new Map(existing.files.map((file) => [file.path, file.content]));
  const newFiles = new Map(next.files.map((file) => [file.path, file.content]));
  for (const path of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const before = oldFiles.get(path) ?? "";
    const after = newFiles.get(path) ?? "";
    if (before === after) continue;
    sections.push(unifiedTextDiff(`/skills/${next.id}/${path}`, before, after));
  }
  return sections.join("\n\n");
}
function decodeTextPreview(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > 1_000_000 || bytes.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return undefined; }
}
function steeringMessage(item: SteeringRecord): string {
  return `[用户 Steering：${item.id}]\n${item.content}`;
}
function modelMessageContainsSteering(message: AgentModelMessage, steeringId: string): boolean {
  const marker = `[用户 Steering：${steeringId}]`;
  if (typeof message.content === "string") return message.content.includes(marker);
  return message.content.some((part) => part.type === "text" && part.text.includes(marker));
}
function unifiedTextDiff(path: string, before: string, after: string): string {
  const oldLines = before.split(/\r?\n/);
  const newLines = after.split(/\r?\n/);
  const lines = [`--- a${path.startsWith("/") ? path : `/${path}`}`, `+++ b${path.startsWith("/") ? path : `/${path}`}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`];
  const maximum = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < maximum; index += 1) {
    const previous = oldLines[index];
    const current = newLines[index];
    if (previous === current) { if (previous !== undefined) lines.push(` ${previous}`); continue; }
    if (previous !== undefined) lines.push(`-${previous}`);
    if (current !== undefined) lines.push(`+${current}`);
  }
  return lines.join("\n");
}
