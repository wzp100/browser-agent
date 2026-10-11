import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { gzipSync } from "fflate";

const MOCK_GATEWAY = "http://127.0.0.1:8790/mock-runtime-gateway";
const packages = packageFixtures();

test("Virtual Runtime executes shell, Promise jobs, and commits only successful node:fs overlays to OPFS", async ({ page }) => {
  const { calls } = await readyRuntime(page);
  await runIntent(page, "[RUNTIME:SHELL]", "虚拟 Bash 已执行");
  expect(toolContent(calls, "shell.exec")).toContain("BASH_OK");
  expect(await workspaceText(page, "sorted.txt")).toBe("a\nb\n");

  await runIntent(page, "[RUNTIME:JS]", "普通 JavaScript 已执行");
  expect(toolContent(calls, "javascript.exec")).toContain("runtime-ok");
  expect(toolContent(calls, "javascript.exec")).toContain("next-tick-ok");

  await seedWorkspace(page, "seed.txt", "seed-value\n");
  await runIntent(page, "[RUNTIME:FS:COMMIT]", "文件覆盖层已提交");
  expect(toolContent(calls, "javascript.exec")).toContain("FS_OK=seed-value");
  expect([...await workspaceBytes(page, "generated/result.bin")]).toEqual([0, 255]);

  await runIntent(page, "[RUNTIME:FS:ROLLBACK]", "失败覆盖层已回滚");
  expect(toolContent(calls, "javascript.exec")).toContain("overlay-stop");
  await expect.poll(() => workspaceExists(page, "discarded.txt")).toBe(false);
  await runIntent(page, "[RUNTIME:FS:RESERVED]", "保留路径已拒绝");
  expect(toolContent(calls, "javascript.exec")).toContain("ERR_BROWSER_RUNTIME_FS_PATH");
});

test("Virtual npm uses routed hermetic pure-JS packages, including a larger package and npx JS bin", async ({ page }) => {
  const { calls, registryRequests } = await readyRuntime(page);
  await runIntent(page, "[RUNTIME:NPM]", "小型依赖安装已执行");
  await runIntent(page, "[RUNTIME:PACKAGE]", "已安装依赖执行成功");
  expect(lastToolContent(calls, "shell.exec")).toContain("PACKAGE_OK=42");
  await runIntent(page, "[RUNTIME:NPX]", "npx JavaScript 入口已执行");
  expect(lastToolContent(calls, "shell.exec")).toContain("NPX_OK=browser");

  await runIntent(page, "[RUNTIME:LARGE]", "较大纯 JavaScript 依赖安装已执行");
  await runIntent(page, "[RUNTIME:LARGE_PACKAGE]", "较大依赖执行成功");
  expect(lastToolContent(calls, "shell.exec")).toContain("LARGE_OK=3,2");
  expect(registryRequests.some((url) => url.includes("tiny-e2e"))).toBe(true);
  expect(registryRequests.some((url) => url.includes("large-e2e"))).toBe(true);
  expect(await workspaceText(page, ".browser-agent/virtual-lock.json")).toContain('"tiny-e2e"');
  expect(await workspaceText(page, ".browser-agent/virtual-lock.json")).toContain('"large-e2e"');
});

test("Virtual Runtime cancellation returns control without a delayed success and the next execution recovers", async ({ page }) => {
  const { calls } = await readyRuntime(page);
  await page.locator("#intent").fill("[RUNTIME:ABORT]");
  await page.locator("#send").click();
  await expect(page.locator(".tool-step-command").last()).toContainText("while (true)");
  await page.locator("#stop-run").click();
  await expect(page.locator(".message.error").last()).toContainText("停止");
  await expect(page.locator("#stop-run")).toBeHidden();
  expect(toolContent(calls, "javascript.exec")).not.toContain("unexpected-after-abort");

  await runIntent(page, "[RUNTIME:RECOVER]", "取消后 Runtime 已恢复");
  expect(lastToolContent(calls, "javascript.exec")).toContain("recovery-ok");
});

async function readyRuntime(page: Page): Promise<{ calls: GatewayCall[]; registryRequests: string[] }> {
  const calls: GatewayCall[] = []; const registryRequests: string[] = []; const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(`${error.name}: ${error.message}`));
  page.on("dialog", (dialog) => void dialog.accept());
  await installRoutes(page, calls, registryRequests);
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => (await navigator.storage.getDirectory()).getDirectoryHandle("browser-agent-runtime-e2e", { create: true }) });
  });
  await page.goto("/"); await configureGateway(page); await resetRuntimeProject(page); await createProject(page); await startRuntime(page);
  expect(consoleErrors.filter((message) => /TypeMismatchError|EISDIR/i.test(message))).toEqual([]);
  return { calls, registryRequests };
}

async function installRoutes(page: Page, calls: GatewayCall[], registryRequests: string[]): Promise<void> {
  await page.route("https://models.dev/api.json", (route) => route.fulfill({ json: {}, headers: { etag: '"runtime-e2e"' } }));
  await page.route("**/v1/models", (route) => route.fulfill({ json: { data: [{ id: "runtime-mock", name: "Runtime Mock", tool_call: true, input_modalities: ["text"], context_window: 128_000 }] } }));
  await page.route("https://registry.npmjs.org/**", (route) => {
    const url = route.request().url(); registryRequests.push(url);
    const fixture = Object.values(packages).find((item) => url.endsWith(`/${item.name}`) || url.endsWith(`/__e2e__/${item.name}.tgz`));
    if (!fixture) return route.fulfill({ status: 404, body: "not found" });
    return url.endsWith(".tgz")
      ? route.fulfill({ body: Buffer.from(fixture.archive), headers: { "content-type": "application/octet-stream", "content-length": String(fixture.archive.byteLength) } })
      : route.fulfill({ json: { name: fixture.name, "dist-tags": { latest: fixture.version }, versions: { [fixture.version]: { name: fixture.name, version: fixture.version, dist: { tarball: `https://registry.npmjs.org/__e2e__/${fixture.name}.tgz`, integrity: fixture.integrity } } } } });
  });
  await page.route("**/v1/agent/turn", async (route) => { const call = route.request().postDataJSON() as GatewayCall; calls.push(call); await route.fulfill(sseResponse(nextTurn(call))); });
}

function nextTurn(call: GatewayCall): GatewayTurn {
  const intent = userIntent(call.messages); const tools = call.messages.filter((message) => message.role === "tool"); const toolNames = tools.map((message) => message.name);
  const done = (text: string): GatewayTurn => tools.length ? { text, toolCalls: [] } : { text: "", toolCalls: [] };
  const errorEvidence = (id: string, text: string): GatewayTurn => !tools.length ? { text: "", toolCalls: [] } : toolNames.includes("workspace.list") ? done(text) : tool(id, "workspace.list", { path: "/" });
  if (intent.includes("[RUNTIME:SHELL]")) return tools.length ? done("虚拟 Bash 已执行。") : tool("runtime-shell", "shell.exec", { command: "printf 'b\\na\\n' | sort > sorted.txt && grep a sorted.txt && echo BASH_OK" });
  if (intent.includes("[RUNTIME:JS]")) return tools.length ? done("普通 JavaScript 已执行。") : tool("runtime-js", "javascript.exec", { source: `Promise.resolve().then(() => console.log("runtime-ok")); process.nextTick(() => console.log("next-tick-ok"));` });
  if (intent.includes("[RUNTIME:ABORT]")) return tools.length ? done("长时间脚本已停止。") : tool("runtime-abort", "javascript.exec", { source: "while (true) {}", timeoutMs: 60_000 });
  if (intent.includes("[RUNTIME:NPM]")) return tools.length ? done("小型依赖安装已执行。") : tool("runtime-npm", "shell.exec", { command: "npm install --ignore-scripts --no-save tiny-e2e@1.0.0" });
  if (intent.includes("[RUNTIME:PACKAGE]")) return tools.length ? done("已安装依赖执行成功。") : tool("runtime-package", "shell.exec", { command: `node -e "const tiny=require('tiny-e2e'); console.log('PACKAGE_OK='+tiny.answer)"` });
  if (intent.includes("[RUNTIME:NPX]")) return tools.length ? done("npx JavaScript 入口已执行。") : tool("runtime-npx", "shell.exec", { command: "npx tiny-e2e browser" });
  if (intent.includes("[RUNTIME:LARGE]")) return tools.length ? done("较大纯 JavaScript 依赖安装已执行。") : tool("runtime-large", "shell.exec", { command: "npm install --ignore-scripts --no-save large-e2e@1.0.0" });
  if (intent.includes("[RUNTIME:LARGE_PACKAGE]")) return tools.length ? done("较大依赖执行成功。") : tool("runtime-large-package", "shell.exec", { command: `node -e "const large=require('large-e2e'); console.log('LARGE_OK='+large.chunkCount([1,2,3,4,5,6],2)+','+large.chunkCount([1,2,3,4],2))"` });
  if (intent.includes("[RUNTIME:FS:COMMIT]")) return tools.length ? done("文件覆盖层已提交。") : tool("runtime-fs-commit", "javascript.exec", { source: `import("node:fs/promises").then(async fs => { const input = await fs.readFile("seed.txt", "utf8"); await fs.mkdir("generated", { recursive: true }); await fs.writeFile("generated/result.bin", Buffer.from([0, 255])); console.log("FS_OK=" + input.trim()); })` });
  if (intent.includes("[RUNTIME:FS:ROLLBACK]")) return tools.length ? errorEvidence("runtime-fs-rollback-evidence", "失败覆盖层已回滚。") : tool("runtime-fs-rollback", "javascript.exec", { source: `import("node:fs/promises").then(async fs => { await fs.writeFile("discarded.txt", "no"); throw new Error("overlay-stop"); })` });
  if (intent.includes("[RUNTIME:FS:RESERVED]")) return tools.length ? errorEvidence("runtime-fs-reserved-evidence", "保留路径已拒绝。") : tool("runtime-fs-reserved", "javascript.exec", { source: `import("node:fs/promises").then(async fs => { try { await fs.readFile(".browser-agent/virtual-lock.json"); } catch (error) { console.log(error.code); } })` });
  if (intent.includes("[RUNTIME:RECOVER]")) return tools.length ? done("取消后 Runtime 已恢复。") : tool("runtime-recover", "javascript.exec", { source: `console.log("recovery-ok")` });
  return tools.length ? done("普通 JavaScript 已执行。") : tool("runtime-js", "javascript.exec", { source: `Promise.resolve().then(() => console.log("runtime-ok")); process.nextTick(() => console.log("next-tick-ok"));` });
}

async function configureGateway(page: Page): Promise<void> { await page.locator("#settings-trigger").click(); await page.locator("#provider-mode").selectOption("gateway"); await page.locator("#provider-url").fill(MOCK_GATEWAY); await page.locator("#model-name").fill("runtime-mock"); await page.locator("#save-model").click(); await expect(page.locator("#model-help")).toContainText("已保存"); await page.locator("#settings-dialog button[aria-label='关闭']").click(); }
async function createProject(page: Page): Promise<void> { await page.locator("#new-project").click(); await expect(page.locator("#connection-status")).toContainText("已连接"); }
async function startRuntime(page: Page): Promise<void> { await page.locator("#terminal-start").click(); await expect(page.locator("#runtime-status")).toContainText("Virtual Runtime 已连接", { timeout: 60_000 }); }
async function resetRuntimeProject(page: Page): Promise<void> { await page.evaluate(async () => { const root = await navigator.storage.getDirectory(); try { await root.removeEntry("browser-agent-runtime-e2e", { recursive: true }); } catch (error) { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; } }); }
async function runIntent(page: Page, intent: string, finalText: string): Promise<void> { await page.locator("#intent").fill(intent); await page.locator("#send").click(); await expect(page.locator(".message.assistant").last()).toContainText(finalText, { timeout: 60_000 }); }
async function seedWorkspace(page: Page, path: string, text: string): Promise<void> { await page.evaluate(async ({ filename, value }) => { const root = await navigator.storage.getDirectory(); const project = await root.getDirectoryHandle("browser-agent-runtime-e2e"); const handle = await project.getFileHandle(filename, { create: true }); const writer = await handle.createWritable(); await writer.write(value); await writer.close(); }, { filename: path, value: text }); }
async function workspaceBytes(page: Page, path: string): Promise<Uint8Array> { return page.evaluate(async (filename) => { const root = await navigator.storage.getDirectory(); const project = await root.getDirectoryHandle("browser-agent-runtime-e2e"); let directory = project; const parts = filename.split("/"); const name = parts.pop()!; for (const part of parts) directory = await directory.getDirectoryHandle(part); return [...new Uint8Array(await (await (await directory.getFileHandle(name)).getFile()).arrayBuffer())]; }, path).then((value) => Uint8Array.from(value)); }
async function workspaceText(page: Page, path: string): Promise<string> { return new TextDecoder().decode(await workspaceBytes(page, path)); }
async function workspaceExists(page: Page, path: string): Promise<boolean> { return page.evaluate(async (filename) => { try { const root = await navigator.storage.getDirectory(); const project = await root.getDirectoryHandle("browser-agent-runtime-e2e"); let directory = project; const parts = filename.split("/"); const name = parts.pop()!; for (const part of parts) directory = await directory.getDirectoryHandle(part); await directory.getFileHandle(name); return true; } catch { return false; } }, path); }
function tool(id: string, name: string, argumentsValue: Record<string, unknown>): GatewayTurn { return { text: "", toolCalls: [{ id, name, arguments: argumentsValue }] }; }
function userIntent(messages: ModelMessage[]): string { const user = [...messages].reverse().find((message) => message.role === "user"); if (!user) return ""; if (typeof user.content === "string") return user.content; const text = user.content.find((part) => part.type === "text")?.text; return text ?? JSON.stringify(user.content); }
function toolContent(calls: GatewayCall[], name: string): string { return calls.flatMap((call) => call.messages).filter((message) => message.role === "tool" && message.name === name).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n"); }
function lastToolContent(calls: GatewayCall[], name: string): string { return toolContent(calls, name).split("\n").at(-1) ?? ""; }
function sseResponse(turn: GatewayTurn): { status: number; contentType: string; body: string } { return { status: 200, contentType: "text/event-stream; charset=utf-8", body: [...(turn.text ? [{ type: "text-delta", delta: turn.text }] : []), { type: "turn-complete", response: turn }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") }; }
interface ModelMessage { role: string; name?: string; content: string | Array<{ type?: string; text?: string }>; }
interface GatewayCall { messages: ModelMessage[]; }
interface GatewayTurn { text: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; }

function packageFixtures(): Record<string, { name: string; version: string; archive: Uint8Array; integrity: string }> {
  const tiny = npmArchive("tiny-e2e", { "index.js": "module.exports = { answer: 42 };", "bin.js": "console.log('NPX_OK=' + process.argv[2]);" }, { bin: { "tiny-e2e": "bin.js" } });
  const large = npmArchive("large-e2e", { "index.js": `/* ${"pure-js ".repeat(12_000)} */\nexports.chunkCount = (items, size) => Math.ceil(items.length / size);` });
  return { tiny, large };
}
function npmArchive(name: string, files: Record<string, string>, extra: Record<string, unknown> = {}): { name: string; version: string; archive: Uint8Array; integrity: string } { const archive = tarGzip([{ path: "package/package.json", content: JSON.stringify({ name, version: "1.0.0", ...extra }) }, ...Object.entries(files).map(([path, content]) => ({ path: `package/${path}`, content }))]); return { name, version: "1.0.0", archive, integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}` }; }
function tarGzip(files: Array<{ path: string; content: string }>): Uint8Array { const chunks: Uint8Array[] = []; for (const file of files) { const data = new TextEncoder().encode(file.content); const header = new Uint8Array(512); put(header, 0, 100, file.path); put(header, 100, 8, "0000644\0"); put(header, 124, 12, `${data.byteLength.toString(8).padStart(11, "0")}\0`); header[156] = 48; put(header, 257, 6, "ustar\0"); chunks.push(header, data, new Uint8Array((512 - data.byteLength % 512) % 512)); } chunks.push(new Uint8Array(1024)); const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0)); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return gzipSync(result); }
function put(target: Uint8Array, offset: number, length: number, value: string): void { target.set(new TextEncoder().encode(value).subarray(0, length), offset); }
