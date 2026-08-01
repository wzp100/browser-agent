import { expect, test, type Page } from "@playwright/test";

const MOCK_GATEWAY = "http://127.0.0.1:8790/mock-runtime-gateway";

test("真实 WebContainer 执行 JavaScript、ESM、npm、错误与取消且不泄漏临时脚本", async ({ page }) => {
  const calls: GatewayCall[] = [];
  const consoleErrors: string[] = [];
  const runtimeNetworkFailures: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`${error.name}: ${error.message}`));
  page.on("requestfailed", (request) => {
    if (/stackblitz|staticblitz|webcontainer/i.test(request.url())) runtimeNetworkFailures.push(`${request.url()}：${request.failure()?.errorText ?? "unknown"}`);
  });
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
  const headers = response?.headers() ?? {};
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-embedder-policy"]).toBe("credentialless");
  await expect.poll(() => page.evaluate(() => ({
    isolated: crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer
  }))).toEqual({ isolated: true, sharedArrayBuffer: "function" });

  await configureGateway(page);
  await resetRuntimeProject(page);
  await createProject(page);
  await writeWorkspaceFile(page, "数据 空格.txt", "中文 runtime fixture\n");
  expect(await workspaceMjsFiles(page)).toEqual([]);
  await startRuntime(page, runtimeNetworkFailures);

  await runIntent(page, "[RUNTIME:JS] 执行普通 JavaScript。", "普通 JavaScript 已执行");
  expect(toolContents(calls, "javascript.exec")).toContain("runtime-ok");

  await runIntent(page, "[RUNTIME:ESM] 使用 ESM 相对读取文件。", "ESM 相对读取已执行");
  expect(toolContents(calls, "javascript.exec")).toContain("中文 runtime fixture");

  await runIntent(page, "[RUNTIME:TEMP] 检查 Runtime 内部临时脚本。", "Runtime 临时目录已检查");
  expect(toolContents(calls, "shell.exec")).toContain("runtime-temp-files=[]");

  await runIntent(page, "[RUNTIME:ERROR] 验证执行错误可返回模型。", "执行错误已被结构化处理");
  expect(toolContents(calls, "javascript.exec")).toContain("expected-runtime-error");

  await runIntent(page, "[RUNTIME:NPM] 安装纯 JavaScript 依赖并保存快照。", "依赖安装已执行", 180_000);
  await expect.poll(() => workspaceFileSize(page, ".browser-agent/packages/installed/node-modules.snapshot"), { timeout: 60_000 }).toBeGreaterThan(0);

  await page.locator("#intent").fill("[RUNTIME:ABORT] 启动长时间 JavaScript 并等待停止。");
  await page.locator("#send").click();
  await expect(page.locator("#runtime-status")).toContainText("WebContainer 已连接", { timeout: 120_000 });
  expect(await workspaceMjsFiles(page)).toEqual([]);
  await page.locator("#stop-run").click();
  await expect(page.locator(".message.error").last()).toContainText("停止", { timeout: 30_000 });

  await expect.poll(() => workspaceMjsFiles(page)).toEqual([]);
  await runIntent(page, "[RUNTIME:TEMP] 停止后再次检查 Runtime 内部临时脚本。", "Runtime 临时目录已检查");
  expect(lastToolContent(calls, "shell.exec")).toContain("runtime-temp-files=[]");
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
      : tool("runtime-abort", "javascript.exec", { source: "await new Promise(() => {});" });
  }
  if (intent.includes("[RUNTIME:NPM]")) {
    return tools.length
      ? { text: "依赖安装已执行。", toolCalls: [] }
      : tool("runtime-npm", "shell.exec", { command: "npm install --ignore-scripts --no-save is-number@7.0.0", timeoutMs: 120_000 });
  }
  if (intent.includes("[RUNTIME:TEMP]")) {
    return tools.length
      ? { text: "Runtime 临时目录已检查。", toolCalls: [] }
      : tool("runtime-temp-check", "shell.exec", { command: String.raw`node -e "const fs=require('node:fs');const path='.browser-agent/runtime-tmp';const found=[];function walk(dir){if(!fs.existsSync(dir))return;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const next=dir+'/'+entry.name;if(entry.isDirectory())walk(next);else if(entry.name.endsWith('.mjs'))found.push(next)}}walk(path);console.log('runtime-temp-files='+JSON.stringify(found.sort()))"` });
  }
  if (intent.includes("[RUNTIME:ERROR]")) {
    if (!tools.length) return tool("runtime-error", "javascript.exec", { source: 'throw new Error("expected-runtime-error");' });
    if (!toolNames.includes("workspace.list")) return tool("runtime-error-evidence", "workspace.list", { path: "/" });
    return { text: "执行错误已被结构化处理。", toolCalls: [] };
  }
  if (intent.includes("[RUNTIME:ESM]")) {
    return tools.length
      ? { text: "ESM 相对读取已执行。", toolCalls: [] }
      : tool("runtime-esm", "javascript.exec", { source: 'import { readFile } from "node:fs/promises"; console.log((await readFile("./数据 空格.txt", "utf8")).trim());' });
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

async function startRuntime(page: Page, networkFailures: string[]): Promise<void> {
  await page.locator("#terminal-start").click();
  await expect.poll(async () => ({
    status: (await page.locator("#runtime-status").textContent())?.trim(),
    networkFailures
  }), { timeout: 60_000, message: "真实 WebContainer 应在 60 秒内完成 boot，且外部引导资源不得被浏览器拦截" })
    .toEqual({ status: "WebContainer 已连接", networkFailures: [] });
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

async function writeWorkspaceFile(page: Page, name: string, content: string): Promise<void> {
  await page.evaluate(async ({ filename, value }) => {
    const root = await navigator.storage.getDirectory();
    const project = await root.getDirectoryHandle("browser-agent-runtime-e2e", { create: true });
    const handle = await project.getFileHandle(filename, { create: true });
    const writer = await handle.createWritable();
    await writer.write(value);
    await writer.close();
  }, { filename: name, value: content });
}

async function workspaceMjsFiles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const project = await root.getDirectoryHandle("browser-agent-runtime-e2e", { create: true });
    const found: string[] = [];
    const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      const iterable = directory as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
      for await (const [name, handle] of iterable.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, path);
        else if (name.endsWith(".mjs")) found.push(path);
      }
    };
    await walk(project, "");
    return found.sort();
  });
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
