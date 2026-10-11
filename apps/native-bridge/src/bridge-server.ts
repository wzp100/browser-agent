import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { NATIVE_BRIDGE_PROTOCOL, isNativeCapability, type BridgeEvent, type BridgePairRequest, type CapabilityDescriptor, type CapabilityGrant, type CapabilityGrantRequest, type HostRootDescriptor, type NativeAuditRecord } from "../../../packages/native-bridge-contracts/src/index";

export interface NativeRootConfig { id: string; path: string; nickname?: string; mode?: "read" | "readwrite"; }
export interface NativeCommandConfig { id: string; executable: string; args?: string[]; cwdRootId?: string; argumentPatterns?: string[]; maxDurationMs?: number; }
export interface NativeNetworkProfile { id: string; origin: string; methods?: ("GET" | "HEAD")[]; maxResponseBytes?: number; }
/** Test-only dependency injection. The CLI accepts JSON and therefore cannot configure this transport. */
export type NativeHttpsTestTransport = (request: {
  url: URL; method: "GET" | "HEAD"; maxBytes: number; onChunk: (chunk: Buffer) => void; registerAbort: (abort: () => void) => void;
}) => Promise<{ status: number; headers: Record<string, string>; body: string; finalUrl?: string }>;
/** Test-only observability of emitted SSE frames; unavailable to JSON daemon configuration. */
export type NativeBridgeTestEventObserver = (event: BridgeEvent) => void;
export interface NativeBridgeConfig {
  allowedOrigins: string[]; pairingCode: string; pairingExpiresAt?: number; stateDirectory?: string;
  roots?: NativeRootConfig[]; commands?: NativeCommandConfig[]; networkProfiles?: NativeNetworkProfile[];
  sandboxAvailable?: boolean; maxBodyBytes?: number; sessionTtlMs?: number;
  /** Injectable only by in-process tests; never loaded from the native bridge JSON configuration. */
  testHttpsTransport?: NativeHttpsTestTransport;
  /** Injectable only by in-process tests; never loaded from the native bridge JSON configuration. */
  testEventObserver?: NativeBridgeTestEventObserver;
}
interface Root extends NativeRootConfig { canonical: string; nickname: string; mode: "read" | "readwrite"; }
interface Session { token: string; origin: string; connectionId: string; expiresAt: number; sequence: number; eventSequence: number; grants: Map<string, CapabilityGrant>; events: Set<ServerResponse>; }
interface Operation { child?: ChildProcess; abort?: () => void; cancelled: boolean; capability: string; grantId: string; }
const MAX_CONTROL_BYTES = 1024 * 1024;
const forbiddenExecutables = new Set(["cmd.exe", "command.com", "powershell.exe", "pwsh", "bash", "sh", "dash", "ash", "ksh", "mksh", "csh", "tcsh", "zsh", "fish", "busybox", "nu", "elvish"]);

/** Injectable, loopback-only bridge. It deliberately has no unauthenticated status endpoint. */
export async function createNativeBridgeServer(config: NativeBridgeConfig): Promise<{ server: Server; close(): Promise<void>; status(): { port?: number; fingerprint: string; pairingExpiresAt: string }; }> {
  if (!config.allowedOrigins.length || config.allowedOrigins.some((origin) => origin === "*" || !isExactOrigin(origin))) throw new Error("Native bridge requires one or more exact allowed origins.");
  if (!config.pairingCode || Buffer.from(config.pairingCode).byteLength < 32) throw new Error("Pairing code must contain at least 256 bits of entropy.");
  const roots: Root[] = [];
  for (const candidate of config.roots ?? []) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(candidate.id)) throw new Error(`Invalid root id: ${candidate.id}`);
    const canonical = await fs.realpath(candidate.path);
    const stat = await fs.stat(canonical); if (!stat.isDirectory()) throw new Error(`Root is not a directory: ${candidate.id}`);
    roots.push({ ...candidate, canonical, nickname: candidate.nickname ?? candidate.id, mode: candidate.mode ?? "read" });
  }
  const commands = new Map((config.commands ?? []).map((command) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(command.id) || !isAbsolute(command.executable) || forbiddenExecutables.has(basename(command.executable).toLowerCase())) throw new Error(`Unsafe command configuration: ${command.id}`);
    return [command.id, command];
  }));
  const profiles = new Map((config.networkProfiles ?? []).map((profile) => {
    const url = new URL(profile.origin); if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) throw new Error(`Network profile must be an exact HTTPS origin: ${profile.id}`);
    return [profile.id, profile];
  }));
  const fingerprint = sha256(`${process.execPath}:${process.platform}:${roots.map((root) => root.id).join(",")}`).slice(0, 24);
  let pairingCode = config.pairingCode;
  const pairingExpiresAt = config.pairingExpiresAt ?? Date.now() + 5 * 60_000;
  const sessions = new Map<string, Session>(); const operations = new Map<string, Operation>();
  let auditTail = "";
  const stateDirectory = config.stateDirectory ?? resolve(homedir(), ".browser-agent-native");
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const capabilities = (): CapabilityDescriptor[] => [
    { capability: "host.fs.read", available: roots.length > 0 }, ...(roots.some((root) => root.mode === "readwrite") ? [{ capability: "host.fs.write" as const, available: true }] : [{ capability: "host.fs.write" as const, available: false, reason: "No read/write root configured" }]),
    { capability: "host.command.spawn", available: commands.size > 0 }, { capability: "net.http", available: profiles.size > 0 }, { capability: "net.dns.lookup", available: true, limits: { maxAnswers: 20 } },
    { capability: "runtime.timers", available: true, limits: { maxDurationMs: 60_000 } },
    ...(commands.size || profiles.size ? [{ capability: "runtime.streams" as const, available: true, limits: { maxBufferedBytes: 1_000_000 } }] : [{ capability: "runtime.streams" as const, available: false, reason: "No streamed command or HTTPS profile configured" }]),
    { capability: "extension.invoke", available: false, reason: config.sandboxAvailable ? "No signed extension runner configured" : "OS sandbox unavailable; extensions are disabled" },
    // Adapter helpers are deliberately not agent/product tools: never advertise app DOM,
    // arbitrary Worker code, or browser cache storage as a bridge capability.
    { capability: "browser.dom", available: false, reason: "Application DOM is not exposed to agents" }, { capability: "browser.worker", available: false, reason: "No product worker execution tool is exposed" }, { capability: "browser.storage", available: false, reason: "No product browser storage tool is exposed" }
  ];
  const emit = (session: Session, event: Omit<BridgeEvent, "sequence">): void => {
    const wire = { ...event, sequence: ++session.eventSequence }; const line = `data: ${JSON.stringify(wire)}\n\n`;
    try { config.testEventObserver?.(wire); } catch { /* test observer never affects daemon behavior */ }
    for (const response of session.events) response.write(line);
  };
  const audit = async (session: Session, values: Omit<NativeAuditRecord, "id" | "previousHash" | "at" | "connectionId" | "parameterDigest"> & { parameters?: unknown }): Promise<void> => {
    const record: NativeAuditRecord = { id: crypto.randomUUID(), previousHash: auditTail, at: new Date().toISOString(), connectionId: session.connectionId, parameterDigest: sha256(JSON.stringify(redact(values.parameters))), ...withoutParameters(values) };
    auditTail = sha256(JSON.stringify(record));
    await fs.appendFile(resolve(stateDirectory, "audit.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    emit(session, { kind: "audit", payload: { capability: record.capability, decision: record.decision, targetSummary: record.targetSummary, operationId: record.operationId } });
  };
  const authorize = async (request: IncomingMessage, response: ServerResponse): Promise<Session | undefined> => {
    if (!loopbackHost(request.headers.host)) { send(response, 403, { error: "Host denied" }); return; }
    const origin = request.headers.origin; if (!origin || !config.allowedOrigins.includes(origin)) { send(response, 403, { error: "Origin denied" }); return; }
    const auth = request.headers.authorization; const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    const session = [...sessions.values()].find((item) => equal(item.token, token));
    if (!session || session.origin !== origin || session.expiresAt < Date.now()) { send(response, 401, { error: "Authentication required" }); return; }
    const sequence = Number(request.headers["x-ba-sequence"]); if (!Number.isSafeInteger(sequence) || sequence <= session.sequence) { send(response, 409, { error: "Invalid request sequence" }); return; }
    session.sequence = sequence; return session;
  };
  const requireGrant = async (session: Session, response: ServerResponse, id: unknown, capability: string): Promise<CapabilityGrant | undefined> => {
    const grant = typeof id === "string" ? session.grants.get(id) : undefined;
    if (!grant || grant.expiresAt <= new Date().toISOString() || grant.capability !== capability) { await audit(session, { capability: capability as CapabilityGrant["capability"], decision: "denied", targetSummary: "grant", errorCode: "GRANT_DENIED", parameters: { id } }); send(response, 403, { error: "A current scoped grant is required" }); return; }
    if (grant.mode === "once") session.grants.delete(grant.id);
    return grant;
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.origin && config.allowedOrigins.includes(request.headers.origin) && loopbackHost(request.headers.host)) { response.setHeader("Access-Control-Allow-Origin", request.headers.origin); response.setHeader("Vary", "Origin"); }
      if (!request.url) return send(response, 400, { error: "Missing URL" });
      const url = new URL(request.url, "http://bridge.invalid");
      if (request.method === "OPTIONS") return preflight(request, response, config.allowedOrigins);
      if (request.method === "POST" && url.pathname === "/v1/pair") {
        if (!loopbackHost(request.headers.host) || !request.headers.origin || !config.allowedOrigins.includes(request.headers.origin)) return send(response, 403, { error: "Origin denied" });
        const body = await readJson<BridgePairRequest>(request);
        if (Date.now() > pairingExpiresAt || !pairingCode || body.protocol !== NATIVE_BRIDGE_PROTOCOL || body.origin !== request.headers.origin || !validId(body.clientInstanceId) || !equal(pairingCode, body.pairingCode)) return send(response, 401, { error: "Pairing denied" });
        pairingCode = ""; const token = randomBytes(32).toString("base64url"); const session: Session = { token, origin: body.origin, connectionId: crypto.randomUUID(), expiresAt: Date.now() + (config.sessionTtlMs ?? 30 * 60_000), sequence: 0, eventSequence: 0, grants: new Map(), events: new Set() }; sessions.set(session.connectionId, session);
        return send(response, 200, { protocol: NATIVE_BRIDGE_PROTOCOL, connectionId: session.connectionId, sessionToken: token, expiresAt: new Date(session.expiresAt).toISOString(), fingerprint, capabilities: capabilities(), policyHash: sha256(JSON.stringify({ roots: roots.map(({ id, mode }) => ({ id, mode })), commands: [...commands.keys()], profiles: [...profiles.keys()] })) });
      }
      const session = await authorize(request, response); if (!session) return;
      if (request.method === "GET" && url.pathname === "/v1/bridge/status") return send(response, 200, { bridgeId: "browser-agent-native-bridge", version: "1", fingerprint, sandboxAvailable: config.sandboxAvailable === true, capabilities: capabilities(), grants: [...session.grants.values()], roots: roots.map(({ id, nickname, mode }): HostRootDescriptor => ({ id, nickname, mode })) });
      if (request.method === "GET" && url.pathname === "/v1/bridge/events") { response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" }); response.write(": connected\n\n"); session.events.add(response); request.on("close", () => session.events.delete(response)); return; }
      if (request.method === "POST" && url.pathname === "/v1/grants") { const body = await readJson<CapabilityGrantRequest>(request); if (body.mode === "project") return send(response, 400, { error: "Project grants are not supported without a trusted project binding" }); if (!isNativeCapability(body.capability) || !canGrant(body.capability, body.scope, roots, commands, profiles)) return send(response, 400, { error: "Requested scope exceeds host policy" }); const grant: CapabilityGrant = { id: crypto.randomUUID(), ...(body.projectId ? { projectId: body.projectId } : {}), capability: body.capability, scope: body.scope, mode: body.mode ?? "once", expiresAt: safeExpiry(body.expiresAt, body.mode), issuedBy: "user", policyVersion: 1 }; session.grants.set(grant.id, grant); await audit(session, { ...(grant.projectId ? { projectId: grant.projectId } : {}), grantId: grant.id, capability: grant.capability, decision: "allowed", targetSummary: "grant", parameters: grant.scope }); return send(response, 201, grant); }
      if (request.method === "POST" && url.pathname === "/v1/grants/revoke") { const body = await readJson<{ id?: string }>(request); if (typeof body.id !== "string") return send(response, 400, { error: "grant id required" }); const grant = session.grants.get(body.id); session.grants.delete(body.id); for (const [id, operation] of operations) if (operation.grantId === body.id) { cancelOperation(operation); operations.delete(id); } emit(session, { kind: "grant.revoked", payload: { id: body.id } }); if (grant) await audit(session, { grantId: body.id, capability: grant.capability, decision: "cancelled", targetSummary: "grant", parameters: {} }); return send(response, 200, { ok: true }); }
      if (request.method === "POST" && url.pathname === "/v1/operations/cancel") { const body = await readJson<{ operationId?: string }>(request); const operation = typeof body.operationId === "string" ? operations.get(body.operationId) : undefined; if (operation) { cancelOperation(operation); operations.delete(body.operationId!); } return send(response, 200, { ok: true }); }
      if (request.method === "POST" && url.pathname.startsWith("/v1/fs/")) return await handleFs(url.pathname, request, response, session, roots, requireGrant, audit);
      if (request.method === "POST" && url.pathname === "/v1/process/run") return await handleProcess(request, response, session, commands, roots, operations, requireGrant, audit, emit);
      if (request.method === "POST" && url.pathname === "/v1/network/fetch") return await handleFetch(request, response, session, profiles, operations, requireGrant, audit, emit, config.testHttpsTransport);
      if (request.method === "POST" && url.pathname === "/v1/dns/lookup") return await handleDns(request, response, session, requireGrant, audit);
      if (request.method === "POST" && url.pathname === "/v1/timers/wait") return await handleTimer(request, response, session, operations, requireGrant, audit, emit);
      return send(response, 404, { error: "Not found" });
    } catch (error) { send(response, error instanceof BridgeHttpError ? error.status : 500, { error: error instanceof Error ? error.message : "Bridge error" }); }
  });
  return { server, close: async () => { for (const session of sessions.values()) for (const response of session.events) response.end(); await new Promise<void>((done) => server.close(() => done())); }, status: () => ({ fingerprint, pairingExpiresAt: new Date(pairingExpiresAt).toISOString() }) };
}

async function handleFs(pathname: string, request: IncomingMessage, response: ServerResponse, session: Session, roots: Root[], requireGrant: any, audit: any): Promise<void> {
  const body = await readJson<{ grantId?: string; rootId?: string; path?: string; to?: string; content?: string }>(request); const write = !["/v1/fs/list", "/v1/fs/read"].includes(pathname); const grant = await requireGrant(session, response, body.grantId, write ? "host.fs.write" : "host.fs.read"); if (!grant) return;
  const root = rootFor(roots, body.rootId); ensureScope(grant.scope, root.id, body.path); const target = await safeTarget(root, body.path ?? "");
  if (write && root.mode !== "readwrite") throw new BridgeHttpError(403, "Root is read-only");
  if (pathname === "/v1/fs/list") { const items = await fs.readdir(target, { withFileTypes: true }); const result = items.filter((item) => ![".git", ".browser-agent"].includes(item.name)).slice(0, 1000).map((item) => ({ name: item.name, kind: item.isDirectory() ? "directory" : "file" })); await audit(session, { grantId: grant.id, capability: grant.capability, decision: "completed", targetSummary: root.nickname, parameters: { path: body.path } }); return send(response, 200, result); }
  if (pathname === "/v1/fs/read") { const data = await fs.readFile(target); if (data.length > 1_000_000) throw new BridgeHttpError(413, "File exceeds read limit"); await audit(session, { grantId: grant.id, capability: grant.capability, decision: "completed", targetSummary: root.nickname, byteCounts: { in: data.length, out: data.length }, parameters: { path: body.path } }); return send(response, 200, { content: data.toString("utf8") }); }
  if (pathname === "/v1/fs/write") { if (typeof body.content !== "string" || Buffer.byteLength(body.content) > 1_000_000) throw new BridgeHttpError(400, "Invalid or oversized content"); await fs.mkdir(resolve(target, ".."), { recursive: true }); await fs.writeFile(target, body.content, { flag: "w", mode: 0o600 }); await audit(session, { grantId: grant.id, capability: grant.capability, decision: "completed", targetSummary: root.nickname, byteCounts: { in: Buffer.byteLength(body.content), out: 0 }, parameters: { path: body.path } }); return send(response, 200, { ok: true }); }
  if (pathname === "/v1/fs/mkdir") { await fs.mkdir(target, { recursive: false, mode: 0o700 }); await audit(session, { grantId: grant.id, capability: grant.capability, decision: "completed", targetSummary: root.nickname, parameters: { path: body.path } }); return send(response, 200, { ok: true }); }
  if (pathname === "/v1/fs/delete") { if (grant.scope.delete !== true) throw new BridgeHttpError(403, "Grant does not allow deletion"); const stat = await fs.lstat(target); if (stat.isDirectory()) await fs.rmdir(target); else await fs.unlink(target); await audit(session, { grantId: grant.id, capability: grant.capability, decision: "completed", targetSummary: root.nickname, parameters: { path: body.path } }); return send(response, 200, { ok: true }); }
  if (pathname === "/v1/fs/move") { if (grant.scope.rename !== true) throw new BridgeHttpError(403, "Grant does not allow rename"); const to = await safeTarget(root, body.to ?? ""); ensureScope(grant.scope, root.id, body.to); await fs.rename(target, to); await audit(session, { grantId: grant.id, capability: grant.capability, decision: "completed", targetSummary: root.nickname, parameters: { path: body.path, to: body.to } }); return send(response, 200, { ok: true }); }
  throw new BridgeHttpError(404, "Unknown filesystem operation");
}

async function handleProcess(request: IncomingMessage, response: ServerResponse, session: Session, commands: Map<string, NativeCommandConfig>, roots: Root[], operations: Map<string, Operation>, requireGrant: any, audit: any, emit: any): Promise<void> {
  const body = await readJson<{ grantId?: string; commandId?: string; args?: string[]; timeoutMs?: number; runId?: string; operationId?: string }>(request); const grant = await requireGrant(session, response, body.grantId, "host.command.spawn"); if (!grant) return; const command = typeof body.commandId === "string" ? commands.get(body.commandId) : undefined; if (!command || !scopeAllows(grant.scope.commandIds, command.id)) throw new BridgeHttpError(403, "Command is not granted");
  const supplied = Array.isArray(body.args) ? body.args : []; if (!supplied.every((arg) => typeof arg === "string" && arg.length <= 1000) || supplied.length > (command.argumentPatterns?.length ?? 0)) throw new BridgeHttpError(400, "Arguments do not match command schema");
  for (let index = 0; index < supplied.length; index += 1) if (!new RegExp(`^(?:${command.argumentPatterns?.[index] ?? "(?!)"})$`).test(supplied[index]!)) throw new BridgeHttpError(400, "Arguments do not match command schema");
  const cwd = command.cwdRootId ? rootFor(roots, command.cwdRootId).canonical : undefined; const operationId = typeof body.operationId === "string" && validId(body.operationId) && !operations.has(body.operationId) ? body.operationId : crypto.randomUUID(); const operation: Operation = { capability: grant.capability, grantId: grant.id, cancelled: false }; operations.set(operationId, operation); const child = spawn(command.executable, [...(command.args ?? []), ...supplied], { cwd, shell: false, detached: process.platform !== "win32", env: { LANG: "C", LC_ALL: "C" }, windowsHide: true }); operation.child = child;
  let stdout = "", stderr = "", bytes = 0, truncated = false; const append = (channel: "stdout" | "stderr", chunk: Buffer) => { bytes += chunk.length; if (bytes > 1_000_000) { truncated = true; kill(child); return; } const data = chunk.toString("utf8"); if (channel === "stdout") stdout += data; else stderr += data; emit(session, { operationId, kind: "stream.chunk", payload: { stream: channel, data, offset: bytes - chunk.length } }); }; child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk)); child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  const timeout = setTimeout(() => kill(child), Math.min(Math.max(body.timeoutMs ?? command.maxDurationMs ?? 30_000, 1), command.maxDurationMs ?? 60_000));
  const exitCode = await new Promise<number>((done, reject) => { child.once("error", reject); child.once("close", (code) => done(code ?? -1)); }).finally(() => clearTimeout(timeout)); operations.delete(operationId); const decision = operation.cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed"; await audit(session, { runId: body.runId, operationId, grantId: grant.id, capability: grant.capability, decision, targetSummary: command.id, byteCounts: { in: 0, out: bytes }, exitCode, parameters: { commandId: command.id, args: supplied } }); emit(session, { operationId, kind: "operation.end", payload: { exitCode, cancelled: operation.cancelled } }); return send(response, 200, { operationId, exitCode, stdout, stderr, ...(truncated ? { truncated } : {}) });
}

async function handleFetch(request: IncomingMessage, response: ServerResponse, session: Session, profiles: Map<string, NativeNetworkProfile>, operations: Map<string, Operation>, requireGrant: any, audit: any, emit: any, testTransport?: NativeHttpsTestTransport): Promise<void> {
  const body = await readJson<{ grantId?: string; profileId?: string; path?: string; method?: "GET" | "HEAD"; operationId?: string }>(request); const grant = await requireGrant(session, response, body.grantId, "net.http"); if (!grant) return; const profile = typeof body.profileId === "string" ? profiles.get(body.profileId) : undefined; if (!profile || !scopeAllows(grant.scope.profileIds, profile.id)) throw new BridgeHttpError(403, "Network profile is not granted"); const base = new URL(profile.origin); const target = new URL(body.path ?? "/", base); if (target.origin !== base.origin || target.username || target.password) throw new BridgeHttpError(400, "Target escapes network profile"); const method = body.method ?? "GET"; if (!(profile.methods ?? ["GET", "HEAD"]).includes(method)) throw new BridgeHttpError(405, "Method denied"); const operationId = typeof body.operationId === "string" && validId(body.operationId) && !operations.has(body.operationId) ? body.operationId : crypto.randomUUID(); const operation: Operation = { capability: grant.capability, grantId: grant.id, cancelled: false }; operations.set(operationId, operation);
  try { const onChunk = (chunk: Buffer) => emit(session, { operationId, kind: "stream.chunk", payload: { stream: "body", data: chunk.toString("base64") } }); const registerAbort = (abort: () => void) => { operation.abort = abort; }; const result = testTransport
    ? await testTransport({ url: target, method, maxBytes: profile.maxResponseBytes ?? 1_000_000, onChunk, registerAbort })
    : await secureHttps(target, method, profile.maxResponseBytes ?? 1_000_000, onChunk, registerAbort);
    if (operation.cancelled) throw new BridgeHttpError(499, "Network operation cancelled"); await audit(session, { operationId, grantId: grant.id, capability: grant.capability, decision: "completed", targetSummary: target.host, byteCounts: { in: 0, out: Buffer.byteLength(result.body) }, parameters: { profileId: profile.id, path: body.path } }); emit(session, { operationId, kind: "operation.end", payload: { cancelled: false, status: result.status } }); return send(response, 200, { operationId, ...result });
  } catch (error) {
    // A cancellation may reject the HTTPS request (production) or resolve a test transport
    // after its abort hook fires. In both cases it is a terminal, auditable operation state.
    const cancelled = operation.cancelled || error instanceof BridgeHttpError && error.status === 499;
    if (cancelled) {
      await audit(session, { operationId, grantId: grant.id, capability: grant.capability, decision: "cancelled", targetSummary: target.host, parameters: { profileId: profile.id, path: body.path } });
      emit(session, { operationId, kind: "operation.end", payload: { cancelled: true } });
      // Keep the host tool call settled rather than turning a user revocation into a
      // transport exception. The explicit cancellation result lets the agent complete
      // its prompt and avoids retrying the revoked network operation.
      return send(response, 200, { operationId, status: 499, headers: {}, body: "", finalUrl: target.href, cancelled: true });
    }
    throw error;
  } finally { operations.delete(operationId); }
}
async function handleDns(request: IncomingMessage, response: ServerResponse, session: Session, requireGrant: any, audit: any): Promise<void> { const body = await readJson<{ grantId?: string; hostname?: string }>(request); const grant = await requireGrant(session, response, body.grantId, "net.dns.lookup"); if (!grant) return; if (typeof body.hostname !== "string" || !allowedSuffix(body.hostname, grant.scope.suffixes)) throw new BridgeHttpError(403, "Hostname is not granted"); const answers = (await lookup(body.hostname, { all: true, verbatim: true })).filter((answer) => !privateAddress(answer.address)).slice(0, 20); await audit(session, { grantId: grant.id, capability: grant.capability, decision: "completed", targetSummary: body.hostname, parameters: {} }); send(response, 200, { answers }); }
async function handleTimer(request: IncomingMessage, response: ServerResponse, session: Session, operations: Map<string, Operation>, requireGrant: any, audit: any, emit: any): Promise<void> { const body = await readJson<{ grantId?: string; durationMs?: number; operationId?: string }>(request); const grant = await requireGrant(session, response, body.grantId, "runtime.timers"); if (!grant) return; const duration = Math.min(Math.max(Number(body.durationMs) || 0, 0), 60_000); const operationId = typeof body.operationId === "string" && validId(body.operationId) && !operations.has(body.operationId) ? body.operationId : crypto.randomUUID(); const operation: Operation = { capability: grant.capability, grantId: grant.id, cancelled: false }; operations.set(operationId, operation);
  // Cancellation must clear the native timeout *and* settle the pending request. Merely
  // flipping cancelled left a live timer behind until its original deadline.
  await new Promise<void>((done) => { const timeout = setTimeout(done, duration); operation.abort = () => { clearTimeout(timeout); done(); }; });
  operations.delete(operationId); await audit(session, { operationId, grantId: grant.id, capability: grant.capability, decision: operation.cancelled ? "cancelled" : "completed", targetSummary: "timer", parameters: { duration } }); emit(session, { operationId, kind: "operation.end", payload: { cancelled: operation.cancelled } }); send(response, 200, { operationId, cancelled: operation.cancelled }); }

async function secureHttps(url: URL, method: "GET" | "HEAD", maxBytes: number, onChunk: (chunk: Buffer) => void, registerAbort: (abort: () => void) => void): Promise<{ status: number; headers: Record<string, string>; body: string; finalUrl: string }> { const addresses = await lookup(url.hostname, { all: true, verbatim: true }); if (!addresses.length || addresses.some((item) => privateAddress(item.address))) throw new BridgeHttpError(403, "Network target resolves to a prohibited address"); const chosen = addresses[0]!; return new Promise((resolvePromise, reject) => { let settled = false; const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } }; const succeed = (value: { status: number; headers: Record<string, string>; body: string; finalUrl: string }) => { if (!settled) { settled = true; resolvePromise(value); } }; const request = httpsRequest(url, { method, headers: { Accept: "text/plain, text/*, application/json, application/xml" }, lookup: (_host, _opts, callback) => callback(null, chosen.address, chosen.family) }, (upstream) => { const chunks: Buffer[] = []; let bytes = 0; let ended = false; upstream.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxBytes) { upstream.destroy(); fail(new BridgeHttpError(413, "Network response exceeds configured limit")); return; } chunks.push(chunk); onChunk(chunk); }); upstream.once("end", () => { ended = true; succeed({ status: upstream.statusCode ?? 0, headers: Object.fromEntries(Object.entries(upstream.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")), body: Buffer.concat(chunks).toString("utf8"), finalUrl: url.href }); }); upstream.once("aborted", () => fail(new BridgeHttpError(499, "Network response aborted"))); upstream.once("close", () => { if (!ended) fail(new BridgeHttpError(499, "Network response closed")); }); }); registerAbort(() => request.destroy(new BridgeHttpError(499, "Network operation cancelled"))); request.setTimeout(30_000, () => request.destroy(new Error("Network timeout"))); request.once("error", fail); request.end(); }); }
function canGrant(capability: string, scope: Record<string, unknown>, roots: Root[], commands: Map<string, NativeCommandConfig>, profiles: Map<string, NativeNetworkProfile>): boolean { if (capability === "host.fs.read" || capability === "host.fs.write") return typeof scope.rootId === "string" && roots.some((root) => root.id === scope.rootId && (capability === "host.fs.read" || root.mode === "readwrite")); if (capability === "host.command.spawn") return Array.isArray(scope.commandIds) && scope.commandIds.every((id) => typeof id === "string" && commands.has(id)); if (capability === "net.http") return Array.isArray(scope.profileIds) && scope.profileIds.every((id) => typeof id === "string" && profiles.has(id)); if (capability === "net.dns.lookup") return Array.isArray(scope.suffixes) && scope.suffixes.every((item) => typeof item === "string" && /^\.?[a-z0-9.-]+$/i.test(item)); return capability === "runtime.timers"; }
function rootFor(roots: Root[], id: unknown): Root { const root = typeof id === "string" ? roots.find((item) => item.id === id) : undefined; if (!root) throw new BridgeHttpError(403, "Unknown root"); return root; }
function ensureScope(scope: Record<string, unknown>, rootId: string, target?: string): void { if (scope.rootId !== rootId || !allowedPrefix(target ?? "", scope.prefixes)) throw new BridgeHttpError(403, "Path is outside grant scope"); }
async function safeTarget(root: Root, untrusted: string): Promise<string> { const clean = untrusted === "" || untrusted === "/" ? "" : safeRelative(untrusted); const target = resolve(root.canonical, clean); if (target !== root.canonical && !target.startsWith(`${root.canonical}${sep}`)) throw new BridgeHttpError(403, "Path escapes root"); let current = root.canonical; for (const segment of clean.split("/").filter(Boolean)) { current = resolve(current, segment); try { const stat = await fs.lstat(current); if (stat.isSymbolicLink()) throw new BridgeHttpError(403, "Symlinks are not allowed in bridge paths"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; } } return target; }
function safeRelative(value: string): string { if (typeof value !== "string" || value.length > 4096 || value.includes("\0") || value.includes("\\") || isAbsolute(value) || /^[a-zA-Z]:/.test(value)) throw new BridgeHttpError(400, "Path must be a relative POSIX path"); let decoded: string; try { decoded = decodeURIComponent(value); } catch { throw new BridgeHttpError(400, "Invalid path encoding"); } if (decoded.length > 4096 || decoded.includes("\0") || decoded.includes("\\") || isAbsolute(decoded) || /^[a-zA-Z]:/.test(decoded)) throw new BridgeHttpError(400, "Path must be a relative POSIX path"); const parts = decoded.split("/"); if (parts.some((part) => !part || part === "." || part === "..") || parts.some((part) => [".git", ".browser-agent"].includes(part))) throw new BridgeHttpError(400, "Unsafe path"); return parts.join("/"); }
function allowedPrefix(path: string, prefixes: unknown): boolean { if (!Array.isArray(prefixes) || prefixes.length === 0) return true; return prefixes.some((prefix) => typeof prefix === "string" && (path === prefix || path.startsWith(`${prefix}/`))); }
function scopeAllows(value: unknown, desired: string): boolean { return Array.isArray(value) && value.includes(desired); }
function allowedSuffix(hostname: string, suffixes: unknown): boolean { return Array.isArray(suffixes) && suffixes.some((suffix) => typeof suffix === "string" && (hostname === suffix.replace(/^\./, "") || hostname.endsWith(suffix.startsWith(".") ? suffix : `.${suffix}`))); }
function privateAddress(address: string): boolean { const normalized = ipv4MappedAddress(address.toLowerCase()) ?? address.toLowerCase().replace(/^::ffff:/, ""); if (isIP(normalized) === 4) { const parts = normalized.split(".").map(Number); const a = parts[0] ?? -1; const b = parts[1] ?? -1; return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127; } return normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff"); }
function ipv4MappedAddress(address: string): string | undefined { const match = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i); if (!match) return undefined; const high = Number.parseInt(match[1]!, 16); const low = Number.parseInt(match[2]!, 16); return [high >>> 8, high & 255, low >>> 8, low & 255].join("."); }
function cancelOperation(operation: Operation): void { operation.cancelled = true; operation.abort?.(); kill(operation.child); }
function kill(child?: ChildProcess): void { if (!child || child.killed) return; try { if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); else process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } } }
function preflight(request: IncomingMessage, response: ServerResponse, origins: string[]): void { const origin = request.headers.origin; if (!loopbackHost(request.headers.host) || !origin || !origins.includes(origin)) return send(response, 403, { error: "Origin denied" }); response.writeHead(204, { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-BA-Sequence", "Access-Control-Allow-Private-Network": request.headers["access-control-request-private-network"] === "true" ? "true" : "false", "Access-Control-Max-Age": "600", Vary: "Origin" }).end(); }
async function readJson<T>(request: IncomingMessage): Promise<T> { if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? "")) throw new BridgeHttpError(415, "Content-Type must be application/json"); const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > MAX_CONTROL_BYTES) throw new BridgeHttpError(413, "Request too large"); chunks.push(buffer); } try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T; } catch { throw new BridgeHttpError(400, "Invalid JSON"); } }
function send(response: ServerResponse, status: number, value: unknown): void { if (!response.headersSent) response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); }
function validId(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value); }
function equal(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeExpiry(requested: string | undefined, mode: unknown): string { const upper = Date.now() + (mode === "project" ? 7 * 24 * 60 * 60_000 : 60 * 60_000); const value = requested ? Date.parse(requested) : Date.now() + (mode === "once" ? 5 * 60_000 : 60 * 60_000); return new Date(Math.min(Math.max(value, Date.now() + 1_000), upper)).toISOString(); }
function redact(value: unknown): unknown { if (!value || typeof value !== "object") return value; if (Array.isArray(value)) return value.map(redact); return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => /authorization|token|secret|password|content|body|args?|path|url|query/i.test(key) ? [key, "[redacted]"] : [key, redact(item)])); }
function withoutParameters<T extends { parameters?: unknown }>(value: T): Omit<T, "parameters"> { const { parameters: _parameters, ...rest } = value; return rest; }
function isExactOrigin(value: string): boolean { try { const url = new URL(value); return url.origin === value && (url.protocol === "https:" || url.protocol === "http:"); } catch { return false; } }
function loopbackHost(value: string | undefined): boolean { if (!value) return false; const host = value.replace(/^\[/, "").replace(/\](?::\d+)?$/, "").replace(/:\d+$/, "").toLowerCase(); return host === "127.0.0.1" || host === "localhost" || host === "::1"; }
class BridgeHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
