import type { App as VueApp } from "vue";
import type { AppLogRecord } from "../../../packages/logging/src/index";
import type { McpServerRecord, MessageRecord, ModelDescriptor, ProjectRecord, ProviderProfile, ThreadRecord } from "../../../packages/persistence/src/index";
import type { SkillSummary } from "../../../packages/skill-core/src/index";
import { workspacePathFromHref } from "../../../packages/workspace-contracts/src/index";
import { APP_VERSION } from "../../../packages/version";
import { t } from "./i18n";

export interface SidebarActions {
  openThread(threadId: string): void;
  createThread(projectId: string): void;
  deleteThread(threadId: string): void;
}

export type ConnectionStatus = "connected" | "permission" | "missing" | "conflict" | "disconnected";

interface MarkdownMessageMount {
  article: HTMLElement;
  host: HTMLElement;
  state: { content: string; final: boolean };
}

type ToolStepStatus = "running" | "completed" | "failed";
export type ToolRunStatus = "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";

interface ToolStepMount {
  details: HTMLDetailsElement;
  command: HTMLElement;
  stateLabel: HTMLElement;
  argumentsOutput: HTMLElement;
  resultOutput: HTMLElement;
  status: ToolStepStatus;
}

interface ToolRunMount {
  id: string;
  article: HTMLElement;
  details: HTMLDetailsElement;
  indicator: HTMLElement;
  title: HTMLElement;
  count: HTMLElement;
  stepList: HTMLElement;
  steps: Map<string, ToolStepMount>;
  status: ToolRunStatus;
  userExpanded?: boolean;
}

export interface ComposerAttachmentItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  previewUrl?: string;
}

export interface ContextUsageView {
  estimatedTokens: number;
  contextWindow: number;
  compressedMessages: number;
  canCompress?: boolean;
}

export interface ImageSelectionResult {
  accepted: File[];
  rejected: Array<{ file: File; reason: string }>;
}

export type ProjectPermissionMode = "readOnly" | "confirmWrites" | "auto";

export interface FileTreeItem {
  path: string;
  kind: "file" | "directory";
  size?: number;
  changed?: boolean;
}

export interface FileTreeActions {
  open?(path: string): void | Promise<void>;
  viewDiff?(path: string): void | Promise<void>;
  restore?(path: string): void | Promise<void>;
}

export interface RunCenterItem {
  id: string;
  status: "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";
  model?: string;
  durationMs?: number;
  toolCount: number;
  networkHosts?: string[];
  changedFiles: string[];
  createdAt: string;
  error?: string;
  canResume?: boolean;
}

export interface RunCenterActions {
  viewDiff?(runId: string): void | Promise<void>;
  restore?(runId: string): void | Promise<void>;
  retry?(runId: string, mode: "current" | "rollback"): void | Promise<void>;
  resume?(runId: string): void | Promise<void>;
}

export interface ChangeSetListItem {
  runId: string;
  status: "active" | "paused" | "completed" | "failed" | "cancelled" | "interrupted" | "restored";
  changeCount: number;
  updatedAt: string;
}

export interface SkillActions {
  inspect?(skillReference: string): void | Promise<void>;
  setEnabled?(skillReference: string, enabled: boolean): void | Promise<void>;
  uninstall?(skillReference: string): void | Promise<void>;
}

export interface McpServerActions {
  test?(serverId: string): void | Promise<void>;
  setEnabled?(serverId: string, enabled: boolean): void | Promise<void>;
  remove?(serverId: string): void | Promise<void>;
}

const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_IMAGE_BYTES = 16 * 1024 * 1024;

export function selectSupportedImages(files: Iterable<File>, availableBytes = MAX_MESSAGE_IMAGE_BYTES): ImageSelectionResult {
  const accepted: File[] = [];
  const rejected: Array<{ file: File; reason: string }> = [];
  let total = 0;
  for (const file of files) {
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) { rejected.push({ file, reason: "仅支持 JPEG、PNG 和 WebP" }); continue; }
    if (file.size > MAX_IMAGE_BYTES) { rejected.push({ file, reason: "单张图片不能超过 8 MiB" }); continue; }
    if (total + file.size > availableBytes) { rejected.push({ file, reason: "单条消息的图片合计不能超过 16 MiB" }); continue; }
    accepted.push(file);
    total += file.size;
  }
  return { accepted, rejected };
}

export function toolRunShouldBeOpen(status: ToolRunStatus, userExpanded?: boolean): boolean {
  if (status === "running" || status === "paused" || status === "failed") return true;
  return userExpanded === true;
}

export function visibleFileTreeItems(entries: FileTreeItem[], query = ""): FileTreeItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return entries
    .filter((entry) => !isInternalBrowserAgentPath(entry.path))
    .filter((entry) => !normalizedQuery || entry.path.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    .sort((left, right) => left.kind === right.kind ? left.path.localeCompare(right.path, "zh-CN") : left.kind === "directory" ? -1 : 1);
}

export class AppUi {
  readonly newProject = required<HTMLButtonElement>("#new-project");
  readonly pluginsTrigger = required<HTMLButtonElement>("#plugins-trigger");
  readonly projectList = required<HTMLElement>("#project-list");
  readonly threadTitle = required<HTMLElement>("#thread-title");
  readonly projectLabel = required<HTMLElement>("#project-label");
  readonly connectionStatus = required<HTMLElement>("#connection-status");
  readonly connectionAction = required<HTMLButtonElement>("#connection-action");
  readonly activeModel = required<HTMLElement>("#active-model");
  readonly emptyState = required<HTMLElement>("#empty-state");
  readonly messageFeed = required<HTMLElement>("#message-feed");
  readonly chatScroll = required<HTMLElement>("#chat-scroll");
  readonly intent = required<HTMLTextAreaElement>("#intent");
  readonly send = required<HTMLButtonElement>("#send");
  readonly stopRun = required<HTMLButtonElement>("#stop-run");
  readonly composerSendMode = required<HTMLSelectElement>("#composer-send-mode");
  readonly composerStatus = required<HTMLElement>("#composer-status");
  readonly composerProvider = required<HTMLSelectElement>("#composer-provider");
  readonly composerModel = required<HTMLSelectElement>("#composer-model");
  readonly refreshModels = required<HTMLButtonElement>("#refresh-models");
  readonly attachmentInput = required<HTMLInputElement>("#attachment-input");
  readonly attachmentTrigger = required<HTMLButtonElement>("#attachment-trigger");
  readonly attachmentPreview = required<HTMLElement>("#attachment-preview");
  readonly contextStatus = required<HTMLElement>("#context-status");
  readonly compressContext = required<HTMLButtonElement>("#compress-context");
  readonly filePanelTrigger = required<HTMLButtonElement>("#file-panel-trigger");
  readonly runPanelTrigger = required<HTMLButtonElement>("#run-panel-trigger");
  readonly fileTreePanel = required<HTMLElement>("#file-tree-panel");
  readonly runCenterPanel = required<HTMLElement>("#run-center-panel");
  readonly fileSearch = required<HTMLInputElement>("#file-search");
  readonly fileTree = required<HTMLElement>("#file-tree");
  readonly runList = required<HTMLElement>("#run-list");
  readonly changeSetList = required<HTMLElement>("#changeset-list");
  readonly diffViewer = required<HTMLElement>("#diff-viewer");
  readonly diffTitle = required<HTMLElement>("#diff-title");
  readonly diffContent = required<HTMLElement>("#diff-content");
  readonly diffClose = required<HTMLButtonElement>("#diff-close");
  readonly terminalHost = required<HTMLElement>("#terminal-host");
  readonly workspaceLayout = required<HTMLElement>("#workspace-layout");
  readonly terminalToggle = required<HTMLButtonElement>("#terminal-toggle");
  readonly terminalStart = required<HTMLButtonElement>("#terminal-start");
  readonly terminalClear = required<HTMLButtonElement>("#terminal-clear");
  readonly runtimeStatus = required<HTMLElement>("#runtime-status");
  readonly settingsTrigger = required<HTMLButtonElement>("#settings-trigger");
  readonly appVersion = required<HTMLElement>("#app-version");
  readonly settingsDialog = required<HTMLDialogElement>("#settings-dialog");
  readonly pluginsDialog = required<HTMLDialogElement>("#plugins-dialog");
  readonly appLanguage = required<HTMLSelectElement>("#app-language");
  readonly providerMode = required<HTMLSelectElement>("#provider-mode");
  readonly providerUrl = required<HTMLInputElement>("#provider-url");
  readonly modelName = required<HTMLInputElement>("#model-name");
  readonly apiKey = required<HTMLInputElement>("#api-key");
  readonly modelHelp = required<HTMLElement>("#model-help");
  readonly saveModel = required<HTMLButtonElement>("#save-model");
  readonly quickTestModel = required<HTMLButtonElement>("#quick-test-model");
  readonly modelProbeStatus = required<HTMLElement>("#model-probe-status");
  readonly addProvider = required<HTMLButtonElement>("#add-provider");
  readonly installSkill = required<HTMLButtonElement>("#install-skill");
  readonly refreshProjectSkills = required<HTMLButtonElement>("#refresh-project-skills");
  readonly systemSkillList = required<HTMLElement>("#system-skill-list");
  readonly userSkillList = required<HTMLElement>("#user-skill-list");
  readonly projectSkillList = required<HTMLElement>("#project-skill-list");
  readonly projectSkillHelp = required<HTMLElement>("#project-skill-help");
  readonly mcpName = required<HTMLInputElement>("#mcp-name");
  readonly mcpUrl = required<HTMLInputElement>("#mcp-url");
  readonly addMcpServer = required<HTMLButtonElement>("#add-mcp-server");
  readonly mcpServerList = required<HTMLElement>("#mcp-server-list");
  readonly logLevel = required<HTMLSelectElement>("#log-level");
  readonly loggingEnabled = required<HTMLInputElement>("#logging-enabled");
  readonly projectLoggingEnabled = required<HTMLInputElement>("#project-logging-enabled");
  readonly refreshLogs = required<HTMLButtonElement>("#refresh-logs");
  readonly exportLogs = required<HTMLButtonElement>("#export-logs");
  readonly clearLogs = required<HTMLButtonElement>("#clear-logs");
  readonly logList = required<HTMLElement>("#log-list");
  readonly storageUsage = required<HTMLElement>("#storage-usage");
  readonly permissionMode = required<HTMLSelectElement>("#permission-mode");
  readonly projectInstructionsEnabled = required<HTMLInputElement>("#project-instructions-enabled");
  readonly projectInstructionsSource = required<HTMLElement>("#project-instructions-source");
  readonly exportLocalData = required<HTMLButtonElement>("#export-local-data");
  readonly importLocalData = required<HTMLButtonElement>("#import-local-data");
  readonly importLocalDataInput = required<HTMLInputElement>("#import-local-data-input");
  readonly toastElement = required<HTMLElement>("#toast");
  private toastTimer?: ReturnType<typeof setTimeout>;
  private readonly markdownApps = new Map<HTMLElement, VueApp>();
  private readonly toolRuns = new Map<string, ToolRunMount>();
  private streamingAssistant: MarkdownMessageMount | undefined;
  private pendingAssistantDelta = "";
  private assistantDeltaFrame: number | undefined;
  private workspaceFileOpener?: (path: string) => void | Promise<void>;
  private queuedMessageHandler?: (messageId: string) => void | Promise<void>;
  private attachmentHandler: ((files: File[]) => void | Promise<void>) | undefined;
  private attachmentRemoveHandler: ((id: string) => void | Promise<void>) | undefined;
  private composerModels: ModelDescriptor[] = [];
  private modelSelectorBusy = false;
  private attachmentBytes = 0;
  private fileEntries: FileTreeItem[] = [];
  private fileTreeActions: FileTreeActions = {};

  constructor() {
    this.appVersion.textContent = `v${APP_VERSION}`;
    this.intent.addEventListener("input", () => this.resizeComposer());
    this.filePanelTrigger.addEventListener("click", () => this.toggleWorkspacePanel(this.fileTreePanel, this.filePanelTrigger));
    this.runPanelTrigger.addEventListener("click", () => this.toggleWorkspacePanel(this.runCenterPanel, this.runPanelTrigger));
    for (const close of this.fileTreePanel.querySelectorAll<HTMLButtonElement>(".panel-close")) close.addEventListener("click", () => this.closeWorkspacePanel(this.fileTreePanel, this.filePanelTrigger));
    for (const close of this.runCenterPanel.querySelectorAll<HTMLButtonElement>(".panel-close")) close.addEventListener("click", () => this.closeWorkspacePanel(this.runCenterPanel, this.runPanelTrigger));
    this.fileSearch.addEventListener("input", () => this.renderFilteredFileTree());
    this.diffClose.addEventListener("click", () => { this.diffViewer.hidden = true; });
    this.importLocalData.addEventListener("click", () => this.importLocalDataInput.click());
    this.attachmentTrigger.addEventListener("click", () => this.attachmentInput.click());
    this.composerProvider.addEventListener("change", () => { this.renderComposerModels(); this.updateComposerControls(); });
    this.attachmentInput.addEventListener("change", () => {
      void this.dispatchAttachments(this.attachmentInput.files ? [...this.attachmentInput.files] : []);
      this.attachmentInput.value = "";
    });
    const composer = required<HTMLElement>(".composer");
    composer.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types.includes("Files") || this.attachmentInput.disabled) return;
      event.preventDefault();
      composer.classList.add("drag-active");
    });
    composer.addEventListener("dragleave", (event) => {
      if (!composer.contains(event.relatedTarget as Node | null)) composer.classList.remove("drag-active");
    });
    composer.addEventListener("drop", (event) => {
      composer.classList.remove("drag-active");
      if (!event.dataTransfer?.files.length || this.attachmentInput.disabled) return;
      event.preventDefault();
      void this.dispatchAttachments([...event.dataTransfer.files]);
    });
    this.intent.addEventListener("paste", (event) => {
      const files = event.clipboardData?.files ? [...event.clipboardData.files] : [];
      if (!files.length || this.attachmentInput.disabled) return;
      event.preventDefault();
      void this.dispatchAttachments(files);
    });
    this.messageFeed.addEventListener("click", (event) => {
      const target = event.target;
      const withdraw = target instanceof Element ? target.closest<HTMLButtonElement>("[data-withdraw-queued]") : null;
      if (withdraw?.dataset.withdrawQueued) {
        void Promise.resolve(this.queuedMessageHandler?.(withdraw.dataset.withdrawQueued)).catch((error) => this.toast(error instanceof Error ? error.message : String(error)));
        return;
      }
      const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>("a") : null;
      const path = anchor ? workspacePathFromHref(anchor.href, location.href) : undefined;
      if (!path) return;
      event.preventDefault();
      if (!this.workspaceFileOpener) { this.toast("项目文件尚未连接，暂时无法打开。"); return; }
      void Promise.resolve(this.workspaceFileOpener(path)).catch((error) => this.toast(error instanceof Error ? error.message : String(error)));
    });
  }

  setWorkspaceFileOpener(opener: (path: string) => void | Promise<void>): void { this.workspaceFileOpener = opener; }
  setQueuedMessageHandler(handler: (messageId: string) => void | Promise<void>): void { this.queuedMessageHandler = handler; }

  setPermissionMode(mode: ProjectPermissionMode): void { this.permissionMode.value = mode; }

  setProjectInstructions(enabled: boolean, source?: string): void {
    this.projectInstructionsEnabled.checked = enabled;
    this.projectInstructionsEnabled.disabled = !source;
    this.projectInstructionsSource.textContent = source ? `当前来源：${source}` : "未发现 AGENTS.md 或 .browser-agent/instructions.md";
  }

  renderFileTree(entries: FileTreeItem[], actions: FileTreeActions = {}): void {
    this.fileEntries = entries;
    this.fileTreeActions = actions;
    this.renderFilteredFileTree();
  }

  renderRuns(runs: RunCenterItem[], actions: RunCenterActions = {}): void {
    this.runList.replaceChildren();
    if (!runs.length) { this.runList.append(element("div", "panel-empty", "尚无运行记录。")); return; }
    for (const run of runs) {
      const item = element("article", `run-item status-${run.status}`);
      const header = element("header");
      const title = element("div", "run-title");
      title.append(element("span", `run-status ${run.status}`, runStatusLabel(run.status)), element("time", "", formatShortDate(run.createdAt)));
      header.append(title, element("code", "run-id", run.id.slice(0, 8)));
      const metrics = element("div", "run-metrics");
      metrics.append(
        metric("模型", run.model ?? "未知"),
        metric("耗时", run.durationMs === undefined ? "—" : formatDuration(run.durationMs)),
        metric("工具", String(run.toolCount)),
        metric("网络", run.networkHosts?.length ? run.networkHosts.join("、") : "无"),
        metric("变更", String(run.changedFiles.length))
      );
      item.append(header, metrics);
      if (run.changedFiles.length) {
        const files = element("div", "run-files", run.changedFiles.slice(0, 3).join("、"));
        files.title = run.changedFiles.join("\n");
        item.append(files);
      }
      if (run.error) item.append(element("div", "run-error", run.error));
      const buttons = element("div", "item-actions");
      appendActionButton(buttons, "查看 Diff", Boolean(actions.viewDiff), () => this.runUiAction(() => actions.viewDiff?.(run.id)));
      appendActionButton(buttons, "恢复", Boolean(actions.restore), () => this.runUiAction(() => actions.restore?.(run.id)));
      if (run.canResume) appendActionButton(buttons, "从检查点继续", Boolean(actions.resume), () => this.runUiAction(() => actions.resume?.(run.id)));
      appendActionButton(buttons, "基于当前状态重试", Boolean(actions.retry), () => this.runUiAction(() => actions.retry?.(run.id, "current")));
      appendActionButton(buttons, "回滚后重试", Boolean(actions.retry), () => this.runUiAction(() => actions.retry?.(run.id, "rollback")));
      item.append(buttons);
      this.runList.append(item);
    }
  }

  renderChangeSets(changeSets: ChangeSetListItem[], restore?: (runId: string) => void | Promise<void>): void {
    this.changeSetList.replaceChildren();
    if (!changeSets.length) { this.changeSetList.append(element("div", "panel-empty", "尚无 ChangeSet。")); return; }
    for (const changeSet of changeSets) {
      const item = element("article", "changeset-item");
      const body = element("div");
      body.append(
        element("strong", "", `运行 ${changeSet.runId.slice(0, 8)}`),
        element("span", "", `${changeSetStatusLabel(changeSet.status)} · ${changeSet.changeCount} 项变更 · ${formatShortDate(changeSet.updatedAt)}`)
      );
      const button = element("button", "", "整次恢复") as HTMLButtonElement;
      button.type = "button";
      button.disabled = !restore || changeSet.status === "active" || changeSet.status === "restored";
      button.addEventListener("click", () => this.runUiAction(() => restore?.(changeSet.runId)));
      item.append(body, button);
      this.changeSetList.append(item);
    }
  }

  showDiff(title: string, diff: string): void {
    this.diffTitle.textContent = title;
    this.diffContent.textContent = diff || "没有文本差异。";
    this.diffViewer.hidden = false;
    if (this.fileTreePanel.hidden) this.toggleWorkspacePanel(this.fileTreePanel, this.filePanelTrigger);
    this.diffClose.focus();
  }

  setAttachmentHandler(handler: (files: File[]) => void | Promise<void>, remove?: (id: string) => void | Promise<void>): void {
    this.attachmentHandler = handler;
    this.attachmentRemoveHandler = remove;
  }

  renderAttachments(attachments: ComposerAttachmentItem[]): void {
    this.attachmentPreview.replaceChildren();
    this.attachmentPreview.hidden = attachments.length === 0;
    this.attachmentBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
    for (const attachment of attachments) {
      const item = element("figure", "attachment-item");
      if (attachment.previewUrl) {
        const image = element("img", "attachment-thumbnail") as HTMLImageElement;
        image.src = attachment.previewUrl;
        image.alt = attachment.name;
        item.append(image);
      } else item.append(element("div", "attachment-thumbnail placeholder", "图片"));
      const caption = element("figcaption");
      caption.append(element("strong", "", attachment.name), element("span", "", formatBytes(attachment.size)));
      const remove = element("button", "attachment-remove", "×") as HTMLButtonElement;
      remove.type = "button";
      remove.title = `移除 ${attachment.name}`;
      remove.setAttribute("aria-label", remove.title);
      remove.addEventListener("click", () => {
        if (!this.attachmentRemoveHandler) return;
        void Promise.resolve(this.attachmentRemoveHandler(attachment.id)).catch((error) => this.toast(error instanceof Error ? error.message : String(error)));
      });
      item.append(caption, remove);
      this.attachmentPreview.append(item);
    }
  }

  setComposerModelOptions(providers: ProviderProfile[], models: ModelDescriptor[]): void {
    const selectedProvider = this.composerProvider.value;
    const selectedModel = this.composerModel.value;
    this.composerModels = models;
    this.composerProvider.replaceChildren(...providers.map((provider) => option(provider.id, provider.name)));
    this.composerProvider.value = providers.some((provider) => provider.id === selectedProvider) ? selectedProvider : providers[0]?.id ?? "";
    this.renderComposerModels(selectedModel);
    this.updateComposerControls();
  }

  setModelSelection(providerProfileId: string, modelId: string): void {
    this.composerProvider.value = providerProfileId;
    this.renderComposerModels(modelId);
    this.updateComposerControls();
  }

  setModelSelectorBusy(busy: boolean): void { this.modelSelectorBusy = busy; this.updateComposerControls(); }

  setAttachmentInputEnabled(enabled: boolean): void {
    this.attachmentInput.disabled = !enabled;
    this.attachmentTrigger.disabled = !enabled;
  }

  setContextUsage(usage?: ContextUsageView): void {
    if (!usage) {
      this.contextStatus.textContent = "上下文尚未估算";
      this.contextStatus.removeAttribute("title");
      this.compressContext.disabled = true;
      return;
    }
    const percent = usage.contextWindow > 0 ? Math.min(999, Math.round(usage.estimatedTokens / usage.contextWindow * 100)) : 0;
    this.contextStatus.textContent = `上下文 ${formatCompactNumber(usage.estimatedTokens)} / ${formatCompactNumber(usage.contextWindow)} · ${percent}%${usage.compressedMessages ? ` · 已压缩 ${usage.compressedMessages} 条` : ""}`;
    this.contextStatus.title = `估算 ${usage.estimatedTokens.toLocaleString("zh-CN")} tokens；上下文窗口 ${usage.contextWindow.toLocaleString("zh-CN")} tokens`;
    this.compressContext.disabled = usage.canCompress === false || usage.estimatedTokens === 0;
  }

  setStopAvailable(available: boolean): void {
    this.stopRun.hidden = !available;
    this.stopRun.disabled = !available;
    this.send.hidden = false;
  }

  renderSidebar(projects: ProjectRecord[], threads: ThreadRecord[], activeThreadId: string | undefined, actions: SidebarActions): void {
    this.projectList.replaceChildren();
    if (!projects.length) { this.projectList.append(element("div", "sidebar-empty", "还没有项目")); return; }
    for (const project of projects) {
      const group = element("section", "project-group");
      const heading = element("div", "project-heading");
      heading.append(element("span", "folder", "▱"));
      const name = element("strong", "", project.name);
      name.title = project.name;
      heading.append(name);
      const add = element("button", "", "＋") as HTMLButtonElement;
      add.type = "button"; add.title = `在 ${project.name} 中新建对话`;
      add.setAttribute("aria-label", add.title);
      add.addEventListener("click", () => actions.createThread(project.id));
      heading.append(add);
      group.append(heading);
      for (const thread of threads.filter((item) => item.projectId === project.id)) {
        const row = element("div", `thread-row${thread.id === activeThreadId ? " selected" : ""}`);
        const open = element("button", "thread-open", thread.title) as HTMLButtonElement;
        open.type = "button"; open.title = thread.title; open.addEventListener("click", () => actions.openThread(thread.id));
        const remove = element("button", "thread-delete", "×") as HTMLButtonElement;
        remove.type = "button"; remove.title = "删除对话"; remove.addEventListener("click", () => actions.deleteThread(thread.id));
        remove.setAttribute("aria-label", `删除对话：${thread.title}`);
        row.append(open, remove); group.append(row);
      }
      this.projectList.append(group);
    }
  }

  renderMessages(messages: MessageRecord[]): void {
    if (this.assistantDeltaFrame !== undefined) cancelAnimationFrame(this.assistantDeltaFrame);
    this.assistantDeltaFrame = undefined;
    this.pendingAssistantDelta = "";
    this.streamingAssistant = undefined;
    for (const app of this.markdownApps.values()) app.unmount();
    this.markdownApps.clear();
    this.toolRuns.clear();
    this.messageFeed.replaceChildren();
    for (const message of messages) this.appendMessage(message, false);
    for (const run of this.toolRuns.values()) this.completeToolRun(run.id, [...run.steps.values()].some((step) => step.status === "running" || step.status === "failed") ? "failed" : "completed");
    this.emptyState.hidden = messages.length > 0 || Boolean(this.threadTitle.dataset.active);
    this.scrollToBottom();
  }

  appendMessage(message: MessageRecord, scroll = true): void {
    this.emptyState.hidden = true;
    if (message.kind === "tool") {
      this.appendToolEvent(message);
      if (scroll) this.scrollToBottom();
      return;
    }
    let article: HTMLElement;
    if (message.kind === "assistant") {
      article = this.createAssistantMessage(message.content, true).article;
    } else {
      article = element("article", `message ${message.kind}`);
      if (message.kind === "user") {
        article.append(element("div", "message-bubble", message.content));
        if (typeof message.metadata?.queueStatus === "string") {
          const rawStatus = message.metadata.queueStatus === "running" ? "delivered" : message.metadata.queueStatus;
          const queueKind = message.metadata.queueKind === "steering" ? "steering" : "follow-up";
          article.classList.add("queued", `queue-${rawStatus}`);
          const queueBar = element("div", "queued-message-bar");
          const statusLabel = t(rawStatus === "pending" ? queueKind === "steering" ? "等待引导当前任务" : "等待当前任务完成" : rawStatus === "delivered" ? "已投递到当前任务" : rawStatus === "withdrawn" ? "已撤回" : "已消费");
          queueBar.append(element("span", "queued-message-label", statusLabel));
          if (rawStatus === "pending") {
            const withdraw = element("button", "queued-message-withdraw", t("撤回")) as HTMLButtonElement;
            withdraw.type = "button";
            withdraw.dataset.withdrawQueued = message.id;
            queueBar.append(withdraw);
          }
          article.append(queueBar);
        }
      }
      else {
        const card = element("div", "event-card");
        const header = element("header");
        header.append(element("span", "", eventTitle(message)), element("span", "", formatTime(message.createdAt)));
        const pre = element("pre", "", message.content);
        card.append(header, pre); article.append(card);
      }
    }
    article.dataset.messageId = message.id;
    this.messageFeed.append(article);
    if (scroll) this.scrollToBottom();
  }

  renderMessageAttachments(messageId: string, attachments: ComposerAttachmentItem[]): void {
    const article = [...this.messageFeed.querySelectorAll<HTMLElement>("[data-message-id]")].find((item) => item.dataset.messageId === messageId);
    if (!article) return;
    article.querySelector(".message-attachments")?.remove();
    if (!attachments.length) return;
    const gallery = element("div", "message-attachments");
    for (const attachment of attachments) {
      const figure = element("figure", "message-attachment");
      if (attachment.previewUrl) {
        const image = element("img", "message-attachment-image") as HTMLImageElement;
        image.src = attachment.previewUrl;
        image.alt = attachment.name;
        figure.append(image);
      }
      const caption = element("figcaption", "", `${attachment.name} · ${formatBytes(attachment.size)}`);
      figure.append(caption);
      gallery.append(figure);
    }
    article.append(gallery);
  }

  completeToolRun(runId: string, status: Exclude<ToolRunStatus, "running">): void {
    const run = this.toolRuns.get(runId);
    if (!run) return;
    run.status = status;
    run.article.dataset.status = status;
    run.indicator.className = `tool-run-indicator ${status}`;
    run.title.textContent = t({
      paused: "运行已暂停",
      completed: "运行完成",
      failed: "运行失败",
      cancelled: "运行已取消",
      interrupted: "运行已中断"
    }[status]);
    run.details.open = toolRunShouldBeOpen(status, run.userExpanded);
    for (const step of run.steps.values()) {
      if (step.status !== "running") continue;
      this.setToolStepStatus(step, "failed");
      step.resultOutput.textContent = t("工具未返回输出，运行已结束。");
    }
  }

  private appendToolEvent(message: MessageRecord): void {
    const metadata = message.metadata ?? {};
    const storedEventKind = typeof metadata.eventKind === "string" ? metadata.eventKind : undefined;
    const structured = storedEventKind === "tool-start" || storedEventKind === "tool-result" || storedEventKind === "error";
    const eventKind = structured ? storedEventKind : "tool-result";
    const runId = structured && typeof metadata.runId === "string" ? metadata.runId : `legacy-${message.id}`;
    const callId = structured && typeof metadata.callId === "string" ? metadata.callId : message.id;
    const toolName = typeof metadata.toolName === "string" ? metadata.toolName : "Agent 工具";
    const toolArguments = isRecord(metadata.arguments) ? metadata.arguments : undefined;
    const run = this.toolRuns.get(runId) ?? this.createToolRun(runId);
    let step = run.steps.get(callId);
    if (!step) {
      step = this.createToolStep(run, callId, toolName);
      run.steps.set(callId, step);
      run.count.textContent = t(`${run.steps.size} 个步骤`);
    }
    if (eventKind === "tool-start") {
      run.title.textContent = t("运行中");
      step.command.textContent = toolCommand(toolName, toolArguments, message.content);
      step.argumentsOutput.textContent = formatToolValue(toolArguments ?? parseArgumentsFromCall(message.content, toolName));
      step.resultOutput.textContent = t("等待工具输出…");
      this.setToolStepStatus(step, "running");
    } else {
      if (step.command.textContent === toolName) step.command.textContent = toolCommand(toolName, toolArguments, "");
      step.resultOutput.textContent = formatToolValue(message.content);
      this.setToolStepStatus(step, eventKind === "error" ? "failed" : "completed");
      if (eventKind === "error" && run.status === "running") run.title.textContent = t("步骤失败，正在重新规划");
    }
  }

  private createToolRun(runId: string): ToolRunMount {
    const article = element("article", "message tool-run");
    article.dataset.runId = runId;
    article.dataset.status = "running";
    const details = element("details", "tool-run-card") as HTMLDetailsElement;
    details.open = true;
    const header = element("summary", "tool-run-header");
    const heading = element("div", "tool-run-heading");
    const indicator = element("span", "tool-run-indicator running", "");
    const title = element("strong", "", t("运行中"));
    const count = element("span", "tool-run-count", t("0 个步骤"));
    heading.append(indicator, title, count);
    header.append(heading, element("span", "tool-run-hint", t("点击展开或收起")));
    const stepList = element("div", "tool-step-list");
    details.append(header, stepList);
    article.append(details);
    this.messageFeed.append(article);
    const run: ToolRunMount = { id: runId, article, details, indicator, title, count, stepList, steps: new Map(), status: "running" };
    header.addEventListener("click", () => { run.userExpanded = !details.open; });
    this.toolRuns.set(runId, run);
    return run;
  }

  private createToolStep(run: ToolRunMount, callId: string, toolName: string): ToolStepMount {
    const details = element("details", "tool-step") as HTMLDetailsElement;
    details.dataset.callId = callId;
    details.dataset.status = "running";
    details.open = false;
    const summary = element("summary", "tool-step-summary");
    const chevron = element("span", "tool-step-chevron", "›");
    const command = element("code", "tool-step-command", toolName);
    const stateLabel = element("span", "tool-step-state", t("运行中"));
    summary.append(chevron, command, stateLabel);
    const body = element("div", "tool-step-body");
    const argumentsSection = element("section", "tool-step-section");
    argumentsSection.append(element("div", "tool-step-label", t("调用参数")));
    const argumentsOutput = element("pre", "tool-step-output", "—");
    argumentsSection.append(argumentsOutput);
    const resultSection = element("section", "tool-step-section");
    resultSection.append(element("div", "tool-step-label", t("输出")));
    const resultOutput = element("pre", "tool-step-output pending", t("等待工具输出…"));
    resultSection.append(resultOutput);
    body.append(argumentsSection, resultSection);
    details.append(summary, body);
    run.stepList.append(details);
    return { details, command, stateLabel, argumentsOutput, resultOutput, status: "running" };
  }

  private setToolStepStatus(step: ToolStepMount, status: ToolStepStatus): void {
    step.status = status;
    step.details.dataset.status = status;
    step.stateLabel.textContent = t(status === "running" ? "运行中" : status === "completed" ? "已完成" : "失败");
    step.resultOutput.classList.toggle("pending", status === "running");
  }

  appendAssistantDelta(delta: string): void {
    if (!delta) return;
    this.pendingAssistantDelta += delta;
    if (this.assistantDeltaFrame !== undefined) return;
    this.assistantDeltaFrame = requestAnimationFrame(() => {
      this.assistantDeltaFrame = undefined;
      this.flushAssistantDelta();
    });
  }

  private flushAssistantDelta(): void {
    const delta = this.pendingAssistantDelta;
    this.pendingAssistantDelta = "";
    if (!delta) return;
    if (!this.streamingAssistant) {
      this.emptyState.hidden = true;
      this.streamingAssistant = this.createAssistantMessage("", false);
      this.messageFeed.append(this.streamingAssistant.article);
    }
    this.streamingAssistant.state.content += delta;
    if (!this.markdownApps.has(this.streamingAssistant.host)) this.streamingAssistant.host.textContent = this.streamingAssistant.state.content;
    this.scrollToBottom();
  }

  completeAssistantMessage(message: MessageRecord): void {
    if (this.assistantDeltaFrame !== undefined) cancelAnimationFrame(this.assistantDeltaFrame);
    this.assistantDeltaFrame = undefined;
    this.flushAssistantDelta();
    const streaming = this.streamingAssistant;
    if (!streaming) { this.appendMessage(message); return; }
    streaming.state.content = message.content;
    streaming.state.final = true;
    if (!this.markdownApps.has(streaming.host)) streaming.host.textContent = message.content;
    streaming.article.dataset.messageId = message.id;
    this.streamingAssistant = undefined;
    this.scrollToBottom();
  }

  discardAssistantStream(): void {
    if (this.assistantDeltaFrame !== undefined) cancelAnimationFrame(this.assistantDeltaFrame);
    this.assistantDeltaFrame = undefined;
    this.pendingAssistantDelta = "";
    const streaming = this.streamingAssistant;
    if (!streaming) return;
    this.markdownApps.get(streaming.host)?.unmount();
    this.markdownApps.delete(streaming.host);
    streaming.article.remove();
    this.streamingAssistant = undefined;
  }

  private createAssistantMessage(content: string, final: boolean): MarkdownMessageMount {
    const article = element("article", "message assistant");
    article.append(element("div", "assistant-mark", "✦"));
    const host = element("div", "message-bubble markdown-message");
    const mount = { article, host, state: { content, final } };
    host.textContent = content;
    article.append(host);
    void this.mountMarkdown(mount);
    return mount;
  }

  private async mountMarkdown(mount: MarkdownMessageMount): Promise<void> {
    const [{ createApp, h, reactive }, { default: MarkdownRender }] = await Promise.all([
      import("vue"),
      import("markstream-vue")
    ]);
    if (!mount.host.isConnected) return;
    const state = reactive({ content: mount.state.content, final: mount.state.final });
    mount.state = state;
    const app = createApp({
      name: "AssistantMarkdownMessage",
      setup: () => () => h(MarkdownRender, {
        content: state.content,
        final: state.final,
        customId: "chat",
        htmlPolicy: "escape",
        isDark: true,
        smoothStreaming: state.final ? false : "auto",
        fade: false,
        typewriter: !state.final,
        maxLiveNodes: 0,
        batchRendering: true,
        renderBatchSize: 16,
        renderBatchDelay: 8,
        renderBatchBudgetMs: 4,
        renderCodeBlocksAsPre: true
      })
    });
    app.mount(mount.host);
    this.markdownApps.set(mount.host, app);
  }

  setActiveThread(thread: ThreadRecord | undefined, project: ProjectRecord | undefined): void {
    this.threadTitle.textContent = thread?.title ?? "新建项目";
    this.threadTitle.dataset.active = thread ? "true" : "";
    this.projectLabel.textContent = project?.name ?? "选择项目文件夹开始";
    this.intent.disabled = !thread;
    this.send.disabled = !thread;
    this.setAttachmentInputEnabled(Boolean(thread));
    this.updateComposerControls();
    this.terminalStart.disabled = !thread;
    this.terminalClear.disabled = !thread;
    if (!thread) this.emptyState.hidden = false;
  }

  setTerminalCollapsed(collapsed: boolean): void {
    this.workspaceLayout.classList.toggle("terminal-collapsed", collapsed);
    this.terminalToggle.textContent = collapsed ? "展开终端" : "收起终端";
    this.terminalToggle.setAttribute("aria-expanded", String(!collapsed));
  }

  setConnection(status: ConnectionStatus, label: string, action?: { label: string; run(): void }): void {
    this.connectionStatus.className = `connection-status ${status}`;
    this.connectionStatus.textContent = label;
    this.connectionAction.onclick = action ? action.run : null;
    if (action) { this.connectionAction.hidden = false; this.connectionAction.textContent = action.label; }
    else this.connectionAction.hidden = true;
  }

  setBusy(busy: boolean, status: string): void {
    const active = Boolean(this.threadTitle.dataset.active);
    this.intent.disabled = !active;
    this.send.disabled = !active;
    this.send.textContent = busy ? "＋" : "↑";
    this.send.title = t(busy ? "排队发送" : "发送");
    this.send.setAttribute("aria-label", this.send.title);
    this.composerSendMode.hidden = !busy;
    this.composerSendMode.disabled = !busy;
    if (!busy) this.composerSendMode.value = "steering";
    this.composerStatus.textContent = t(status);
    this.setModelSelectorBusy(busy);
    this.setAttachmentInputEnabled(active);
    this.setStopAvailable(busy);
  }

  private renderComposerModels(preferredModel = ""): void {
    const providerId = this.composerProvider.value;
    const models = this.composerModels.filter((model) => model.providerProfileId === providerId);
    this.composerModel.replaceChildren(...models.map((model) => {
      const badges = [
        capabilityLabel("工具", model.capabilities.toolCalling),
        capabilityLabel("图片", model.capabilities.imageInput),
        model.capabilities.contextWindow ? formatCompactNumber(model.capabilities.contextWindow) : "上下文未知"
      ];
      const item = option(model.id, `${model.name} · ${badges.join(" · ")}`);
      item.disabled = model.capabilities.toolCalling === "unsupported";
      item.title = badges.join("；");
      return item;
    }));
    const preferred = models.find((model) => model.id === preferredModel && model.capabilities.toolCalling !== "unsupported");
    this.composerModel.value = preferred?.id ?? models.find((model) => model.capabilities.toolCalling === "supported")?.id ?? models.find((model) => model.capabilities.toolCalling === "unknown")?.id ?? "";
  }

  private updateComposerControls(): void {
    const active = Boolean(this.threadTitle.dataset.active);
    this.composerProvider.disabled = this.modelSelectorBusy || !active || this.composerProvider.options.length === 0;
    this.composerModel.disabled = this.modelSelectorBusy || !active || this.composerModel.options.length === 0;
    this.refreshModels.disabled = this.modelSelectorBusy || !active || this.composerProvider.options.length === 0;
  }

  private async dispatchAttachments(files: File[]): Promise<void> {
    if (!files.length) return;
    const selection = selectSupportedImages(files, Math.max(0, MAX_MESSAGE_IMAGE_BYTES - this.attachmentBytes));
    if (selection.rejected.length) this.toast(selection.rejected.map(({ file, reason }) => `${file.name}：${reason}`).join("；"));
    if (!selection.accepted.length || !this.attachmentHandler) return;
    try { await this.attachmentHandler(selection.accepted); }
    catch (error) { this.toast(error instanceof Error ? error.message : String(error)); }
  }

  private toggleWorkspacePanel(panel: HTMLElement, trigger: HTMLButtonElement): void {
    const willOpen = panel.hidden;
    this.closeWorkspacePanel(this.fileTreePanel, this.filePanelTrigger);
    this.closeWorkspacePanel(this.runCenterPanel, this.runPanelTrigger);
    panel.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) panel.querySelector<HTMLElement>("input, button")?.focus();
  }

  private closeWorkspacePanel(panel: HTMLElement, trigger: HTMLButtonElement): void {
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }

  private renderFilteredFileTree(): void {
    const query = this.fileSearch.value;
    const entries = visibleFileTreeItems(this.fileEntries, query);
    this.fileTree.replaceChildren();
    if (!entries.length) { this.fileTree.append(element("div", "panel-empty", query ? "没有匹配的文件。" : "选择项目后显示文件。")); return; }
    for (const entry of entries) {
      const row = element("div", `file-tree-row${entry.changed ? " changed" : ""}`);
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(Math.max(1, entry.path.split("/").filter(Boolean).length)));
      const open = element("button", "file-open") as HTMLButtonElement;
      open.type = "button";
      open.disabled = entry.kind === "directory" || !this.fileTreeActions.open;
      open.style.setProperty("--depth", String(Math.max(0, entry.path.split("/").filter(Boolean).length - 1)));
      open.append(
        element("span", "file-kind", entry.kind === "directory" ? "▸" : "·"),
        element("span", "file-path", entry.path.replace(/^\//, "")),
        entry.size === undefined || entry.kind === "directory" ? element("span") : element("span", "file-size", formatBytes(entry.size))
      );
      open.addEventListener("click", () => this.runUiAction(() => this.fileTreeActions.open?.(entry.path)));
      row.append(open);
      if (entry.changed) {
        const diff = element("button", "file-diff", "Diff") as HTMLButtonElement;
        diff.type = "button";
        diff.disabled = !this.fileTreeActions.viewDiff;
        diff.setAttribute("aria-label", `查看 ${entry.path} 的 Diff`);
        diff.addEventListener("click", () => this.runUiAction(() => this.fileTreeActions.viewDiff?.(entry.path)));
        row.append(diff);
        const restore = element("button", "file-diff", "恢复") as HTMLButtonElement;
        restore.type = "button";
        restore.disabled = !this.fileTreeActions.restore;
        restore.setAttribute("aria-label", `恢复 ${entry.path} 的最近一次变更`);
        restore.addEventListener("click", () => this.runUiAction(() => this.fileTreeActions.restore?.(entry.path)));
        row.append(restore);
      }
      this.fileTree.append(row);
    }
  }

  private async runUiAction(action: () => void | Promise<void> | undefined): Promise<void> {
    try { await action(); }
    catch (error) { this.toast(error instanceof Error ? error.message : String(error)); }
  }

  renderSkillGroups(skills: SkillSummary[], actions: SkillActions = {}): void {
    this.renderSkillList(this.systemSkillList, skills.filter((skill) => skill.source === "builtin"), "尚无系统 Skill", actions);
    this.renderSkillList(this.userSkillList, skills.filter((skill) => skill.source === "user" || skill.source === "generated" || skill.source === "organization"), "尚未添加用户 Skill", actions);
    this.renderSkillList(this.projectSkillList, skills.filter((skill) => skill.source === "project"), "当前项目尚无 Skill", actions);
  }

  renderMcpServers(servers: McpServerRecord[], actions: McpServerActions = {}): void {
    this.mcpServerList.replaceChildren();
    for (const server of servers) {
      const item = element("article", "mcp-server-item");
      const heading = element("header");
      heading.append(
        element("strong", "", server.name),
        element("span", `skill-state ${server.enabled ? "enabled" : "disabled"}`, server.enabled ? "已启用" : "已禁用")
      );
      item.append(heading, element("code", "mcp-server-url", server.url));
      const status = server.lastError
        ? `测试失败：${server.lastError}`
        : server.lastTestedAt
          ? `连接正常 · ${server.lastToolCount ?? 0} 个工具 · ${formatLogTimestamp(server.lastTestedAt)}`
          : "尚未测试";
      item.append(element("span", `mcp-server-status${server.lastError ? " error" : ""}`, status));
      const buttons = element("div", "item-actions");
      appendActionButton(buttons, "测试连接", Boolean(actions.test), () => this.runUiAction(() => actions.test?.(server.id)));
      appendActionButton(buttons, server.enabled ? "禁用" : "启用", Boolean(actions.setEnabled), () => this.runUiAction(() => actions.setEnabled?.(server.id, !server.enabled)));
      appendActionButton(buttons, "移除", Boolean(actions.remove), () => this.runUiAction(() => actions.remove?.(server.id)));
      item.append(buttons);
      this.mcpServerList.append(item);
    }
    if (!servers.length) this.mcpServerList.append(element("div", "sidebar-empty", "尚未配置 MCP Server"));
  }

  private renderSkillList(host: HTMLElement, skills: SkillSummary[], emptyText: string, actions: SkillActions): void {
    host.replaceChildren();
    for (const skill of skills) {
      const reference = skill.key ?? skill.id;
      const item = element("div", "skill-item");
      const heading = element("div", "skill-heading");
      heading.append(element("strong", "", `${skill.name}${skill.version ? ` · v${skill.version}` : ""}`), element("span", `skill-state ${skill.enabled === false ? "disabled" : "enabled"}`, skill.enabled === false ? "已禁用" : "已启用"));
      item.append(heading, element("span", "skill-description", skill.description));
      const permissions = element("div", "skill-permissions");
      for (const permission of skill.permissions ?? []) permissions.append(element("span", "", skillPermissionLabel(permission)));
      if (!skill.permissions?.length) permissions.append(element("span", "safe", "无需额外权限"));
      item.append(permissions);
      if (skill.source === "project") item.append(element("div", "skill-source-note", "来源：当前项目 .browser-agent/skills"));
      const buttons = element("div", "item-actions");
      appendActionButton(buttons, "查看", Boolean(actions.inspect), () => this.runUiAction(() => actions.inspect?.(reference)));
      appendActionButton(buttons, skill.enabled === false ? "启用" : "禁用", Boolean(actions.setEnabled), () => this.runUiAction(() => actions.setEnabled?.(reference, skill.enabled === false)));
      if (skill.source !== "builtin" && skill.source !== "project") appendActionButton(buttons, "卸载", Boolean(actions.uninstall), () => this.runUiAction(() => actions.uninstall?.(reference)));
      item.append(buttons);
      host.append(item);
    }
    if (!skills.length) host.append(element("div", "sidebar-empty", emptyText));
  }

  renderLogs(records: AppLogRecord[]): void {
    this.logList.replaceChildren();
    if (!records.length) {
      this.logList.append(element("div", "log-empty", "尚无诊断日志"));
      return;
    }
    for (const record of records) {
      const item = element("article", `log-entry level-${record.level}`);
      const heading = element("header");
      heading.append(
        element("time", "", formatLogTimestamp(record.timestamp)),
        element("span", "log-level", record.level.toUpperCase()),
        element("code", "log-scope", record.scope)
      );
      const message = element("div", "log-message", record.message);
      item.append(heading, message);
      const details = formatLogDetails(record);
      if (details) item.append(element("pre", "log-details", details));
      this.logList.append(item);
    }
  }

  toast(message: string): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastElement.textContent = message;
    this.toastElement.hidden = false;
    this.toastTimer = setTimeout(() => { this.toastElement.hidden = true; }, 4500);
  }

  resizeComposer(): void { this.intent.style.height = "auto"; this.intent.style.height = `${Math.min(this.intent.scrollHeight, 150)}px`; }
  scrollToBottom(): void { requestAnimationFrame(() => { this.chatScroll.scrollTop = this.chatScroll.scrollHeight; }); }
}

function required<T extends Element>(selector: string): T { const value = document.querySelector<T>(selector); if (!value) throw new Error(`UI 缺少元素：${selector}`); return value; }
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; }
function option(value: string, label: string): HTMLOptionElement { const item = document.createElement("option"); item.value = value; item.textContent = label; return item; }
function appendActionButton(host: HTMLElement, label: string, enabled: boolean, action: () => void): void { const button = element("button", "", label) as HTMLButtonElement; button.type = "button"; button.disabled = !enabled; button.addEventListener("click", action); host.append(button); }
function metric(label: string, value: string): HTMLElement { const item = element("span"); item.append(element("small", "", label), element("strong", "", value)); return item; }
function eventTitle(message: MessageRecord): string { if (message.kind === "terminal") return t("终端记录"); if (message.kind === "error") return t("执行错误"); return typeof message.metadata?.toolName === "string" ? message.metadata.toolName : t("Agent 工具"); }
function formatTime(value: string): string { try { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); } catch { return ""; } }
function formatLogTimestamp(value: string): string { try { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false }).format(new Date(value)); } catch { return value; } }
function formatLogDetails(record: AppLogRecord): string {
  const sections: string[] = [];
  if (record.context) sections.push(JSON.stringify(record.context, null, 2));
  if (record.errorMessage) sections.push(`${record.errorName ?? "Error"}: ${record.errorMessage}`);
  if (record.stack) sections.push(record.stack);
  return sections.join("\n");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}m`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return value.toLocaleString("zh-CN");
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.max(0, Math.round(value))} ms`;
  if (value < 60_000) return `${Number((value / 1_000).toFixed(1))} 秒`;
  return `${Math.floor(value / 60_000)}分 ${Math.round(value % 60_000 / 1_000)}秒`;
}

function formatShortDate(value: string): string {
  try { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
  catch { return value; }
}

function runStatusLabel(status: RunCenterItem["status"]): string {
  return { running: "运行中", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" }[status];
}

function changeSetStatusLabel(status: ChangeSetListItem["status"]): string {
  return { active: "记录中", paused: "已暂停", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断", restored: "已恢复" }[status];
}

function skillPermissionLabel(permission: NonNullable<SkillSummary["permissions"]>[number]): string {
  return { "workspace-read": "读取项目", "workspace-write": "写入项目", network: "访问网络", "runtime-execute": "执行脚本" }[permission];
}

function isInternalBrowserAgentPath(path: string): boolean { return /^\/?\.browser-agent(?:\/|$)/i.test(path); }

function capabilityLabel(label: string, state: "supported" | "unsupported" | "unknown"): string {
  return state === "supported" ? `${label}✓` : state === "unsupported" ? `${label}×` : `${label}?`;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function parseArgumentsFromCall(content: string, toolName: string): Record<string, unknown> | undefined {
  const serialized = content.startsWith(toolName) ? content.slice(toolName.length).trim() : content.trim();
  if (!serialized) return undefined;
  try { const parsed = JSON.parse(serialized) as unknown; return isRecord(parsed) ? parsed : undefined; }
  catch { return undefined; }
}

function toolCommand(toolName: string, args: Record<string, unknown> | undefined, fallback: string): string {
  if (toolName === "shell.exec" && typeof args?.command === "string") return args.command;
  if (toolName === "workspace.move" && typeof args?.from === "string" && typeof args.to === "string") return `${toolName} ${args.from} → ${args.to}`;
  const primary = ["path", "url", "query", "id", "script"].map((key) => args?.[key]).find((value): value is string => typeof value === "string" && Boolean(value));
  if (primary) return `${toolName} ${primary}`;
  const normalized = fallback.startsWith(toolName) ? fallback.slice(toolName.length).trim() : "";
  return normalized && normalized.length <= 160 ? `${toolName} ${normalized}` : toolName;
}

function formatToolValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value) as unknown, null, 2); }
    catch { return value; }
  }
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}
