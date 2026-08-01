import { expect, test, type Page } from "@playwright/test";
import { APP_VERSION } from "../../packages/version";

const MOCK_GATEWAY = "http://127.0.0.1:4173/mock-gateway";
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const capturedGatewayCalls = new WeakMap<Page, GatewayCall[]>();

test.beforeEach(async ({ page }) => {
  capturedGatewayCalls.set(page, []);
  await page.route("https://models.dev/api.json", (route) => route.fulfill({ json: {}, headers: { etag: '"e2e"' } }));
  await page.route("**/v1/models", (route) => route.fulfill({
    json: {
      data: [
        { id: "mock-a", name: "Mock A", tool_call: true, input_modalities: ["text", "image"], context_window: 64_000 },
        { id: "mock-b", name: "Mock B", tool_call: true, input_modalities: ["text", "image"], context_window: 128_000 }
      ]
    }
  }));
  await page.route("**/v1/agent/turn", async (route) => {
    const call = route.request().postDataJSON() as GatewayCall;
    capturedGatewayCalls.get(page)?.push(call);
    const intent = userIntent(call.messages);
    if (intent.includes("[E2E:SLOW]")) {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      try { await route.fulfill(sseResponse({ text: "慢任务完成。", toolCalls: [] })); } catch { /* 请求被停止或页面刷新。 */ }
      return;
    }
    const toolResults = call.messages.filter((message) => message.role === "tool").length;
    await route.fulfill(sseResponse(chooseTurn(intent, toolResults)));
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("browser-agent-e2e", { create: true });
      }
    });

    if (localStorage.getItem("browser-agent-e2e:permission-api") === "true") {
      const prototype = FileSystemDirectoryHandle.prototype as FileSystemDirectoryHandle & {
        queryPermission?: () => Promise<PermissionState>;
        requestPermission?: () => Promise<PermissionState>;
      };
      Object.defineProperty(prototype, "queryPermission", {
        configurable: true,
        value: async () => (localStorage.getItem("browser-agent-e2e:permission") ?? "prompt") as PermissionState
      });
      Object.defineProperty(prototype, "requestPermission", {
        configurable: true,
        value: async () => {
          localStorage.setItem("browser-agent-e2e:permission", "granted");
          return "granted" as PermissionState;
        }
      });
    }
  });
  await page.goto("/");
  await configureGateway(page);
  await createProject(page);
});

test("模型切换、图片发送与成功运行自动折叠", async ({ page }) => {
  await expect(page.locator("#composer-model option[value='mock-b']")).toHaveCount(1);
  await page.locator("#composer-model").selectOption("mock-b");
  await expect(page.locator("#active-model")).toContainText("mock-b");

  await page.locator("#attachment-input").setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG_1X1 });
  await expect(page.locator(".attachment-item")).toContainText("pixel.png");
  await runIntent(page, "[E2E:READ] 请查看项目并分析这张图片。", "检查完成");

  const toolRun = page.locator(".tool-run").last();
  await expect(toolRun).toHaveAttribute("data-status", "completed");
  await expect(toolRun.locator(".tool-run-card")).not.toHaveAttribute("open", "");

  const calls = gatewayRequests(page);
  expect(calls.at(-2)?.modelId).toBe("mock-b");
  const user = [...(calls.at(-2)?.messages ?? [])].reverse().find((message: ModelMessage) => message.role === "user");
  if (!user || !Array.isArray(user.content)) throw new Error("Mock Gateway 未收到多模态用户消息。");
  expect(user.content.some((part) => part.type === "image" && part.mimeType === "image/png")).toBe(true);
});

test("插件入口管理系统、用户、项目 Skills 与 MCP 配置", async ({ page }) => {
  await expect(page.locator("#new-project")).toContainText("新建项目");
  await page.locator("#settings-trigger").click();
  await expect(page.locator("#settings-dialog h2", { hasText: "Skills" })).toHaveCount(0);
  await page.locator("#settings-dialog button[aria-label='关闭']").click();

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const project = await root.getDirectoryHandle("browser-agent-e2e");
    const home = await project.getDirectoryHandle(".browser-agent", { create: true });
    const skills = await home.getDirectoryHandle("skills", { create: true });
    const folder = await skills.getDirectoryHandle("project-e2e", { create: true });
    const handle = await folder.getFileHandle("SKILL.md", { create: true });
    const writer = await handle.createWritable();
    await writer.write("---\nname: project-e2e\ndescription: 项目 E2E Skill\n---\n# Project E2E\n");
    await writer.close();
  });

  await page.locator("#plugins-trigger").click();
  await expect(page.locator("#system-skill-list .skill-item").first()).toBeVisible();
  await expect(page.locator("#user-skill-list")).toContainText("尚未添加用户 Skill");
  await page.locator("#refresh-project-skills").click();
  await expect(page.locator("#project-skill-list")).toContainText("project-e2e");
  await expect(page.locator("#project-skill-list")).toContainText("项目 E2E Skill");

  await page.locator("#mcp-name").fill("E2E MCP");
  await page.locator("#mcp-url").fill("https://mcp.example.test/mcp");
  await page.locator("#add-mcp-server").click();
  await expect(page.locator("#mcp-server-list")).toContainText("E2E MCP");
  await expect(page.locator("#mcp-server-list")).toContainText("尚未测试");
});

test("窄屏聊天区不被连接状态撑宽且设置显示版本", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => {
    const selectors = [".chat-header", ".chat-scroll", "#message-feed", ".composer", ".terminal-pane"];
    return selectors.every((selector) => (document.querySelector(selector)?.getBoundingClientRect().right ?? Infinity) <= innerWidth + 0.5);
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.locator("#settings-trigger").click();
  await expect(page.locator("#app-version")).toHaveText(`v${APP_VERSION}`);
});

test("重复失败运行暂停并保持展开，停止运行记录为 cancelled", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#intent").fill("[E2E:FAIL] 触发可重复的工具失败。");
  await page.locator("#send").click();
  const pausedRun = page.locator(".tool-run").last();
  await expect(pausedRun).toHaveAttribute("data-status", "paused");
  await expect(pausedRun.locator(".tool-run-card")).toHaveAttribute("open", "");

  await page.locator("#intent").fill("[E2E:SLOW] 保持运行直到用户停止。");
  await page.locator("#send").click();
  await expect(page.locator("#stop-run")).toBeVisible();
  await expect(page.locator("#send")).toBeVisible();
  await expect(page.locator("#composer-send-mode")).toBeVisible();
  await expect(page.locator("#send")).toHaveAttribute("aria-label", "排队发送");
  await page.locator("#stop-run").click();
  await expect(page.locator(".message.error").last()).toContainText("用户停止");
  await page.locator("#run-panel-trigger").click();
  await expect(page.locator("#run-list .run-item").first()).toContainText("已取消");
});

test("目录权限恢复、写入确认、Diff 与整次回滚", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("browser-agent-e2e:permission-api", "true");
    localStorage.setItem("browser-agent-e2e:permission", "prompt");
  });
  await page.reload();
  await expect(page.locator("#connection-status")).toContainText("需要恢复权限");
  await page.locator("#connection-action").click();
  await expect(page.locator("#connection-status")).toContainText("已连接");
  await page.locator("#settings-trigger").click();
  await page.locator("#permission-mode").selectOption("confirmWrites");
  await page.locator("#settings-dialog button[aria-label='关闭']").click();

  const authorizationMessages: string[] = [];
  page.on("dialog", async (dialog) => {
    authorizationMessages.push(dialog.message());
    if (dialog.message().includes("后续所有写入")) await dialog.dismiss();
    else await dialog.accept();
  });
  await runIntent(page, "[E2E:WRITE] 创建 report.txt。", "已根据工具结果创建文件");
  expect(authorizationMessages.some((message) => message.includes("workspace.write"))).toBe(true);
  expect(await readWorkspaceFile(page, "report.txt")).toBe("Browser Agent E2E\n");

  await page.locator("#run-panel-trigger").click();
  const run = page.locator("#run-list .run-item").first();
  await expect(run).toContainText("report.txt");
  await run.getByRole("button", { name: "查看 Diff" }).click();
  await expect(page.locator("#diff-content")).toContainText("Browser Agent E2E");
  await page.locator("#diff-close").click();
  await page.locator("#run-panel-trigger").click();
  await page.locator("#run-list .run-item").first().getByRole("button", { name: "恢复", exact: true }).click();
  await expect.poll(() => workspaceFileExists(page, "report.txt")).toBe(false);
  await expect(page.locator("#changeset-list")).toContainText("已恢复");
});

test("刷新把遗留运行标记为 interrupted", async ({ page }) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#intent").fill("[E2E:SLOW] 刷新页面模拟浏览器中断。");
  await page.locator("#send").click();
  await expect(page.locator("#stop-run")).toBeVisible();
  await page.reload();
  await expect(page.locator("#connection-status")).toContainText("已连接");
  await page.locator("#run-panel-trigger").click();
  await expect(page.locator("#run-list .run-item").first()).toContainText("已中断");
});

test("经授权生成并验证 Word、PPT 与 PDF", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  await runIntent(page, "[E2E:OFFICE] 生成 Word、PPT 和 PDF 产物。", "已生成并重新检查", 45_000);
  expect(dialogs.some((message) => message.includes("document.create"))).toBe(true);

  for (const name of ["report.docx", "briefing.pptx", "report.pdf"]) {
    expect(await workspaceFileSize(page, name), name).toBeGreaterThan(100);
  }
  await page.locator("#file-panel-trigger").click();
  await expect(page.locator("#file-tree")).toContainText("report.docx");
  await expect(page.locator("#file-tree")).toContainText("briefing.pptx");
  await expect(page.locator("#file-tree")).toContainText("report.pdf");
});

async function configureGateway(page: Page): Promise<void> {
  await expect(page.locator("#settings-trigger")).toBeVisible();
  await page.locator("#settings-trigger").click();
  await page.locator("#provider-mode").selectOption("gateway");
  await page.locator("#provider-url").fill(MOCK_GATEWAY);
  await page.locator("#model-name").fill("mock-a");
  await page.locator("#save-model").click();
  await expect(page.locator("#model-help")).toContainText("已保存");
  await page.locator("#settings-dialog button[aria-label='关闭']").click();
}

async function createProject(page: Page): Promise<void> {
  await page.locator("#new-project").click();
  await expect(page.locator("#connection-status")).toContainText("已连接");
  await expect(page.locator("#intent")).toBeEnabled();
  await expect(page.locator("#composer-model option[value='mock-a']")).toContainText("工具✓");
}

async function runIntent(page: Page, intent: string, finalText: string, timeout = 15_000): Promise<void> {
  await page.locator("#intent").fill(intent);
  await page.locator("#send").click();
  await expect(page.locator(".message.assistant").last()).toContainText(finalText, { timeout });
  await expect(page.locator("#stop-run")).toBeHidden();
}

function gatewayRequests(page: Page): GatewayCall[] { return capturedGatewayCalls.get(page) ?? []; }

async function readWorkspaceFile(page: Page, name: string): Promise<string> {
  return page.evaluate(async (filename) => {
    const root = await navigator.storage.getDirectory();
    const project = await root.getDirectoryHandle("browser-agent-e2e");
    return (await (await project.getFileHandle(filename)).getFile()).text();
  }, name);
}

async function workspaceFileExists(page: Page, name: string): Promise<boolean> {
  return page.evaluate(async (filename) => {
    try {
      const root = await navigator.storage.getDirectory();
      const project = await root.getDirectoryHandle("browser-agent-e2e");
      await project.getFileHandle(filename);
      return true;
    } catch { return false; }
  }, name);
}

async function workspaceFileSize(page: Page, name: string): Promise<number> {
  return page.evaluate(async (filename) => {
    const root = await navigator.storage.getDirectory();
    const project = await root.getDirectoryHandle("browser-agent-e2e");
    return (await (await project.getFileHandle(filename)).getFile()).size;
  }, name);
}

function chooseTurn(intent: string, toolResults: number): GatewayTurn {
  if (intent.includes("[E2E:FAIL]")) return { text: "", toolCalls: [{ id: `missing-${toolResults}`, name: "workspace.read", arguments: { path: "/missing.txt" } }] };
  if (intent.includes("[E2E:WRITE]")) return toolResults
    ? { text: "已根据工具结果创建文件。", toolCalls: [] }
    : { text: "", toolCalls: [{ id: "write-report", name: "workspace.write", arguments: { path: "/report.txt", content: "Browser Agent E2E\n" } }] };
  if (intent.includes("[E2E:OFFICE]")) return toolResults >= 3
    ? { text: "已生成并重新检查 DOCX、PPTX 和 PDF。", toolCalls: [] }
    : { text: "", toolCalls: [
        { id: "create-docx", name: "document.create", arguments: { path: "/report.docx", spec: { title: "E2E 报告", blocks: [{ type: "heading", text: "结论", level: 1 }, { type: "paragraph", text: "验证通过" }] } } },
        { id: "create-pptx", name: "presentation.create", arguments: { path: "/briefing.pptx", spec: { title: "E2E 汇报", slides: [{ layout: "title", title: "E2E 汇报", subtitle: "Browser Agent" }, { layout: "bullets", title: "结论", bullets: ["验证通过"] }] } } },
        { id: "create-pdf", name: "pdf.create", arguments: { path: "/report.pdf", title: "E2E PDF", paragraphs: ["Validated by Browser Agent"] } }
      ] };
  return toolResults
    ? { text: "检查完成，已取得真实项目证据。", toolCalls: [] }
    : { text: "", toolCalls: [{ id: "list-root", name: "workspace.list", arguments: { path: "/" } }] };
}

function userIntent(messages: ModelMessage[]): string {
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return user.content.find((part) => part.type === "text")?.text ?? "";
}

function sseResponse(turn: GatewayTurn): { status: number; contentType: string; body: string } {
  const events = [
    ...(turn.text ? [{ type: "text-delta", delta: turn.text }] : []),
    { type: "turn-complete", response: turn }
  ];
  return { status: 200, contentType: "text/event-stream; charset=utf-8", body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") };
}

interface ModelMessage { role: string; content: string | Array<{ type?: string; text?: string; mimeType?: string; data?: string }>; }
interface GatewayCall { modelId?: string; messages: ModelMessage[]; }
interface GatewayTurn { text: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; }
