import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNativeBridgeServer } from "../apps/native-bridge/src/bridge-server";

const ORIGIN = "http://localhost:5173";
const CODE = "a".repeat(43); // base64url representation of 256 bits
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ba-native-")); await writeFile(join(root, "safe.txt"), "safe");
  const bridge = await createNativeBridgeServer({ allowedOrigins: [ORIGIN], pairingCode: CODE, roots: [{ id: "work", path: root, nickname: "Work", mode: "readwrite" }], commands: [{ id: "node-version", executable: process.execPath, args: ["--version"] }], stateDirectory: join(root, "state") });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { await new Promise<void>((done, reject) => { const port = 43_000 + Math.floor(Math.random() * 10_000); bridge.server.once("error", reject); bridge.server.listen(port, "127.0.0.1", () => { bridge.server.off("error", reject); done(); }); }); break; }
    catch (error) { if (attempt === 9) throw error; }
  } const address = bridge.server.address(); const endpoint = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { root, bridge, endpoint };
}
async function pair(endpoint: string) { const response = await fetch(`${endpoint}/v1/pair`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ protocol: "ba-native/1", origin: ORIGIN, clientInstanceId: "client_instance_123", pairingCode: CODE }) }); assert.equal(response.status, 200); return response.json() as Promise<{ sessionToken: string }>; }
function authenticated(endpoint: string, token: string) { let sequence = 0; return async (path: string, body?: unknown) => fetch(`${endpoint}${path}`, { method: "POST", headers: { Origin: ORIGIN, Authorization: `Bearer ${token}`, "X-BA-Sequence": String(++sequence), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }

test("native bridge is origin-pinned, pairing is one-time, and unauthenticated status stays closed", async () => {
  const { bridge, endpoint } = await fixture();
  try {
    assert.equal((await fetch(`${endpoint}/v1/bridge/status`)).status, 403);
    assert.equal((await fetch(`${endpoint}/v1/pair`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
    const session = await pair(endpoint);
    assert.equal((await fetch(`${endpoint}/v1/pair`, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ protocol: "ba-native/1", origin: ORIGIN, clientInstanceId: "client_instance_456", pairingCode: CODE }) })).status, 401);
    const status = await fetch(`${endpoint}/v1/bridge/status`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${session.sessionToken}`, "X-BA-Sequence": "1" } });
    assert.equal(status.status, 200);
    const capabilities = (await status.json() as { capabilities: Array<{ capability: string; available: boolean }> }).capabilities;
    assert.equal(capabilities.find((item) => item.capability === "browser.dom")?.available, false);
    assert.equal(capabilities.find((item) => item.capability === "browser.worker")?.available, false);
    assert.equal(capabilities.find((item) => item.capability === "browser.storage")?.available, false);
  } finally { await bridge.close(); }
});

test("native bridge enforces scoped filesystem grants and rejects traversal and symlink escapes", async () => {
  const { root, bridge, endpoint } = await fixture();
  try {
    const session = await pair(endpoint); const call = authenticated(endpoint, session.sessionToken);
    const denied = await call("/v1/fs/read", { rootId: "work", path: "safe.txt" }); assert.equal(denied.status, 403);
    assert.equal((await call("/v1/grants", { capability: "host.fs.read", scope: { rootId: "work" }, mode: "project", projectId: "project-a" })).status, 400);
    const grantResponse = await call("/v1/grants", { capability: "host.fs.read", scope: { rootId: "work", prefixes: ["allowed"] }, mode: "session" }); const grant = await grantResponse.json() as { id: string };
    assert.equal((await call("/v1/fs/read", { grantId: grant.id, rootId: "work", path: "../safe.txt" })).status, 403);
    assert.equal((await call("/v1/fs/read", { grantId: grant.id, rootId: "work", path: "safe.txt" })).status, 403);
    await mkdir(join(root, "allowed")); await writeFile(join(root, "allowed", "x.txt"), "ok");
    assert.equal((await call("/v1/fs/read", { grantId: grant.id, rootId: "work", path: "allowed/x.txt" })).status, 200);
    await symlink(tmpdir(), join(root, "allowed", "escape"));
    assert.equal((await call("/v1/fs/read", { grantId: grant.id, rootId: "work", path: "allowed/escape/anything" })).status, 403);
    assert.equal((await call("/v1/fs/read", { grantId: grant.id, rootId: "work", path: "allowed/escape%5canything" })).status, 400);
  } finally { await bridge.close(); }
});

test("native bridge completes scoped mkdir, move, delete, DNS, and timer operations with audit records", async () => {
  const { root, bridge, endpoint } = await fixture();
  try {
    const session = await pair(endpoint); const call = authenticated(endpoint, session.sessionToken);
    const writeGrant = await (await call("/v1/grants", { capability: "host.fs.write", scope: { rootId: "work", prefixes: ["ops"], rename: true, delete: true }, mode: "session" })).json() as { id: string };
    assert.equal((await call("/v1/fs/mkdir", { grantId: writeGrant.id, rootId: "work", path: "ops" })).status, 200);
    assert.equal((await call("/v1/fs/write", { grantId: writeGrant.id, rootId: "work", path: "ops/source.txt", content: "move me" })).status, 200);
    assert.equal((await call("/v1/fs/move", { grantId: writeGrant.id, rootId: "work", path: "ops/source.txt", to: "ops/moved.txt" })).status, 200);
    assert.equal(await readFile(join(root, "ops", "moved.txt"), "utf8"), "move me");
    assert.equal((await call("/v1/fs/delete", { grantId: writeGrant.id, rootId: "work", path: "ops/moved.txt" })).status, 200);
    const dnsGrant = await (await call("/v1/grants", { capability: "net.dns.lookup", scope: { suffixes: ["localhost"] }, mode: "once" })).json() as { id: string };
    assert.equal((await call("/v1/dns/lookup", { grantId: dnsGrant.id, hostname: "localhost" })).status, 200);
    const timerGrant = await (await call("/v1/grants", { capability: "runtime.timers", scope: {}, mode: "once" })).json() as { id: string };
    const timer = await call("/v1/timers/wait", { grantId: timerGrant.id, durationMs: 1 });
    assert.equal(timer.status, 200); assert.equal((await timer.json() as { cancelled: boolean }).cancelled, false);
    const journal = await readFile(join(root, "state", "audit.jsonl"), "utf8");
    for (const capability of ["host.fs.write", "net.dns.lookup", "runtime.timers"]) assert.match(journal, new RegExp(capability.replace(".", "\\.")));
  } finally { await bridge.close(); }
});

test("cancelling or revoking a native timer clears it and settles the pending wait", async () => {
  const { root, bridge, endpoint } = await fixture();
  try {
    const session = await pair(endpoint); const call = authenticated(endpoint, session.sessionToken);
    const grant = await (await call("/v1/grants", { capability: "runtime.timers", scope: {}, mode: "session" })).json() as { id: string };
    const operationId = "timer_cancel_123";
    const started = Date.now();
    const pending = call("/v1/timers/wait", { grantId: grant.id, durationMs: 5_000, operationId });
    await new Promise((done) => setTimeout(done, 25));
    assert.equal((await call("/v1/operations/cancel", { operationId })).status, 200);
    const cancelled = await pending;
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { cancelled: boolean }).cancelled, true);
    assert.ok(Date.now() - started < 1_000, "cancellation should not leave the 5s native timer alive");

    const revokedGrant = await (await call("/v1/grants", { capability: "runtime.timers", scope: {}, mode: "session" })).json() as { id: string };
    const revokedOperation = "timer_revoke_123";
    const waiting = call("/v1/timers/wait", { grantId: revokedGrant.id, durationMs: 5_000, operationId: revokedOperation });
    await new Promise((done) => setTimeout(done, 25));
    assert.equal((await call("/v1/grants/revoke", { id: revokedGrant.id })).status, 200);
    const revoked = await waiting;
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json() as { cancelled: boolean }).cancelled, true);
    const journal = await readFile(join(root, "state", "audit.jsonl"), "utf8");
    assert.match(journal, /"decision":"cancelled"/);
  } finally { await bridge.close(); }
});

test("command execution is template-only, shell-free, audited, and revocation removes grants", async () => {
  const { root, bridge, endpoint } = await fixture();
  try {
    const session = await pair(endpoint); const call = authenticated(endpoint, session.sessionToken);
    const created = await call("/v1/grants", { capability: "host.command.spawn", scope: { commandIds: ["node-version"] }, mode: "session" }); const grant = await created.json() as { id: string };
    const run = await call("/v1/process/run", { grantId: grant.id, commandId: "node-version", args: ["; whoami"] }); assert.equal(run.status, 400);
    const valid = await call("/v1/process/run", { grantId: grant.id, commandId: "node-version" }); assert.equal(valid.status, 200); assert.match((await valid.json() as { stdout: string }).stdout, /^v/);
    assert.equal((await call("/v1/grants/revoke", { id: grant.id })).status, 200);
    assert.equal((await call("/v1/process/run", { grantId: grant.id, commandId: "node-version" })).status, 403);
    const journal = await readFile(join(root, "state", "audit.jsonl"), "utf8"); assert.match(journal, /host.command.spawn/); assert.doesNotMatch(journal, /whoami/);
  } finally { await bridge.close(); }
});
