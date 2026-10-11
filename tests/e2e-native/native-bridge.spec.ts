import { expect, test as base, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBridgeServer } from "../../apps/native-bridge/src/bridge-server";

const APP_ORIGIN = "http://127.0.0.1:4174";
const MOCK_GATEWAY = `${APP_ORIGIN}/mock-native-gateway`;

interface BridgeFixture { endpoint: string; pairingCode: string; root: string; state: string; effects: { fetchAbortCalls: number; fetchLateChunk: boolean; cancelledEndEvents: number }; close(): Promise<void>; }
interface ModelMessage { role: string; name?: string; content: string | Array<{ type?: string; text?: string }>; }
interface GatewayCall { messages: ModelMessage[]; }
interface GatewayTurn { text: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; }

const test = base.extend<{ bridge: BridgeFixture }>({
  bridge: async ({}, use) => {
    const fixture = await startBridge();
    try { await use(fixture); } finally { await fixture.close(); }
  }
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle("browser-agent-native-e2e", { create: true });
      }
    });
  });
  await page.goto("/");
});

test("browser pairs, grants scoped host writes, confirms the tool, and writes the real host filesystem", async ({ page, bridge }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.accept(); });
  const calls = await installGateway(page, "write");
  await configureGateway(page);
  await createProject(page);

  await connect(page, bridge);
  const grant = await grantFromUi(page, "host.fs.write", '{"rootId":"work","prefixes":["e2e"]}');
  await expect(page.locator("#native-bridge-grants")).toContainText(grant.id.slice(0, 8));
  await closeSettings(page);

  await runIntent(page, "[NATIVE:WRITE] 将文件写入已授权宿主目录。", "宿主文件已写入");
  expect(dialogs.some((message) => message.includes("host.fs.write"))).toBe(true);
  expect(await readFile(join(bridge.root, "e2e", "from-ui.txt"), "utf8")).toBe("native-e2e\n");
  expect(toolContent(calls, "host.fs.write")).toContain('"ok":true');
  // The gateway receives an opaque app-local handle in the system environment, never the daemon grant id or bearer token.
  expect(JSON.stringify(calls)).not.toContain(grant.id);
  const audit = await readFile(join(bridge.state, "audit.jsonl"), "utf8");
  expect(audit).toContain('"capability":"host.fs.write"');
  expect(audit).toContain('"decision":"completed"');
  expect(audit).not.toContain("native-e2e");
});

test("browser lists and reads a scoped host filesystem through injected grant handles", async ({ page, bridge }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.accept(); });
  const calls = await installGateway(page, "fs-list-read");
  await configureGateway(page); await createProject(page); await connect(page, bridge);
  const grant = await grantFromUi(page, "host.fs.read", '{"rootId":"work","prefixes":["e2e"]}', "session"); await closeSettings(page);
  await runIntent(page, "[NATIVE:FS-READ] 列出并读取已授权宿主文件。", "宿主文件已读取");
  expect(dialogs.filter((message) => message.includes("host.fs.")).length).toBe(3);
  expect(toolContent(calls, "host.fs.list")).toContain("seed.txt");
  expect(toolContent(calls, "host.fs.read")).toContain("seed\\n");
  expect(JSON.stringify(calls)).not.toContain(grant.id);
  const audit = await readFile(join(bridge.state, "audit.jsonl"), "utf8");
  expect((audit.match(/"capability":"host\.fs\.read"/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test("browser pairs and runs a configured shell-free command through an explicit grant", async ({ page, bridge }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.accept(); });
  const calls = await installGateway(page, "command");
  await configureGateway(page);
  await createProject(page);

  await connect(page, bridge);
  const grant = await grantFromUi(page, "host.command.spawn", '{"commandIds":["node-version"]}');
  await closeSettings(page);

  await runIntent(page, "[NATIVE:COMMAND] 运行已配置的 Node 版本命令。", "宿主命令已完成");
  expect(dialogs.some((message) => message.includes("host.command.run"))).toBe(true);
  expect(toolContent(calls, "host.command.run")).toMatch(/"exitCode":0/);
  expect(toolContent(calls, "host.command.run")).toMatch(/"stdout":"v/);
  const audit = await readFile(join(bridge.state, "audit.jsonl"), "utf8");
  expect(audit).toContain('"capability":"host.command.spawn"');
  expect(audit).toContain('"exitCode":0');
});

test("browser exposes mkdir, move, and delete through the scoped host filesystem product path", async ({ page, bridge }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.accept(); });
  const calls = await installGateway(page, "fs-mutations");
  await configureGateway(page); await createProject(page); await connect(page, bridge);
  const grant = await grantFromUi(page, "host.fs.write", '{"rootId":"work","prefixes":["e2e"],"rename":true,"delete":true}', "session"); await closeSettings(page);
  await runIntent(page, "[NATIVE:FS-MUTATIONS] 创建、移动并删除已授权宿主路径。", "宿主文件操作已完成");
  await expect.poll(() => readFile(join(bridge.root, "e2e", "moved.txt"), "utf8")).toBe("seed\n");
  // One grant confirmation plus one visible confirmation for each host mutation.
  expect(dialogs.filter((message) => message.includes("host.fs.")).length).toBe(4);
  expect(toolContent(calls, "host.fs.mkdir")).toContain('"ok":true');
  expect(toolContent(calls, "host.fs.move")).toContain('"ok":true');
  expect(toolContent(calls, "host.fs.delete")).toContain('"ok":true');
  const audit = await readFile(join(bridge.state, "audit.jsonl"), "utf8");
  expect((audit.match(/"decision":"completed"/g) ?? []).length).toBeGreaterThanOrEqual(3);
});

test("browser exposes scoped DNS lookup and bounded native timers", async ({ page, bridge }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.accept(); });
  const dnsCalls = await installGateway(page, "dns");
  await configureGateway(page); await createProject(page); await connect(page, bridge);
  const dnsGrant = await grantFromUi(page, "net.dns.lookup", '{"suffixes":["localhost"]}'); await closeSettings(page);
  await runIntent(page, "[NATIVE:DNS] 查询已授权 DNS 名称。", "DNS 已查询");
  expect(dialogs.some((message) => message.includes("host.dns.lookup"))).toBe(true);
  expect(toolContent(dnsCalls, "host.dns.lookup")).toContain('"answers"');

  await page.locator("#settings-trigger").click();
  const timerGrant = await grantFromUi(page, "runtime.timers", '{}'); await closeSettings(page);
  const timerCalls = await installGateway(page, "timer");
  await runIntent(page, "[NATIVE:TIMER] 等待受限计时器。", "计时器已完成");
  expect(dialogs.some((message) => message.includes("host.timer.wait"))).toBe(true);
  expect(toolContent(timerCalls, "host.timer.wait")).toContain('"cancelled":false');
});

test("browser delivers authenticated command stream progress during the product flow", async ({ page, bridge }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await installGateway(page, "stream");
  await configureGateway(page); await createProject(page); await connect(page, bridge);
  const grant = await grantFromUi(page, "host.command.spawn", '{"commandIds":["streaming-node"]}'); await closeSettings(page);
  await page.locator("#intent").fill("[NATIVE:STREAM] 运行流式宿主命令。"); await page.locator("#send").click();
  await expect(page.locator("#composer-status")).toContainText("stdout stream", { timeout: 15_000 });
  await expect(page.locator(".message.assistant").last()).toContainText("流式宿主命令已完成");
  const audit = await readFile(join(bridge.state, "audit.jsonl"), "utf8");
  expect(audit).toContain('"capability":"host.command.spawn"');
});

test("browser streams a configured hermetic public HTTPS profile through the native product path", async ({ page, bridge }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  const calls = await installGateway(page, "fetch");
  await configureGateway(page); await createProject(page); await connect(page, bridge);
  const grant = await grantFromUi(page, "net.http", '{"profileIds":["hermetic-public"]}'); await closeSettings(page);
  await page.locator("#intent").fill("[NATIVE:FETCH] 获取已配置的 HTTPS 配置文件。"); await page.locator("#send").click();
  await expect(page.locator("#composer-status")).toContainText("body stream", { timeout: 15_000 });
  await expect(page.locator(".message.assistant").last()).toContainText("HTTPS 已获取。");
  expect(toolContent(calls, "host.network.fetch")).toContain("native fetch");
  expect(JSON.stringify(calls)).not.toContain(grant.id);
  const audit = await readFile(join(bridge.state, "audit.jsonl"), "utf8");
  expect(audit).toContain('"capability":"net.http"');
  expect(audit).toContain('"decision":"completed"');
});

test("browser stop cancels an active host command, settles the prompt, and prevents delayed host effects", async ({ page, bridge }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await installGateway(page, "command-cancel");
  await configureGateway(page); await createProject(page); await connect(page, bridge);
  await grantFromUi(page, "host.command.spawn", '{"commandIds":["cancellable-node"]}', "session"); await closeSettings(page);
  await page.locator("#intent").fill("[NATIVE:COMMAND-CANCEL] 启动可取消的宿主命令。"); await page.locator("#send").click();
  await expect(page.locator("#composer-status")).toContainText("stdout stream", { timeout: 15_000 });
  await expect(page.locator(".tool-run").last()).toHaveAttribute("data-status", "running");
  const stoppedAt = Date.now();
  await page.locator("#stop-run").click();
  await expect(page.locator(".tool-run").last()).toHaveAttribute("data-status", "cancelled", { timeout: 3_000 });
  await expect(page.locator(".message.error").last()).toContainText("用户停止了运行。", { timeout: 3_000 });
  expect(Date.now() - stoppedAt).toBeLessThan(3_000);
  await expect(page.locator("#send")).toBeEnabled();
  await expect(page.locator("#stop-run")).toBeHidden();
  await delay(1_300);
  await expect.poll(() => readFile(join(bridge.root, "e2e", "command-after-cancel.txt"), "utf8").then(() => true, () => false)).toBe(false);
  await expect.poll(() => hasCancelledAudit(bridge.state, "host.command.spawn")).toBe(true);
  await expect.poll(() => bridge.effects.cancelledEndEvents).toBe(1);
});

test("browser grant revocation terminates host fetch SSE progress, settles the prompt, and blocks late fixture effects", async ({ page, bridge }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  const calls = await installGateway(page, "fetch-cancel");
  await configureGateway(page); await createProject(page); await connect(page, bridge);
  const grant = await grantFromUi(page, "net.http", '{"profileIds":["hermetic-public"]}', "session"); await closeSettings(page);
  await page.locator("#intent").fill("[NATIVE:FETCH-CANCEL] 获取可撤销的 HTTPS 配置文件。"); await page.locator("#send").click();
  await expect(page.locator("#composer-status")).toContainText("body stream", { timeout: 15_000 });
  await expect(page.locator(".tool-run").last()).toHaveAttribute("data-status", "running");
  await page.locator("#settings-trigger").click();
  const grants = page.locator("#native-bridge-grants");
  await expect(grants).toContainText(grant.id.slice(0, 8));
  const revokedAt = Date.now();
  await grants.getByRole("button", { name: "撤销" }).click();
  await closeSettings(page);
  // The browser client includes this only after its authenticated SSE callback receives operation.end.
  await expect.poll(() => bridge.effects.cancelledEndEvents).toBe(1);
  await expect(page.locator(".message.assistant").last()).toContainText("HTTPS 已取消。", { timeout: 3_000 });
  expect(toolContent(calls, "host.network.fetch")).toContain('"nativeTerminalEventReceived":true');
  expect(Date.now() - revokedAt).toBeLessThan(3_000);
  await expect(page.locator(".tool-run").last()).toHaveAttribute("data-status", "completed");
  await expect(page.locator("#send")).toBeEnabled();
  expect(toolContent(calls, "host.network.fetch")).toContain('"cancelled":true');
  await delay(1_300);
  expect(bridge.effects.fetchAbortCalls).toBeGreaterThan(0);
  expect(bridge.effects.fetchLateChunk).toBe(false);
  await expect.poll(() => hasCancelledAudit(bridge.state, "net.http")).toBe(true);
});

test("browser revocation cancels and settles an active native timer", async ({ page, bridge }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await installGateway(page, "timer-long");
  await configureGateway(page); await createProject(page); await connect(page, bridge);
  const grant = await grantFromUi(page, "runtime.timers", '{}', "session"); await closeSettings(page);
  await page.locator("#intent").fill("[NATIVE:TIMER-CANCEL] 启动长计时器。"); await page.locator("#send").click();
  await expect(page.locator(".tool-run").last()).toHaveAttribute("data-status", "running");
  await page.locator("#settings-trigger").click();
  const grants = page.locator("#native-bridge-grants");
  await expect(grants).toContainText(grant.id.slice(0, 8));
  await grants.getByRole("button", { name: "撤销" }).click();
  await closeSettings(page);
  await expect(page.locator(".message.assistant").last()).toContainText("计时器已取消。", { timeout: 15_000 });
  const audit = await readFile(join(bridge.state, "audit.jsonl"), "utf8");
  expect(audit).toContain('"capability":"runtime.timers"');
  expect(audit).toContain('"decision":"cancelled"');
});

test("paired browser can revoke an unused scoped grant and keeps pairing material memory-only on reload", async ({ page, bridge }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await installGateway(page, "write");
  await configureGateway(page);
  await createProject(page);
  await connect(page, bridge);
  const grant = await grantFromUi(page, "host.fs.read", '{"rootId":"work","prefixes":["e2e"]}');
  const grants = page.locator("#native-bridge-grants");
  await expect(grants).toContainText(grant.id.slice(0, 8));
  await grants.getByRole("button", { name: "撤销" }).click();
  await expect(grants).toContainText("没有活动");
  await page.reload();
  await expect(page.locator("#native-bridge-status")).toContainText("未连接");
  await expect(page.locator("#native-bridge-code")).toHaveValue("");
});

async function startBridge(): Promise<BridgeFixture> {
  const base = await mkdtemp(join(tmpdir(), "browser-agent-native-e2e-"));
  const root = join(base, "root"); const state = join(base, "state");
  await mkdir(join(root, "e2e"), { recursive: true });
  await writeFile(join(root, "e2e", "seed.txt"), "seed\n");
  // The profile has a non-private HTTPS origin. The in-process transport is dependency
  // injection unavailable to the JSON-configured product daemon, so browser E2E is
  // hermetic without weakening the bridge's private-address production guard.
  const pairingCode = randomBytes(32).toString("base64url");
  const effects = { fetchAbortCalls: 0, fetchLateChunk: false, cancelledEndEvents: 0 };
  const delayedCommandEffect = join(root, "e2e", "command-after-cancel.txt");
  const bridge = await createNativeBridgeServer({
    allowedOrigins: [APP_ORIGIN], pairingCode, stateDirectory: state,
    roots: [{ id: "work", path: root, mode: "readwrite" }],
    commands: [{ id: "node-version", executable: process.execPath, args: ["--version"] }, { id: "streaming-node", executable: process.execPath, args: ["-e", "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 600)"] }, { id: "cancellable-node", executable: process.execPath, args: ["-e", `process.stdout.write('command-start\\n'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(delayedCommandEffect)}, 'late\\n'), 1000); setTimeout(() => process.exit(0), 1200)`] }],
    networkProfiles: [{ id: "hermetic-public", origin: "https://fixture.browser-agent.test", maxResponseBytes: 1024 }],
    testHttpsTransport: async ({ url, onChunk, registerAbort }) => new Promise((resolve) => {
      const cancellable = url.pathname === "/cancel";
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve({ status: 200, headers: { "content-type": "text/plain" }, body: "native fetch\\n", finalUrl: url.href }); } };
      onChunk(Buffer.from("native "));
      const timer = setTimeout(() => { if (cancellable) effects.fetchLateChunk = true; onChunk(Buffer.from("fetch\\n")); finish(); }, cancellable ? 1_000 : 120);
      registerAbort(() => { effects.fetchAbortCalls += 1; clearTimeout(timer); finish(); });
    }),
    testEventObserver: (event) => { if (event.kind === "operation.end" && event.payload.cancelled === true) effects.cancelledEndEvents += 1; }
  });
  await new Promise<void>((done, reject) => { bridge.server.once("error", reject); bridge.server.listen(0, "127.0.0.1", () => { bridge.server.off("error", reject); done(); }); });
  const address = bridge.server.address();
  const endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { endpoint, pairingCode, root, state, effects,
    async close(): Promise<void> { await bridge.close(); await rm(base, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); }
  };
}

async function installGateway(page: Page, mode: "write" | "fs-list-read" | "command" | "command-cancel" | "fs-mutations" | "dns" | "timer" | "stream" | "fetch" | "fetch-cancel" | "timer-long"): Promise<GatewayCall[]> {
  const calls: GatewayCall[] = [];
  await page.route("https://models.dev/api.json", (route) => route.fulfill({ json: {}, headers: { etag: '"native-e2e"' } }));
  await page.route("**/v1/models", (route) => route.fulfill({ json: { data: [{ id: "native-mock", name: "Native Mock", tool_call: true, input_modalities: ["text"], context_window: 128_000 }] } }));
  await page.route("**/v1/agent/turn", async (route) => {
    const call = route.request().postDataJSON() as GatewayCall; calls.push(call);
    const hasToolResult = call.messages.some((message) => message.role === "tool");
    const handle = (capability: string) => agentGrantHandle(call.messages, capability);
    const turn = hasToolResult
      ? { text: mode === "write" ? "宿主文件已写入。" : mode === "fs-list-read" ? "宿主文件已读取。" : mode === "command" ? "宿主命令已完成。" : mode === "fs-mutations" ? "宿主文件操作已完成。" : mode === "dns" ? "DNS 已查询。" : mode === "timer" ? "计时器已完成。" : mode === "fetch" ? "HTTPS 已获取。" : mode === "fetch-cancel" ? "HTTPS 已取消。" : mode === "timer-long" ? "计时器已取消。" : "流式宿主命令已完成。", toolCalls: [] }
      : mode === "write"
        ? tool("native-write", "host.fs.write", { grantHandle: handle("host.fs.write"), rootId: "work", path: "e2e/from-ui.txt", content: "native-e2e\n" })
        : mode === "fs-list-read"
          ? { text: "", toolCalls: [tool("native-list", "host.fs.list", { grantHandle: handle("host.fs.read"), rootId: "work", path: "e2e" }).toolCalls[0]!, tool("native-read", "host.fs.read", { grantHandle: handle("host.fs.read"), rootId: "work", path: "e2e/seed.txt" }).toolCalls[0]!] }
          : mode === "command"
            ? tool("native-command", "host.command.run", { grantHandle: handle("host.command.spawn"), commandId: "node-version", args: [] })
          : mode === "fs-mutations"
            ? { text: "", toolCalls: [tool("native-mkdir", "host.fs.mkdir", { grantHandle: handle("host.fs.write"), rootId: "work", path: "e2e/made" }).toolCalls[0]!, tool("native-move", "host.fs.move", { grantHandle: handle("host.fs.write"), rootId: "work", path: "e2e/seed.txt", to: "e2e/moved.txt" }).toolCalls[0]!, tool("native-delete", "host.fs.delete", { grantHandle: handle("host.fs.write"), rootId: "work", path: "e2e/made" }).toolCalls[0]!] }
            : mode === "dns"
              ? tool("native-dns", "host.dns.lookup", { grantHandle: handle("net.dns.lookup"), hostname: "localhost" })
              : mode === "timer"
                ? tool("native-timer", "host.timer.wait", { grantHandle: handle("runtime.timers"), durationMs: 20 })
                : mode === "fetch"
                  ? tool("native-fetch", "host.network.fetch", { grantHandle: handle("net.http"), profileId: "hermetic-public", path: "/stream" })
                  : mode === "fetch-cancel"
                    ? tool("native-fetch-cancel", "host.network.fetch", { grantHandle: handle("net.http"), profileId: "hermetic-public", path: "/cancel" })
                    : mode === "timer-long"
                    ? tool("native-timer-long", "host.timer.wait", { grantHandle: handle("runtime.timers"), durationMs: 5_000 })
                    : mode === "command-cancel"
                      ? tool("native-command-cancel", "host.command.run", { grantHandle: handle("host.command.spawn"), commandId: "cancellable-node", args: [] })
                      : tool("native-stream", "host.command.run", { grantHandle: handle("host.command.spawn"), commandId: "streaming-node", args: [] });
    if (hasToolResult && mode === "fetch-cancel") await delay(350);
    await route.fulfill(sseResponse(turn));
  });
  return calls;
}

async function configureGateway(page: Page): Promise<void> {
  await page.locator("#settings-trigger").click();
  await page.locator("#provider-mode").selectOption("gateway");
  await page.locator("#provider-url").fill(MOCK_GATEWAY);
  await page.locator("#model-name").fill("native-mock");
  await page.locator("#save-model").click();
  await expect(page.locator("#model-help")).toContainText("已保存");
  await closeSettings(page);
}

async function createProject(page: Page): Promise<void> {
  await page.locator("#new-project").click();
  await expect(page.locator("#connection-status")).toContainText("已连接");
}

async function connect(page: Page, bridge: BridgeFixture): Promise<void> {
  await page.locator("#settings-trigger").click();
  await page.locator("#native-bridge-endpoint").fill(bridge.endpoint);
  await page.locator("#native-bridge-code").fill(bridge.pairingCode);
  await page.locator("#native-bridge-connect").click();
  await expect(page.locator("#native-bridge-status")).toContainText("已连接");
  await expect(page.locator("#native-bridge-code")).toHaveValue("");
}

async function grantFromUi(page: Page, capability: string, scope: string, mode: "once" | "run" | "session" = "once"): Promise<{ id: string }> {
  await page.locator("#native-bridge-capability").selectOption(capability);
  await page.locator("#native-bridge-scope").fill(scope);
  await page.locator("#native-bridge-grant-mode").selectOption(mode);
  const response = page.waitForResponse((candidate) => candidate.url().endsWith("/v1/grants") && candidate.request().method() === "POST" && candidate.status() === 201);
  await page.locator("#native-bridge-grant").click();
  return (await response).json() as Promise<{ id: string }>;
}

async function closeSettings(page: Page): Promise<void> { await page.locator("#settings-dialog button[aria-label='关闭']").click(); }
async function runIntent(page: Page, intent: string, expected: string): Promise<void> {
  await page.locator("#intent").fill(intent); await page.locator("#send").click();
  await expect(page.locator(".message.assistant").last()).toContainText(expected);
  await expect(page.locator(".tool-run").last()).toHaveAttribute("data-status", "completed");
}
function agentGrantHandle(messages: ModelMessage[], capability: string): string {
  const system = messages.filter((message) => message.role === "system" && typeof message.content === "string").map((message) => message.content).join("\n");
  const match = system.match(new RegExp(`- (native-grant-[a-f0-9-]+)：${capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}，`));
  if (!match?.[1]) throw new Error(`Gateway did not receive an injected safe handle for ${capability}`);
  return match[1];
}
function tool(id: string, name: string, argumentsValue: Record<string, unknown>): GatewayTurn { return { text: "", toolCalls: [{ id, name, arguments: argumentsValue }] }; }
function toolContent(calls: GatewayCall[], name: string): string { return calls.flatMap((call) => call.messages).filter((message) => message.role === "tool" && message.name === name).map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n"); }
function sseResponse(turn: GatewayTurn): { status: number; contentType: string; body: string } { return { status: 200, contentType: "text/event-stream; charset=utf-8", body: [...(turn.text ? [{ type: "text-delta", delta: turn.text }] : []), { type: "turn-complete", response: turn }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") }; }
async function hasCancelledAudit(state: string, capability: string): Promise<boolean> {
  try { return (await readFile(join(state, "audit.jsonl"), "utf8")).split("\n").some((line) => { const record = line ? JSON.parse(line) as { capability?: unknown; decision?: unknown } : undefined; return record?.capability === capability && record.decision === "cancelled"; }); }
  catch { return false; }
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
