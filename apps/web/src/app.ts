import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { AgentEvent } from "../../../packages/agent-kernel/src/index";
import { chunkContextMessagesForSummary, selectContextMessages } from "../../../packages/context-manager/src/index";
import { composeLogSinks, configureLogging, flushLogs, logger, type AppLogLevel } from "../../../packages/logging/src/index";
import type { ConversationTurn, ModelContentPart, ModelProvider } from "../../../packages/model-adapters/src/index";
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
  type MessageKind,
  type MessageRecord,
  type AttachmentRecord,
  type ModelDescriptor,
  type PersistedDirectoryHandle,
  type ProjectRecord,
  type RunRecord,
  type ThreadRecord
} from "../../../packages/persistence/src/index";
import { BUILTIN_TASK_TEMPLATES, loadProjectInstructions } from "../../../packages/project-context/src/index";
import { importProjectBackup, serializeProjectBackup, type ProjectBackupImportBundle } from "../../../packages/project-backup/src/index";
import { inspectWebContainerSupport, WebContainerRuntimeProvider, WorkspaceMirror, type MirrorEvent } from "../../../packages/runtime-webcontainer/src/index";
import type { InteractiveRuntimeSession, RuntimeSession, ScriptExecutionRequest, ScriptExecutionResult, ScriptRuntimeProvider, TerminalDimensions } from "../../../packages/runtime-contracts/src/index";
import { BrowserSkillStore, SkillRegistry, skillFromMarkdown, type SkillDescriptor, type SkillFile } from "../../../packages/skill-core/src/index";
import { appendWorkspaceFileLinks, browserAgentRunScratchDirectory, BROWSER_AGENT_INSTALLED_PACKAGE_DIRECTORY, BROWSER_AGENT_PACKAGE_DIRECTORY, BROWSER_AGENT_STATE_DIRECTORY, isBrowserAgentInternalPath, OpfsChangeJournal, ProjectFileLogSink, ProjectFileService, resolveDirectoryPermission, type BrowserDirectoryHandle, type ProjectFileChange } from "../../../packages/workspace-contracts/src/index";
import { AppUi } from "./ui";
import { ModelSettingsController } from "./model-settings-controller";
import { createOpenAICompatibleProfile } from "./model-settings";
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
  private readonly models = new ModelSettingsController(this.ui, this.settings);
  private readonly logStore = new BrowserLogStore(this.database);
  private readonly skills = new SkillRegistry(new BrowserSkillStore());
  private readonly mirror = new WorkspaceMirror((event) => this.onMirrorEvent(event));
  private readonly runtime = new WebContainerRuntimeProvider(this.mirror);
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
  private runtimeUnsupportedReported = false;
  private activeRunOutputPaths: Set<string> | undefined;
  private busy = false;
  private activeRunController: AbortController | undefined;
  private allowWritesForCurrentRun = false;
  private loggingEnabled = true;
  private projectLoggingEnabled = false;
  private terminalCollapsed = true;

  async boot(): Promise<void> {
    const runtimeSupport = inspectWebContainerSupport();
    appLog.info("开始启动 Browser Agent", { url: location.href, userAgent: navigator.userAgent, runtimeSupport });
    this.terminal.loadAddon(this.fit);
    this.terminal.open(this.ui.terminalHost);
    this.fit.fit();
    this.terminal.writeln("\x1b[90mBrowser Agent WebContainer Terminal\x1b[0m");
    this.terminal.writeln(runtimeSupport.supported
      ? `\x1b[90m${t("选择项目后点击“启动 Runtime”。", "Select a project, then choose Start Runtime.")}\x1b[0m`
      : `\x1b[33m${t("当前内嵌页面不支持 WebContainer；请使用启动脚本打开的独立 Chrome 或 Edge 页面。", "This embedded page cannot run WebContainer. Open the app in standalone Chrome or Edge using the startup script.")}\x1b[0m`);
    new ResizeObserver(() => { this.fit.fit(); this.interactiveSession?.resize(this.dimensions()); }).observe(this.ui.terminalHost);
    this.terminal.onData((data) => { if (this.interactiveSession) void this.interactiveSession.write(data); });
    this.bindEvents();
    this.ui.appLanguage.value = readLocalePreference();
    await this.database.open();
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
    this.ui.newProject.addEventListener("click", () => void this.newProject());
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
    this.ui.addProvider.addEventListener("click", () => void this.addCompatibleProvider());
    this.ui.installSkill.addEventListener("click", () => void this.installSkillFolder());
    this.ui.logLevel.addEventListener("change", () => void this.changeLogLevel());
    this.ui.loggingEnabled.addEventListener("change", () => void this.changeLoggingSettings());
    this.ui.projectLoggingEnabled.addEventListener("change", () => void this.changeLoggingSettings());
    this.ui.refreshLogs.addEventListener("click", () => void this.refreshLogs());
    this.ui.exportLogs.addEventListener("click", () => void this.exportLogs());
    this.ui.clearLogs.addEventListener("click", () => void this.clearLogs());
    this.ui.setTaskTemplates(BUILTIN_TASK_TEMPLATES.map((template) => ({ id: template.id, label: template.name, prompt: template.prompt })));
    window.addEventListener("focus", () => { if (this.mirror.ready) void this.mirror.syncExternalChanges(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && this.mirror.ready) void this.mirror.syncExternalChanges(); });
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
    const thread: ThreadRecord = { id: crypto.randomUUID(), projectId, title: "新建任务", modelSelection: this.models.globalSelection, createdAt: now, updatedAt: now };
    await this.conversations.putThread(thread);
    appLog.info("项目对话已创建", { projectId, threadId: thread.id });
    return thread;
  }

  private async openThread(threadId: string): Promise<void> {
    appLog.info("开始恢复对话", { threadId });
    await this.flushTerminalTranscript();
    this.interactiveSession?.kill();
    this.interactiveSession = undefined;
    if (this.activeThread?.projectId !== (await this.conversations.getThread(threadId))?.projectId) await this.mirror.disconnect();
    this.fileService = undefined;
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
    const service = new ProjectFileService(project.id, handle, new OpfsChangeJournal(), async (change) => {
      this.trackRunOutput(change);
      if (this.mirror.ready && change.source !== "terminal") await this.mirror.syncHostPath(change.path.includes(" → ") ? change.path.split(" → ").at(-1)! : change.path);
    });
    const createdState = await service.ensureDirectory(BROWSER_AGENT_STATE_DIRECTORY);
    const createdPackages = await service.ensureDirectory(BROWSER_AGENT_PACKAGE_DIRECTORY);
    const createdInstalledPackages = await service.ensureDirectory(BROWSER_AGENT_INSTALLED_PACKAGE_DIRECTORY);
    const interruptedChangeSets = await service.interruptActiveChangeSets();
    const entries = await service.captureBaseline();
    const projectFileCount = entries.filter((entry) => entry.kind === "file" && !isBrowserAgentInternalPath(entry.path)).length;
    appLog.info("真实项目文件服务已连接", { projectId: project.id, projectName: project.name, files: projectFileCount, interruptedChangeSets, browserAgentDirectoriesCreated: createdState || createdPackages || createdInstalledPackages });
    this.fileService = service;
    this.configureAppLogging();
    const updated: ProjectRecord = { ...project, permissionHint: "granted", legacyRelinkRequired: false, lastOpenedAt: new Date().toISOString() };
    await this.projects.put(updated);
    this.activeProject = updated;
    this.ui.setConnection("connected", `已连接 · ${projectFileCount} 个文件`);
    const runtimeSupport = inspectWebContainerSupport();
    this.ui.terminalStart.disabled = !runtimeSupport.supported;
    if (!runtimeSupport.supported) this.ui.runtimeStatus.textContent = "需在独立 Chrome / Edge 中打开";
    this.ui.setBusy(false, this.models.hasConfiguration() ? "模型和项目已就绪" : "请在设置中配置模型 API");
    await this.refreshProjectControls();
    await this.refreshProjectPanels();
  }

  private disconnectUi(label: string, status: "permission" | "missing", action: { label: string; run(): void }): void {
    this.fileService = undefined;
    this.configureAppLogging();
    this.ui.setConnection(status, label, action);
    this.ui.terminalStart.disabled = true;
    this.ui.setBusy(false, this.models.hasConfiguration() ? "可继续普通对话，文件工具暂不可用" : "请先配置模型 API");
  }

  private async ensureRuntime(interactive: boolean): Promise<void> {
    if (!this.fileService) {
      const message = "项目文件夹尚未连接。";
      this.ui.toast(message);
      appLog.warn("Runtime 启动被拒绝：项目未连接", { interactive });
      throw new Error(message);
    }
    if (interactive) this.setTerminalCollapsed(false);
    const runtimeSupport = inspectWebContainerSupport();
    if (!runtimeSupport.supported) {
      const message = runtimeSupport.message ?? "当前浏览器上下文不支持 WebContainer。";
      this.reportUnsupportedRuntime(message);
      throw new Error(message);
    }
    if (this.runtimeStartPromise) {
      appLog.debug("等待正在进行的 Runtime 启动", { interactive });
      await this.runtimeStartPromise;
      return;
    }
    this.ui.terminalStart.disabled = true;
    this.runtimeStartPromise = this.startRuntime(interactive).finally(() => {
      this.runtimeStartPromise = undefined;
      if (!this.interactiveSession) this.ui.terminalStart.disabled = !this.fileService || !inspectWebContainerSupport().supported;
    });
    await this.runtimeStartPromise;
  }

  private async startRuntime(interactive: boolean): Promise<void> {
    const projectId = this.fileService?.projectId;
    try {
      appLog.info("请求启动 Runtime", { projectId, interactive, mirrorReady: this.mirror.ready });
      this.ui.runtimeStatus.textContent = "正在启动…";
      if (!this.mirror.ready && this.fileService) await this.mirror.connect(this.fileService);
      if (interactive && !this.interactiveSession) {
        this.interactiveSession = await this.runtime.startInteractive((data) => this.onTerminalOutput(data), this.dimensions());
        this.ui.terminalStart.textContent = "Runtime 已启动";
        this.ui.terminalStart.disabled = true;
        this.terminal.focus();
      }
      this.ui.runtimeStatus.textContent = "WebContainer 已连接";
      appLog.info("Runtime 启动完成", { projectId, interactive, shellStarted: Boolean(this.interactiveSession) });
    } catch (error) {
      this.ui.runtimeStatus.textContent = "启动失败";
      appLog.error("Runtime 启动失败", { projectId, interactive }, error);
      this.ui.toast(errorMessage(error));
      this.terminal.writeln(`\r\n\x1b[31m[Runtime] ${errorMessage(error)}\x1b[0m`);
      throw error;
    }
  }

  private async send(options: { intent?: string; retryOf?: RunRecord; skipUserMessage?: boolean } = {}): Promise<void> {
    const typedIntent = options.intent?.trim() ?? this.ui.intent.value.trim();
    const intent = typedIntent || (this.composerAttachments.length ? "请分析这些图片。" : "");
    if (!intent || !this.activeThread || this.busy) return;
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
    const previousMessages = [...this.activeMessages];
    const attachmentsForRun = options.skipUserMessage ? [] : this.composerAttachments;
    const attachmentParts = await Promise.all(attachmentsForRun.map(async (attachment): Promise<ModelContentPart> => ({
      type: "image",
      mimeType: attachment.mimeType,
      data: await blobToBase64(attachment.blob),
      attachmentId: attachment.id
    })));
    appLog.info("开始 Agent 回合", { threadId: this.activeThread.id, projectId: this.activeProject?.id, inputCharacters: intent.length, attachments: attachmentParts.length, connected: Boolean(this.fileService) });
    this.ui.intent.value = "";
    this.ui.resizeComposer();
    const userMessage = options.skipUserMessage ? undefined : await this.appendMessage("user", "user", intent, attachmentParts.length ? {
      attachments: attachmentsForRun.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
    } : undefined);
    if (userMessage) {
      await Promise.all(attachmentsForRun.map((attachment) => this.attachments.attachToMessage(attachment.id, userMessage.id)));
      const items = attachmentsForRun.map((attachment) => {
        const previewUrl = URL.createObjectURL(attachment.blob);
        this.historyAttachmentPreviewUrls.set(attachment.id, previewUrl);
        return { id: attachment.id, name: attachment.name, size: attachment.size, mimeType: attachment.mimeType, previewUrl };
      });
      this.ui.renderMessageAttachments(userMessage.id, items);
    }
    if (!options.skipUserMessage) await this.clearComposerAttachments(false);
    if (!options.skipUserMessage && this.activeThread.title === "新建任务") {
      this.activeThread = { ...this.activeThread, title: intent.slice(0, 42), updatedAt: new Date().toISOString() };
      await this.conversations.putThread(this.activeThread);
      this.ui.setActiveThread(this.activeThread, this.activeProject);
      await this.refreshSidebar();
    }
    this.busy = true;
    const controller = new AbortController();
    this.activeRunController = controller;
    this.allowWritesForCurrentRun = false;
    this.activeRunOutputPaths = new Set<string>();
    this.ui.setBusy(true, "Agent 正在工作…");
    const run: RunRecord = {
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
    await this.conversations.putRun(run);
    try {
      const [provider, agentKernel] = await Promise.all([
        this.models.createProvider(),
        import("../../../packages/agent-kernel/src/index")
      ]);
      const previousConversation = await this.prepareConversation(provider, previousMessages, false, controller.signal);
      if (this.mirror.ready) await this.mirror.syncExternalChanges(); else await fileService.refresh();
      await fileService.beginRun(run.id);
      await fileService.ensureDirectory(browserAgentRunScratchDirectory(run.id));
      const runtime = this.lazyRuntime();
      const onWorkspaceWrite = (path: string): Promise<void> => this.mirror.syncHostPath(path);
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
      const projectInstructions = await loadProjectInstructions(fileService, this.activeProject?.instructionsEnabled === true);
      const result = await new agentKernel.AgentLoop(provider).run({
        intent,
        workspaceId: this.activeProject?.id ?? "project",
        tools,
        conversation: previousConversation,
        ...(attachmentParts.length ? { attachments: attachmentParts } : {}),
        allowImageToolResults: this.selectedModel()?.capabilities.imageInput === "supported",
        signal: controller.signal,
        environment: {
          runtime: {
            id: runtime.id,
            available: await runtime.available(),
            shell: "WebContainer jsh（特殊浏览器 Shell，不是宿主系统 Shell）",
            workingDirectory: "/workspace",
            limitations: runtime.limitations?.() ?? ["Runtime 能力信息不可用"]
          },
          skills: this.skills.list(),
          scratchDirectory: browserAgentRunScratchDirectory(run.id),
          ...(projectInstructions ? { projectInstructions } : {})
        }
      }, (event) => this.recordAgentEvent(run, event));
      run.status = controller.signal.aborted ? "cancelled" : result.task.phase === "COMPLETED" ? "completed" : "failed";
      this.ui.completeToolRun(run.id, run.status === "completed" ? "completed" : "failed");
      appLog.info("Agent 回合结束", { threadId: this.activeThread.id, runId: run.id, status: run.status, events: run.events.length });
    } catch (error) {
      run.status = controller.signal.aborted ? "cancelled" : "failed";
      appLog.error("Agent 回合失败", { threadId: this.activeThread.id, runId: run.id, events: run.events.length }, error);
      this.ui.discardAssistantStream();
      this.ui.completeToolRun(run.id, "failed");
      await this.appendMessage("system", "error", controller.signal.aborted ? "运行已由用户停止。" : errorMessage(error));
    } finally {
      try { await fileService.endRun(run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "failed"); }
      catch (error) { appLog.error("结束 ChangeSet 失败", { runId: run.id }, error); }
      run.updatedAt = new Date().toISOString();
      await this.conversations.putRun(run);
      this.activeRunOutputPaths = undefined;
      this.activeRunController = undefined;
      this.busy = false;
      this.ui.setBusy(false, this.fileService ? "模型和项目已就绪" : "项目未连接，文件工具不可用");
      this.updateContextUsage();
      await this.refreshProjectPanels();
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
    if (!canRunAgent(descriptor)) {
      if (descriptor.capabilities.toolCalling === "unsupported") { this.ui.toast("当前模型明确不支持工具调用，不能运行项目 Agent。 "); return false; }
      if (!window.confirm(`模型 ${descriptor.name} 的工具调用能力未知。\n\n只有确认该模型支持工具调用才能继续。是否由你声明支持？`)) return false;
      overrides.toolCalling = "supported";
    }
    if (needsImages && !canSendImages(descriptor)) {
      if (descriptor.capabilities.imageInput === "unsupported") { this.ui.toast("当前模型不支持图片输入，请切换模型后重试。 "); return false; }
      if (!window.confirm(`模型 ${descriptor.name} 的图片输入能力未知。\n\n是否由你声明该模型支持图片输入？`)) return false;
      overrides.imageInput = "supported";
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
    if (event.kind === "phase") return;
    if (event.kind === "assistant-delta") { this.ui.appendAssistantDelta(event.content); return; }
    if (event.kind === "assistant") {
      const heading = event.metadata?.failure === true ? "失败前产生的文件（可能不完整）：" : "本次输出文件：";
      const content = event.metadata?.final === true ? await this.withOutputFileLinks(event.content, heading) : event.content;
      await this.appendMessage("assistant", "assistant", content);
      return;
    }
    const callId = typeof event.metadata?.callId === "string" ? event.metadata.callId : undefined;
    const isToolStep = Boolean(event.toolName && callId);
    if (event.kind === "error" && !isToolStep) this.ui.discardAssistantStream();
    let networkHost: string | undefined;
    if (event.kind === "tool-start" && event.toolName === "network.fetch" && typeof event.metadata?.arguments === "object" && event.metadata.arguments) {
      const url = (event.metadata.arguments as Record<string, unknown>).url;
      if (typeof url === "string") try { networkHost = new URL(url).hostname; } catch { /* 无效 URL 会由工具本身报告。 */ }
    }
    if (event.kind === "tool-result" && event.toolName === "network.fetch") {
      try {
        const finalUrl = (JSON.parse(event.content) as { finalUrl?: unknown }).finalUrl;
        if (typeof finalUrl === "string") networkHost = new URL(finalUrl).hostname;
      } catch { /* 工具失败或截断结果不会影响运行记录。 */ }
    }
    run.events.push({
      at: new Date().toISOString(),
      kind: event.kind === "error" ? "error" : "tool",
      content: event.content,
      eventKind: event.kind === "tool-start" || event.kind === "tool-result" ? event.kind : "error",
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(networkHost ? { networkHost } : {})
    });
    const kind: MessageKind = isToolStep ? "tool" : event.kind === "error" ? "error" : "tool";
    if (event.kind === "error") appLog.error("Agent 工具事件失败", { runId: run.id, toolName: event.toolName, eventKind: event.kind });
    else appLog.info("Agent 工具事件", { runId: run.id, toolName: event.toolName, eventKind: event.kind });
    const metadata: Record<string, unknown> = { ...(event.metadata ?? {}), runId: run.id, eventKind: event.kind };
    if (event.toolName) metadata.toolName = event.toolName;
    await this.appendMessage("system", kind, event.content, metadata);
  }

  private lazyRuntime(): ScriptRuntimeProvider {
    return {
      id: this.runtime.id,
      available: () => this.runtime.available(),
      start: async (): Promise<RuntimeSession> => { await this.ensureRuntime(false); return this.runtime.start(); },
      execute: (session: RuntimeSession, request: ScriptExecutionRequest): Promise<ScriptExecutionResult> => this.runtime.execute(session, request),
      startInteractive: (onOutput: (data: string) => void, dimensions: TerminalDimensions) => this.runtime.startInteractive(onOutput, dimensions),
      terminate: (session: RuntimeSession) => this.runtime.terminate(session),
      limitations: () => this.runtime.limitations()
    };
  }

  private trackRunOutput(change: ProjectFileChange): void {
    const paths = this.activeRunOutputPaths;
    if (!paths || change.source === "external" || isBrowserAgentInternalPath(change.path)) return;
    const remove = (path: string): void => {
      for (const current of paths) if (current === path || current.startsWith(`${path}/`)) paths.delete(current);
    };
    if (change.type === "move") {
      const [from, to] = change.path.split(" → ");
      if (from) remove(from);
      if (to) paths.add(to);
      return;
    }
    if (change.type === "delete") { remove(change.path); return; }
    paths.add(change.path);
  }

  private async withOutputFileLinks(content: string, heading: string): Promise<string> {
    const service = this.fileService;
    const candidates = this.activeRunOutputPaths;
    if (!service || !candidates?.size) return content;
    const files: string[] = [];
    for (const path of candidates) {
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
      const existing = this.skills.listAll().some((item) => item.id === skill.id) ? this.skills.inspectInstalled(skill.id) : undefined;
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
      await this.mirror.disconnect();
      this.clearHistoryAttachmentPreviews();
      this.activeThread = undefined; this.activeProject = undefined; this.activeMessages = []; this.fileService = undefined;
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
    return this.activeMessages.filter((message): message is MessageRecord & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant").map(({ role, content }) => ({ role, content }));
  }

  private onMirrorEvent(event: MirrorEvent): void {
    this.ui.runtimeStatus.textContent = event.message;
    if (event.kind === "error" || event.kind === "conflict") this.ui.toast(event.message);
  }

  private onTerminalOutput(data: string): void {
    this.terminal.write(data);
    this.terminalBuffer += stripAnsi(data);
    if (!this.terminalFlushTimer) this.terminalFlushTimer = setTimeout(() => { this.terminalFlushTimer = undefined; void this.flushTerminalTranscript(); }, 900);
  }

  private reportUnsupportedRuntime(message: string): void {
    this.ui.runtimeStatus.textContent = "当前页面不支持 Runtime";
    this.ui.terminalStart.disabled = true;
    appLog.warn("Runtime 启动被拒绝：浏览器缺少跨源隔离能力", { ...inspectWebContainerSupport() });
    this.ui.toast(message);
    if (!this.runtimeUnsupportedReported) {
      this.runtimeUnsupportedReported = true;
      this.terminal.writeln(`\r\n\x1b[33m[Runtime] ${message}\x1b[0m`);
    }
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
    if (!thread || this.busy) return;
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
    this.activeRunController.abort(new DOMException("用户停止了运行。", "AbortError"));
    this.interactiveSession?.kill();
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
        toolCount: run.events.filter((event) => event.eventKind === "tool-start").length || Math.ceil(run.events.filter((event) => event.kind === "tool").length / 2),
        networkHosts: [...new Set(run.events.flatMap((event) => event.networkHost ? [event.networkHost] : []))],
        changedFiles: [...new Set(changeSet?.changes.flatMap((change) => [change.path, ...(change.targetPath ? [change.targetPath] : [])]) ?? [])],
        createdAt: run.createdAt,
        ...(error ? { error } : {})
      };
    }), {
      viewDiff: (runId) => this.showRunDiff(runId),
      restore: async (runId) => { await this.restoreRun(runId); },
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
    if (this.mirror.ready) await this.mirror.syncExternalChanges();
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
    if (this.mirror.ready) await this.mirror.syncExternalChanges();
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

  private renderSkillManager(): void {
    this.ui.renderSkills(this.skills.listAll(), {
      inspect: (id) => {
        const skill = this.skills.inspectInstalled(id);
        window.alert(`${skill.name}\n版本：${skill.version ?? "未声明"}\n来源：${skill.source}\n权限：${skill.permissions?.join("、") || "无"}\n\n${skill.description}`);
      },
      setEnabled: async (id, enabled) => { await this.skills.setEnabled(id, enabled); this.renderSkillManager(); },
      uninstall: async (id) => {
        const skill = this.skills.inspectInstalled(id);
        if (skill.source === "builtin") { this.ui.toast("内置 Skill 不能卸载，可选择禁用。 "); return; }
        if (!window.confirm(`确定卸载 Skill“${skill.name}”吗？`)) return;
        await this.skills.uninstall(id);
        this.renderSkillManager();
      }
    });
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
      skills: this.skills.listAll().map((skill) => this.skills.inspectInstalled(skill.id)),
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
