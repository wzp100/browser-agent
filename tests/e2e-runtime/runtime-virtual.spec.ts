import { expect, test, type Page } from "@playwright/test";

const MOCK_GATEWAY = "http://127.0.0.1:8790/mock-runtime-gateway";

test("Virtual Runtime 执行 Bash、JavaScript、npm 包、错误与强制取消", async ({ page }) => {
  const calls: GatewayCall[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`${error.name}: ${error.message}`));
  page.on("dialog", (dialog) => dialog.accept());
  await installGatewayRoutes(page, calls);
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("browser-agent-runtime-e2e", { create: true });
      }
    });
  });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await configureGateway(page);
  await resetRuntimeProject(page);
  await createProject(page);
  await startRuntime(page);

  await runIntent(page, "[RUNTIME:SHELL] 执行基础 Bash 管道和重定向。", "虚拟 Bash 已执行");
  expect(toolContents(calls, "shell.exec")).toContain("BASH_OK");

  await runIntent(page, "[RUNTIME:JS] 执行普通 JavaScript。", "普通 JavaScript 已执行");
  expect(toolContents(calls, "javascript.exec")).toContain("runtime-ok");

  await runIntent(page, "[RUNTIME:ERROR] 验证执行错误可返回模型。", "执行错误已被结构化处理");
  expect(toolContents(calls, "javascript.exec")).toContain("expected-runtime-error");

  await runIntent(page, "[RUNTIME:NPM] 安装纯 JavaScript 依赖。", "依赖安装已执行", 180_000);
  await expect.poll(() => workspaceFileSize(page, ".browser-agent/virtual-lock.json"), { timeout: 60_000 }).toBeGreaterThan(0);
  await runIntent(page, "[RUNTIME:PACKAGE] 执行刚安装的依赖。", "已安装依赖执行成功");
  expect(lastToolContent(calls, "shell.exec")).toContain("PACKAGE_OK=true");

  await page.locator("#intent").fill("[RUNTIME:ABORT] 启动长时间 JavaScript 并等待停止。");
  await page.locator("#send").click();
  await expect(page.locator(".tool-step-command").last()).toContainText("while (true)", { timeout: 30_000 });
  await expect(page.locator(".tool-step-state").last()).toContainText("运行中");
  await page.locator("#stop-run").click();
  await expect(page.locator(".message.error").last()).toContainText("停止", { timeout: 30_000 });

  expect(consoleErrors.filter((message) => /TypeMismatchError|EISDIR/i.test(message))).toEqual([]);
  expect(consoleErrors.length).toBeLessThan(20);
});

async function installGatewayRoutes(page: Page, calls: GatewayCall[]): Promise<void> {
  await page.route("https://models.dev/api.json", (route) => route.fulfill({ json: {}, headers: { etag: '"runtime-e2e"' } }));
  await page.route("**/v1/models", (route) => route.fulfill({
    json: { data: [{ id: "runtime-mock", name: "Runtime Mock", tool_call: true, input_modalities: ["text"], context_window: 128_000 }] }
  }));
  await page.route("**/v1/agent/turn", async (route) => {
    const call = route.request().postDataJSON() as GatewayCall;
    calls.push(call);
    await route.fulfill(sseResponse(nextTurn(call)));
  });
}

function nextTurn(call: GatewayCall): GatewayTurn {
  const intent = userIntent(call.messages);
  const tools = call.messages.filter((message) => message.role === "tool");
  const toolNames = tools.map((message) => message.name);
  if (intent.includes("[RUNTIME:ABORT]")) {
    return tools.length
      ? { text: "长时间脚本已结束。", toolCalls: [] }
      : tool("runtime-abort", "javascript.exec", { source: "while (true) {}", timeoutMs: 60_000 });
  }
  if (intent.includes("[RUNTIME:NPM]")) {
    return tools.length
      ? { text: "依赖安装已执行。", toolCalls: [] }
      : tool("runtime-npm", "shell.exec", { command: "npm install --ignore-scripts --no-save is-number@7.0.0", timeoutMs: 120_000 });
  }
  if (intent.includes("[RUNTIME:PACKAGE]")) {
    return tools.length
      ? { text: "已安装依赖执行成功。", toolCalls: [] }
      : tool("runtime-package", "shell.exec", { command: `node -e "const isNumber=require('is-number'); console.log('PACKAGE_OK='+isNumber(7))"` });
  }
  if (intent.includes("[RUNTIME:SHELL]")) {
    return tools.length
      ? { text: "虚拟 Bash 已执行。", toolCalls: [] }
      : tool("runtime-shell", "shell.exec", { command: "printf 'b\\na\\n' | sort > sorted.txt && grep a sorted.txt && echo BASH_OK" });
  }
  if (intent.includes("[RUNTIME:ERROR]")) {
    if (!tools.length) return tool("runtime-error", "javascript.exec", { source: 'throw new Error("expected-runtime-error");' });
    if (!toolNames.includes("workspace.list")) return tool("runtime-error-evidence", "workspace.list", { path: "/" });
    return { text: "执行错误已被结构化处理。", toolCalls: [] };
  }
  return tools.length
    ? { text: "普通 JavaScript 已执行。", toolCalls: [] }
    : tool("runtime-js", "javascript.exec", { source: 'console.log("runtime-ok");' });
}

function tool(id: string, name: string, argumentsValue: Record<string, unknown>): GatewayTurn {
  return { text: "", toolCalls: [{ id, name, arguments: argumentsValue }] };
}

async function configureGateway(page: Page): Promise<void> {
  await page.locator("#settings-trigger").click();
  await page.locator("#provider-mode").selectOption("gateway");
  await page.locator("#provider-url").fill(MOCK_GATEWAY);
  await page.locator("#model-name").fill("runtime-mock");
  await page.locator("#save-model").click();
  await expect(page.locator("#model-help")).toContainText("已保存");
  await page.locator("#settings-dialog button[aria-label='关闭']").click();
}

async function createProject(page: Page): Promise<void> {
  await page.locator("#new-project").click();
  await expect(page.locator("#connection-status")).toContainText("已连接");
  await expect(page.locator("#intent")).toBeEnabled();
}

async function startRuntime(page: Page): Promise<void> {
  await page.locator("#terminal-start").click();
  await expect(page.locator("#runtime-status")).toContainText("Virtual Runtime 已连接", { timeout: 60_000 });
}

async function resetRuntimeProject(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry("browser-agent-runtime-e2e", { recursive: true }); }
    catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; }
  });
}

async function runIntent(page: Page, intent: string, finalText: string, timeout = 120_000): Promise<void> {
  await page.locator("#intent").fill(intent);
  await page.locator("#send").click();
  await expect(page.locator(".message.assistant").last()).toContainText(finalText, { timeout });
  await expect(page.locator("#stop-run")).toBeHidden();
}

async function workspaceFileSize(page: Page, path: string): Promise<number> {
  return page.evaluate(async (workspacePath) => {
    try {
      const root = await navigator.storage.getDirectory();
      let directory = await root.getDirectoryHandle("browser-agent-runtime-e2e");
      const parts = workspacePath.split("/").filter(Boolean);
      const name = parts.pop();
      if (!name) return 0;
      for (const part of parts) directory = await directory.getDirectoryHandle(part);
      return (await (await directory.getFileHandle(name)).getFile()).size;
    } catch {
      return 0;
    }
  }, path);
}

function userIntent(messages: ModelMessage[]): string {
  const user = [...messages].reverse().find((message) => message.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return user.content.find((part) => part.type === "text")?.text ?? "";
}

function toolContents(calls: GatewayCall[], toolName: string): string {
  return calls.flatMap((call) => call.messages)
    .filter((message) => message.role === "tool" && message.name === toolName)
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
}

function lastToolContent(calls: GatewayCall[], toolName: string): string {
  const contents = calls.flatMap((call) => call.messages)
    .filter((message) => message.role === "tool" && message.name === toolName)
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
  return contents.at(-1) ?? "";
}

function sseResponse(turn: GatewayTurn): { status: number; contentType: string; body: string } {
  const events = [
    ...(turn.text ? [{ type: "text-delta", delta: turn.text }] : []),
    { type: "turn-complete", response: turn }
  ];
  return { status: 200, contentType: "text/event-stream; charset=utf-8", body: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") };
}

interface ModelMessage {
  role: string;
  name?: string;
  content: string | Array<{ type?: string; text?: string }>;
}
interface GatewayCall { messages: ModelMessage[]; }
interface GatewayTurn { text: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; }
