import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop, buildSystemPrompt, createCoreToolRegistry, validateNetworkUrl } from "../packages/agent-kernel/src/index";
import { AgentToolRegistry } from "../packages/command-core/src/index";
import { workspacePath } from "../packages/contracts/src/index";
import { MockModelProvider, type ModelProvider, type ModelTurnRequest, type ModelTurnResponse } from "../packages/model-adapters/src/index";
import type { ScriptExecutionRequest, ScriptRuntimeProvider } from "../packages/runtime-contracts/src/index";
import { SkillRegistry } from "../packages/skill-core/src/index";
import { BROWSER_AGENT_LOG_DIRECTORY, BROWSER_AGENT_RUNS_DIRECTORY, browserAgentRunScratchDirectory, ChangeSetConflictError, isBrowserAgentInternalPath, isWorkspaceInternalMetadataPath, normalizeAgentWorkspacePath, ProjectFileService, WorkspaceConflictError, type BrowserDirectoryHandle, type BrowserFileHandle, type ChangeJournal, type ChangeSet, type ChangeSetChange, type ChangeSetStatus, type ProjectFileBackup, type ProjectFileChange } from "../packages/workspace-contracts/src/index";

test("虚拟路径拒绝遍历与 Windows 路径", () => { assert.throws(() => workspacePath("/../secret")); assert.throws(() => workspacePath("C:/secret")); assert.throws(() => workspacePath("/%2e%2e/secret")); });

test("网络防火墙阻止本机、私网、云元数据和高熵查询参数", () => {
  for (const url of ["http://localhost/x", "http://127.0.0.1/x", "http://10.0.0.2/x", "http://169.254.169.254/latest/meta-data", "http://100.100.100.200/latest/meta-data", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://metadata.google.internal/computeMetadata/v1/", "file:///etc/passwd"]) assert.throws(() => validateNetworkUrl(url));
  assert.throws(() => validateNetworkUrl(`https://example.com/?payload=${"Ab3dEf5hIj7Lm9NoPqRsTuVwXyZ0".repeat(3)}`));
  assert.equal(validateNetworkUrl("https://example.com/report?id=42").hostname, "example.com");
});

test("Agent 工具路径将逻辑 /workspace 根映射为项目根", () => {
  assert.equal(normalizeAgentWorkspacePath("/workspace/report.js"), "/report.js");
  assert.equal(normalizeAgentWorkspacePath("/workspace"), "/");
  assert.equal(normalizeAgentWorkspacePath("/workspace-data/report.js"), "/workspace-data/report.js");
  assert.throws(() => normalizeAgentWorkspacePath("/workspace/../secret.txt"));
});

test("核心工具规范化 /workspace 路径并可直接执行 JavaScript", async () => {
  const root = new MemoryDirectory("project");
  const workspace = new ProjectFileService("project", root, noJournal);
  const requests: ScriptExecutionRequest[] = [];
  const runtime = {
    id: "test-runtime",
    available: async () => true,
    start: async () => ({ id: "session" }),
    execute: async (_session: unknown, request: ScriptExecutionRequest) => { requests.push(request); return { exitCode: 0, stdout: "ok", stderr: "" }; }
  } as unknown as ScriptRuntimeProvider;
  const tools = createCoreToolRegistry({ workspace, runtime, skills: new SkillRegistry(), conversation: () => [] });
  assert.equal(tools.list().some((tool) => tool.id.startsWith("git.")), false);
  const written = await tools.execute("workspace.write", { path: "/workspace/report.txt", content: "完成" }) as { path: string };
  assert.equal(written.path, "/report.txt");
  assert.equal((await workspace.readText("/report.txt")).content, "完成");
  await tools.execute("javascript.exec", { source: "console.log('ok')" });
  assert.equal(requests[0]?.kind, "javascript");
  assert.equal(requests[0]?.workingDirectory, "/workspace");
});

test("ProjectFileService 直接写入、移动、删除真实目录", async () => {
  const root = new MemoryDirectory("project");
  root.externalWrite("notes.txt", "旧内容");
  const service = new ProjectFileService("project", root, noJournal);
  await service.captureBaseline();
  const read = await service.readText("/notes.txt");
  await service.writeText("/notes.txt", "新内容", { expectedFingerprint: read.fingerprint });
  assert.equal((await service.readText("/notes.txt")).content, "新内容");
  await service.move("/notes.txt", "/src/notes.txt");
  assert.equal((await service.readText("/src/notes.txt")).content, "新内容");
  await service.delete("/src/notes.txt");
  assert.equal(await service.exists("/src/notes.txt"), false);
});

test("项目级 Browser Agent 目录可初始化且安装包缓存不写恢复备份", async () => {
  const root = new MemoryDirectory("project");
  const backups: string[] = [];
  const journal: ChangeJournal = { backup: async (projectId, path, operation, data) => { backups.push(path); return { id: crypto.randomUUID(), projectId, path, operation, createdAt: new Date().toISOString(), bytes: data?.byteLength ?? 0 }; } };
  const service = new ProjectFileService("project", root, journal);
  assert.equal(await service.ensureDirectory("/.browser-agent/state"), true);
  assert.equal(await service.ensureDirectory("/.browser-agent/packages"), true);
  assert.equal(await service.ensureDirectory("/.browser-agent/packages/installed"), true);
  assert.equal(await service.ensureDirectory("/.browser-agent/packages"), false);
  await service.writeText("/.browser-agent/packages/npm-cache/archive.tgz", "cache", { source: "terminal" });
  assert.equal(await service.exists("/.browser-agent/state"), true);
  assert.equal(await service.exists("/.browser-agent/packages/npm-cache/archive.tgz"), true);
  await service.writeText("/.browser-agent/packages/installed/node-modules.snapshot", "snapshot", { source: "terminal" });
  await service.writeText(`${BROWSER_AGENT_LOG_DIRECTORY}/2026-07-20.1.jsonl`, "{}\n", { source: "agent" });
  assert.equal(await service.exists("/.browser-agent/packages/installed/node-modules.snapshot"), true);
  assert.equal(isBrowserAgentInternalPath("/.browser-agent/logs/a.jsonl"), true);
  assert.equal(isBrowserAgentInternalPath("/src/.browser-agent.txt"), false);
  assert.equal(BROWSER_AGENT_RUNS_DIRECTORY, "/.browser-agent/state/runs");
  assert.equal(browserAgentRunScratchDirectory("run-1"), "/.browser-agent/state/runs/run-1/scratch");
  assert.throws(() => browserAgentRunScratchDirectory("../escape"));
  assert.deepEqual(backups, []);
});

test("读取后发生外部修改时拒绝静默覆盖", async () => {
  const root = new MemoryDirectory("project");
  root.externalWrite("a.txt", "v1");
  const service = new ProjectFileService("project", root, noJournal);
  const first = await service.readText("/a.txt");
  root.externalWrite("a.txt", "v2");
  await assert.rejects(() => service.writeText("/a.txt", "agent", { expectedFingerprint: first.fingerprint }), WorkspaceConflictError);
  assert.equal((await service.readText("/a.txt")).content, "v2");
});

test("运行级 ChangeSet 记录四类修改并可按逆序恢复整次运行", async () => {
  const root = new MemoryDirectory("project");
  root.externalWrite("modify.txt", "old-modify");
  root.externalWrite("delete.txt", "old-delete");
  root.externalWrite("move.txt", "old-move");
  root.externalWrite("target.txt", "old-target");
  const journal = new MemoryRunJournal();
  const service = new ProjectFileService("project", root, journal);
  await service.beginRun("run-restore");
  await service.writeText("/create.txt", "new-create");
  await service.writeText("/modify.txt", "new-modify");
  await service.delete("/delete.txt");
  await service.move("/move.txt", "/target.txt");
  await service.writeText("/.browser-agent/logs/ignored.jsonl", "{}\n");
  const completed = await service.endRun();

  assert.equal(completed?.status, "completed");
  assert.deepEqual(completed?.changes.map((change) => change.type), ["create", "modify", "delete", "move"]);
  assert.equal(completed?.changes.some((change) => isBrowserAgentInternalPath(change.path)), false);
  assert.equal((await service.listChangeSets()).length, 1);
  const modified = completed?.changes.find((change) => change.type === "modify");
  assert.ok(modified);
  const preview = await service.previewChange("run-restore", modified.id);
  assert.equal(new TextDecoder().decode(preview.before), "old-modify");
  assert.equal(new TextDecoder().decode(preview.after), "new-modify");

  const restored = await service.restoreRun("run-restore");
  assert.equal(restored.status, "restored");
  assert.equal(await service.exists("/create.txt"), false);
  assert.equal((await service.readText("/modify.txt")).content, "old-modify");
  assert.equal((await service.readText("/delete.txt")).content, "old-delete");
  assert.equal((await service.readText("/move.txt")).content, "old-move");
  assert.equal((await service.readText("/target.txt")).content, "old-target");
});

test("ChangeSet 恢复检测运行后的外部修改并仅在 force 时覆盖", async () => {
  const root = new MemoryDirectory("project");
  root.externalWrite("a.txt", "v1");
  const service = new ProjectFileService("project", root, new MemoryRunJournal());
  service.setActiveRun("run-conflict");
  await service.writeText("/a.txt", "v2");
  await service.endRun();
  root.externalWrite("a.txt", "external");

  await assert.rejects(() => service.restoreRun("run-conflict"), ChangeSetConflictError);
  assert.equal((await service.readText("/a.txt")).content, "external");
  await service.restoreRun("run-conflict", { force: true });
  assert.equal((await service.readText("/a.txt")).content, "v1");
});

test("刷新重新连接项目时把遗留 active ChangeSet 标记为 interrupted", async () => {
  const root = new MemoryDirectory("root");
  const journal = new MemoryRunJournal();
  const service = new ProjectFileService("project", root, journal);
  await service.beginRun("stale-run");
  await service.writeText("/stale.txt", "pending");
  assert.equal(await service.interruptActiveChangeSets(), 1);
  assert.equal((await service.readChangeSet("stale-run"))?.status, "interrupted");
  assert.equal(await service.interruptActiveChangeSets(), 0);
});

test("版本控制元数据不出现在文件列表、ChangeSet、搜索或任务产物事件中", async () => {
  const root = new MemoryDirectory("project");
  const journal = new MemoryRunJournal();
  const events: ProjectFileChange[] = [];
  const service = new ProjectFileService("project", root, journal, (change) => { events.push(change); });
  await service.beginRun("run-git");
  await service.writeText("/.git/HEAD", "ref: refs/heads/main\n");
  const completed = await service.endRun();

  assert.equal((await service.readText("/.git/HEAD")).content, "ref: refs/heads/main\n");
  assert.deepEqual(await service.list("/"), []);
  assert.deepEqual(await service.search("refs/heads"), []);
  assert.deepEqual(completed?.changes, []);
  assert.deepEqual(events, []);
  assert.equal(isWorkspaceInternalMetadataPath("/.git/HEAD"), true);
  assert.equal(isWorkspaceInternalMetadataPath("/src/git.ts"), false);
});

test("AgentLoop 只执行模型显式请求的工具并继续下一轮", async () => {
  const tools = new AgentToolRegistry();
  let calls = 0;
  tools.register({ id: "workspace.list", description: "list", effect: "read", scope: "workspace", inputSchema: { type: "object" }, execute: async () => { calls += 1; return ["/a.txt"]; } });
  const model = new MockModelProvider([
    { text: "先查看目录", toolCalls: [{ id: "call-1", name: "workspace.list", arguments: {} }] },
    { text: "项目包含 a.txt。", toolCalls: [] }
  ]);
  const events: string[] = [];
  let toolStartArguments: unknown;
  const result = await new AgentLoop(model).run({ intent: "查看项目", workspaceId: "p1", tools }, (event) => { events.push(event.kind); if (event.kind === "tool-start") toolStartArguments = event.metadata?.arguments; });
  assert.equal(calls, 1);
  assert.equal(result.task.phase, "COMPLETED");
  assert.equal(result.reply, "项目包含 a.txt。");
  assert.ok(events.includes("tool-result"));
  assert.deepEqual(toolStartArguments, {});
  assert.ok(events.indexOf("tool-result") < events.indexOf("assistant-delta"));
  assert.ok(events.indexOf("assistant-delta") < events.indexOf("assistant"));
});

test("AgentLoop 对普通问候直接回答且不暴露项目工具", async () => {
  const tools = new AgentToolRegistry();
  let writes = 0;
  tools.register({ id: "presentation.create", description: "create pptx", effect: "write", scope: "workspace", inputSchema: { type: "object" }, execute: async () => { writes += 1; return { path: "/hello.pptx" }; } });
  const model = new RecordingModelProvider([{ text: "你好！有什么可以帮你？", toolCalls: [] }]);
  const result = await new AgentLoop(model).run({ intent: "你好", workspaceId: "p1", tools });
  assert.equal(result.task.phase, "COMPLETED");
  assert.equal(result.reply, "你好！有什么可以帮你？");
  assert.equal(writes, 0);
  assert.equal(model.requests.length, 1);
  assert.equal(model.requests[0]?.toolChoice, "none");
  assert.deepEqual(model.requests[0]?.tools, []);
});

test("AgentLoop 的只读任务不向模型暴露写入工具", async () => {
  const tools = new AgentToolRegistry();
  tools.register({ id: "workspace.read", description: "read", effect: "read", scope: "workspace", inputSchema: { type: "object" }, execute: async () => ({ content: "项目内容" }) });
  tools.register({ id: "presentation.create", description: "create pptx", effect: "write", scope: "workspace", inputSchema: { type: "object" }, execute: async () => ({ path: "/unexpected.pptx" }) });
  const model = new RecordingModelProvider([
    { text: "", toolCalls: [{ id: "read-1", name: "workspace.read", arguments: { path: "/README.md" } }] },
    { text: "项目内容已读取。", toolCalls: [] }
  ]);
  const result = await new AgentLoop(model).run({ intent: "查看项目", workspaceId: "p1", tools });
  assert.equal(result.task.phase, "COMPLETED");
  assert.deepEqual(model.requests[0]?.tools.map((tool) => tool.id), ["workspace.read"]);
});

test("AgentLoop 为生成 Office 产物的任务暴露写入工具", async () => {
  const tools = new AgentToolRegistry();
  tools.register({ id: "presentation.create", description: "create pptx", effect: "write", scope: "workspace", inputSchema: { type: "object" }, execute: async () => ({ path: "/briefing.pptx" }) });
  const model = new RecordingModelProvider([
    { text: "", toolCalls: [{ id: "create-1", name: "presentation.create", arguments: { path: "/briefing.pptx" } }] },
    { text: "已生成演示文稿。", toolCalls: [] }
  ]);
  const result = await new AgentLoop(model).run({ intent: "生成 PPT 产物", workspaceId: "p1", tools });
  assert.equal(result.task.phase, "COMPLETED");
  assert.deepEqual(model.requests[0]?.tools.map((tool) => tool.id), ["presentation.create"]);
});

test("AgentLoop 拒绝执行只读任务中被模型强行请求的隐藏写工具", async () => {
  const tools = new AgentToolRegistry();
  let writes = 0;
  tools.register({ id: "presentation.create", description: "create pptx", effect: "write", scope: "workspace", inputSchema: { type: "object" }, execute: async () => { writes += 1; return { path: "/unexpected.pptx" }; } });
  const model = new RecordingModelProvider([
    { text: "", toolCalls: [{ id: "hidden-1", name: "presentation.create", arguments: { path: "/unexpected.pptx" } }] },
    { text: "", toolCalls: [{ id: "hidden-2", name: "presentation.create", arguments: { path: "/unexpected.pptx" } }] }
  ]);
  const result = await new AgentLoop(model).run({ intent: "查看项目", workspaceId: "p1", tools });
  assert.equal(writes, 0);
  assert.equal(result.task.phase, "FAILED_RECOVERABLE");
  assert.match(result.reply, /当前任务不允许使用工具：presentation\.create/);
});

test("PDF 渲染工具只在模型支持图片时把 PNG 作为下一轮多模态输入", async () => {
  const tools = new AgentToolRegistry();
  tools.register({
    id: "pdf.render_page",
    description: "render",
    effect: "write",
    scope: "workspace",
    inputSchema: { type: "object" },
    execute: async () => ({ targetPath: "/page.png", modelContentParts: [{ type: "image", mimeType: "image/png", data: "cG5n" }] })
  });
  const requests: ModelTurnRequest[] = [];
  const provider: ModelProvider = {
    async runTurn(request) {
      requests.push(request);
      return requests.length === 1
        ? { text: "", toolCalls: [{ id: "render-1", name: "pdf.render_page", arguments: {} }] }
        : { text: "已完成视觉分析。", toolCalls: [] };
    }
  };
  const result = await new AgentLoop(provider).run({ intent: "查看 PDF 页面", workspaceId: "p1", tools, allowImageToolResults: true });
  assert.equal(result.task.phase, "COMPLETED");
  const secondMessages = requests[1]?.messages ?? [];
  const imageMessage = secondMessages.find((message) => message.role === "user" && Array.isArray(message.content));
  assert.ok(imageMessage && Array.isArray(imageMessage.content));
  assert.equal(imageMessage.content.some((part) => part.type === "image" && part.data === "cG5n"), true);
  const toolMessage = secondMessages.find((message) => message.role === "tool");
  assert.equal(typeof toolMessage?.content === "string" && toolMessage.content.includes("cG5n"), false);
});

test("AgentLoop 的 LangGraph 循环达到 maxTurns 后以可恢复失败停止", async () => {
  const tools = new AgentToolRegistry();
  tools.register({ id: "workspace.list", description: "list", effect: "read", scope: "workspace", inputSchema: { type: "object" }, execute: async () => [] });
  const model = new MockModelProvider([
    { text: "第一轮", toolCalls: [{ id: "call-1", name: "workspace.list", arguments: {} }] },
    { text: "第二轮", toolCalls: [{ id: "call-2", name: "workspace.list", arguments: {} }] }
  ]);
  const result = await new AgentLoop(model).run({ intent: "持续调用工具", workspaceId: "p1", tools, maxTurns: 2 });
  assert.equal(result.task.phase, "FAILED_RECOVERABLE");
  assert.match(result.reply, /超过 2 轮工具调用/);
});

test("系统提示明确注入特殊 jsh 环境和已安装 Skill", () => {
  const prompt = buildSystemPrompt({
    runtime: { id: "runtime.webcontainer", available: true, shell: "WebContainer jsh", workingDirectory: "/workspace", limitations: ["只保证 Node.js"] },
    skills: [{ id: "spreadsheet-analysis", name: "spreadsheet-analysis", description: "浏览器内处理表格", source: "builtin" }]
  });
  assert.match(prompt, /特殊的 WebContainer `jsh` Shell/);
  assert.match(prompt, /不是 Windows PowerShell、CMD、宿主 Linux Bash/);
  assert.match(prompt, /不要调用或探测 Python\/python3\/pip\/conda/);
  assert.match(prompt, /逻辑工作目录：\/workspace/);
  assert.match(prompt, /spreadsheet-analysis: 浏览器内处理表格/);
  assert.match(prompt, /环境快照只提供已安装 Skill 的路由摘要/);
  assert.match(prompt, /必须在调用该领域工具前主动使用 skill\.inspect/);
  assert.match(prompt, /不要要求用户选择模板/);
});

test("AgentLoop 连续两次工具失败后立即熔断而不是卡住", async () => {
  const tools = new AgentToolRegistry();
  let calls = 0;
  tools.register({ id: "shell.exec", description: "fail", effect: "execute", scope: "runtime", inputSchema: { type: "object" }, execute: async () => { calls += 1; throw new Error("特殊 Shell 不支持 Python"); } });
  const model = new MockModelProvider([
    { text: "尝试一", toolCalls: [{ id: "call-1", name: "shell.exec", arguments: { command: "python a.py" } }] },
    { text: "尝试二", toolCalls: [{ id: "call-2", name: "shell.exec", arguments: { command: "python3 a.py" } }] }
  ]);
  const result = await new AgentLoop(model).run({ intent: "处理文件", workspaceId: "p1", tools });
  assert.equal(calls, 2);
  assert.equal(result.task.phase, "FAILED_RECOVERABLE");
  assert.match(result.reply, /工具连续失败 2 次/);
  assert.match(result.reply, /避免重复报错后卡住/);
  assert.match(result.reply, /失败工具：shell\.exec（callId=call-2）/);
});

test("AgentLoop 阻止模型在未调用工具时幻觉式完成", async () => {
  const tools = new AgentToolRegistry();
  tools.register({ id: "workspace.list", description: "list", effect: "read", scope: "workspace", inputSchema: { type: "object" }, execute: async () => [] });
  const model = new RecordingModelProvider([
    { text: "我已经检查完项目，一切正常。", toolCalls: [] },
    { text: "任务已完成。", toolCalls: [] }
  ]);
  const assistantMessages: string[] = [];
  const result = await new AgentLoop(model).run({ intent: "检查项目", workspaceId: "p1", tools }, (event) => { if (event.kind === "assistant") assistantMessages.push(event.content); });
  assert.equal(result.task.phase, "FAILED_RECOVERABLE");
  assert.match(result.reply, /缺少工具证据|幻觉式完成/);
  assert.deepEqual(model.requests.map((request) => request.toolChoice), ["required", "required"]);
  assert.equal(assistantMessages.some((message) => message.includes("一切正常")), false);
});

test("修改类任务必须取得真实项目写入证据后才能完成", async () => {
  const tools = new AgentToolRegistry();
  let writes = 0;
  tools.register({ id: "workspace.read", description: "read", effect: "read", scope: "workspace", inputSchema: { type: "object" }, execute: async () => ({ content: "旧代码" }) });
  tools.register({ id: "workspace.write", description: "write", effect: "write", scope: "workspace", inputSchema: { type: "object" }, execute: async () => { writes += 1; return { path: "/app.ts" }; } });
  const model = new RecordingModelProvider([
    { text: "", toolCalls: [{ id: "read-1", name: "workspace.read", arguments: { path: "/app.ts" } }] },
    { text: "已修复代码。", toolCalls: [] },
    { text: "", toolCalls: [{ id: "write-1", name: "workspace.write", arguments: { path: "/app.ts", content: "新代码" } }] },
    { text: "代码已成功修复并写入项目。", toolCalls: [] }
  ]);
  const shown: string[] = [];
  const result = await new AgentLoop(model).run({ intent: "直接帮我修改代码", workspaceId: "p1", tools }, (event) => { if (event.kind === "assistant") shown.push(event.content); });
  assert.equal(result.task.phase, "COMPLETED");
  assert.equal(writes, 1);
  assert.equal(shown.some((message) => message === "已修复代码。"), false);
  assert.equal(result.reply, "代码已成功修复并写入项目。");
  assert.deepEqual(model.requests.map((request) => request.toolChoice), ["required", "required", "required", "auto"]);
  assert.ok(result.task.observations.some((item) => item.includes("workspace/write")));
});

class RecordingModelProvider implements ModelProvider {
  readonly requests: ModelTurnRequest[] = [];
  constructor(private readonly turns: ModelTurnResponse[]) {}
  async runTurn(request: ModelTurnRequest): Promise<ModelTurnResponse> {
    this.requests.push(request);
    return this.turns.shift() ?? { text: "", toolCalls: [] };
  }
}

const noJournal: ChangeJournal = { backup: async (projectId, path, operation, data) => ({ id: crypto.randomUUID(), projectId, path, operation, createdAt: new Date().toISOString(), bytes: data?.byteLength ?? 0 }) };

class MemoryRunJournal implements ChangeJournal {
  private readonly backups = new Map<string, Uint8Array>();
  private readonly changeSets = new Map<string, ChangeSet>();

  async backup(projectId: string, path: string, operation: ProjectFileChange["type"], data = new Uint8Array()): Promise<ProjectFileBackup> {
    const record = { id: crypto.randomUUID(), projectId, path, operation, createdAt: new Date().toISOString(), bytes: data.byteLength };
    this.backups.set(record.id, data.slice());
    return record;
  }
  async beginRun(projectId: string, runId: string): Promise<ChangeSet> {
    const existing = this.changeSets.get(runId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const changeSet: ChangeSet = { id: crypto.randomUUID(), projectId, runId, status: "active", changes: [], createdAt: now, updatedAt: now };
    this.changeSets.set(runId, changeSet);
    return changeSet;
  }
  async appendChange(projectId: string, runId: string, change: ChangeSetChange): Promise<void> {
    const changeSet = await this.beginRun(projectId, runId);
    changeSet.changes.push(change);
    changeSet.updatedAt = new Date().toISOString();
  }
  async endRun(projectId: string, runId: string, status: Exclude<ChangeSetStatus, "active">): Promise<ChangeSet> {
    const changeSet = await this.beginRun(projectId, runId);
    changeSet.status = status;
    changeSet.updatedAt = new Date().toISOString();
    return changeSet;
  }
  async list(): Promise<ChangeSet[]> { return [...this.changeSets.values()]; }
  async read(_projectId: string, runId: string): Promise<ChangeSet | undefined> { return this.changeSets.get(runId); }
  async readBackup(_projectId: string, backupRef: string): Promise<Uint8Array> {
    const data = this.backups.get(backupRef);
    if (!data) throw new Error("missing backup");
    return data.slice();
  }
}

class MemoryFileHandle implements BrowserFileHandle {
  readonly kind = "file" as const;
  constructor(readonly name: string, private readonly parent: MemoryDirectory) {}
  async getFile(): Promise<File> { const value = this.parent.file(this.name); const bytes = value.data.buffer.slice(value.data.byteOffset, value.data.byteOffset + value.data.byteLength) as ArrayBuffer; return new File([bytes], this.name, { lastModified: value.modified }); }
  async createWritable(): Promise<{ write(data: Uint8Array | string): Promise<void>; close(): Promise<void> }> {
    let next = new Uint8Array();
    return { write: async (data) => { next = typeof data === "string" ? new TextEncoder().encode(data) : data.slice(); }, close: async () => { this.parent.setFile(this.name, next); } };
  }
}

class MemoryDirectory implements BrowserDirectoryHandle {
  readonly kind = "directory" as const;
  private readonly entries = new Map<string, MemoryDirectory | { data: Uint8Array; modified: number }>();
  private clock = 1;
  constructor(readonly name: string) {}
  async *values(): AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle> { for (const [name, value] of this.entries) yield value instanceof MemoryDirectory ? value : new MemoryFileHandle(name, this); }
  async getFileHandle(name: string, options?: { create?: boolean }): Promise<BrowserFileHandle> { if (!this.entries.has(name)) { if (!options?.create) throw new DOMException("missing", "NotFoundError"); this.setFile(name, new Uint8Array()); } const value = this.entries.get(name); if (value instanceof MemoryDirectory) throw new DOMException("directory", "TypeMismatchError"); return new MemoryFileHandle(name, this); }
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<BrowserDirectoryHandle> { const current = this.entries.get(name); if (current instanceof MemoryDirectory) return current; if (current) throw new DOMException("file", "TypeMismatchError"); if (!options?.create) throw new DOMException("missing", "NotFoundError"); const directory = new MemoryDirectory(name); this.entries.set(name, directory); return directory; }
  async removeEntry(name: string): Promise<void> { if (!this.entries.delete(name)) throw new DOMException("missing", "NotFoundError"); }
  externalWrite(path: string, content: string): void { const [name, ...rest] = path.split("/"); if (!name) return; if (!rest.length) { this.setFile(name, new TextEncoder().encode(content)); return; } let directory = this.entries.get(name); if (!(directory instanceof MemoryDirectory)) { directory = new MemoryDirectory(name); this.entries.set(name, directory); } directory.externalWrite(rest.join("/"), content); }
  file(name: string): { data: Uint8Array; modified: number } { const value = this.entries.get(name); if (!value || value instanceof MemoryDirectory) throw new DOMException("missing", "NotFoundError"); return value; }
  setFile(name: string, data: Uint8Array): void { this.entries.set(name, { data: data.slice(), modified: ++this.clock }); }
}
