import type { BridgeEvent, CapabilityGrant, BridgePairResponse, BridgeStatus, HttpResult, ProcessResult } from "../../native-bridge-contracts/src/index";
import type { RuntimeCapabilityDescriptor, RuntimeCapabilityGrant, RuntimeCapabilityProvider } from "../../runtime-contracts/src/index";

export type NativeOperationEvent = BridgeEvent;
type OperationListener = (event: NativeOperationEvent) => void;

/**
 * An opaque reference that is safe to place in an agent's context. It is not
 * a bridge grant id and cannot authenticate a request without the private,
 * memory-only bridge session held by this client.
 */
export interface NativeAgentGrantHandle {
  handle: string;
  capability: CapabilityGrant["capability"];
  scope: Record<string, unknown>;
  mode: CapabilityGrant["mode"];
  expiresAt: string;
}

const grantHandlePrefix = "native-grant-";

/** Browser client. Session tokens, SSE events, and pairing codes are deliberately memory-only. */
export class NativeBridgeClient implements RuntimeCapabilityProvider {
  private endpoint = ""; private token = ""; private sequence = 0; private paired: BridgePairResponse | undefined;
  private eventController: AbortController | undefined;
  private readonly listeners = new Set<OperationListener>();
  /** Maps model-visible opaque handles to daemon-only grant ids. Never serialize this map. */
  private readonly grantHandles = new Map<string, { id: string; grant: CapabilityGrant }>();
  constructor(private readonly clientInstanceId = crypto.randomUUID()) {}
  get connected(): boolean { return Boolean(this.token); }
  get bridge(): BridgePairResponse | undefined { return this.paired; }

  async pair(endpoint: string, pairingCode: string): Promise<BridgePairResponse> {
    const normalized = new URL(endpoint);
    if (normalized.protocol !== "http:" || !/^127\.0\.0\.1$|^\[::1\]$|^localhost$/i.test(normalized.hostname)) throw new Error("Native bridge endpoint must be loopback HTTP.");
    const response = await fetch(new URL("/v1/pair", normalized).href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ protocol: "ba-native/1", origin: location.origin, clientInstanceId: this.clientInstanceId.replace(/-/g, "_"), pairingCode }), credentials: "omit" });
    const body = await response.json() as BridgePairResponse & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Native bridge pairing failed");
    this.endpoint = normalized.origin; this.token = body.sessionToken; this.sequence = 0; this.paired = body; this.grantHandles.clear();
    // Establish the sequenced SSE request before any concurrent status/grant call.
    await this.listen();
    return body;
  }

  disconnect(): void {
    this.eventController?.abort(); this.eventController = undefined;
    this.endpoint = ""; this.token = ""; this.sequence = 0; this.paired = undefined; this.listeners.clear(); this.grantHandles.clear();
  }
  subscribe(listener: OperationListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async status(): Promise<BridgeStatus> { return this.request("GET", "/v1/bridge/status"); }
  async capabilities(): Promise<RuntimeCapabilityDescriptor[]> { return (await this.status()).capabilities; }
  async requestGrant(request: { capability: string; scope: Record<string, unknown>; mode?: "once" | "run" | "session" | "project"; projectId?: string }): Promise<RuntimeCapabilityGrant> {
    const grant = await this.request<CapabilityGrant>("POST", "/v1/grants", request);
    this.rememberGrant(grant);
    return grant;
  }
  async revokeGrant(id: string): Promise<void> {
    await this.request("POST", "/v1/grants/revoke", { id });
    for (const [handle, entry] of this.grantHandles) if (entry.id === id) this.grantHandles.delete(handle);
  }
  async grants(): Promise<CapabilityGrant[]> { return (await this.status()).grants; }
  /**
   * Refreshes the daemon grants and returns only opaque, model-safe handles.
   * The actual grant ids remain inside this client alongside the bearer token.
   */
  async agentGrantHandles(): Promise<NativeAgentGrantHandle[]> {
    const grants = await this.grants();
    const activeIds = new Set(grants.map((grant) => grant.id));
    for (const [handle, entry] of this.grantHandles) if (!activeIds.has(entry.id)) this.grantHandles.delete(handle);
    return grants.map((grant) => {
      const handle = this.rememberGrant(grant);
      return { handle, capability: grant.capability, scope: grant.scope, mode: grant.mode, expiresAt: grant.expiresAt };
    });
  }
  /** Called by host tool implementations only after the registry authorization hook has confirmed the call. */
  resolveAgentGrantHandle(handle: string, capability: CapabilityGrant["capability"]): string {
    const entry = this.grantHandles.get(handle);
    if (!entry || entry.grant.capability !== capability || entry.grant.expiresAt <= new Date().toISOString()) throw new Error("Native grant handle is unavailable or does not cover this host operation");
    return entry.id;
  }

  async fsList(grantId: string, rootId: string, path: string): Promise<Array<{ name: string; kind: string }>> { return this.request("POST", "/v1/fs/list", { grantId, rootId, path }); }
  async fsRead(grantId: string, rootId: string, path: string): Promise<{ content: string }> { return this.request("POST", "/v1/fs/read", { grantId, rootId, path }); }
  async fsWrite(grantId: string, rootId: string, path: string, content: string): Promise<{ ok: boolean }> { return this.request("POST", "/v1/fs/write", { grantId, rootId, path, content }); }
  async fsMkdir(grantId: string, rootId: string, path: string): Promise<{ ok: boolean }> { return this.request("POST", "/v1/fs/mkdir", { grantId, rootId, path }); }
  async fsMove(grantId: string, rootId: string, from: string, to: string): Promise<{ ok: boolean }> { return this.request("POST", "/v1/fs/move", { grantId, rootId, path: from, to }); }
  async fsDelete(grantId: string, rootId: string, path: string): Promise<{ ok: boolean }> { return this.request("POST", "/v1/fs/delete", { grantId, rootId, path }); }

  async runCommand(grantId: string, commandId: string, args: string[] = [], signal?: AbortSignal, onEvent?: OperationListener): Promise<ProcessResult> {
    return this.operation("/v1/process/run", { grantId, commandId, args }, signal, onEvent);
  }
  async fetchProfile(grantId: string, profileId: string, path = "/", signal?: AbortSignal, onEvent?: OperationListener): Promise<HttpResult> {
    return this.operation("/v1/network/fetch", { grantId, profileId, path }, signal, onEvent);
  }
  async dnsLookup(grantId: string, hostname: string): Promise<{ answers: Array<{ address: string; family: number }> }> { return this.request("POST", "/v1/dns/lookup", { grantId, hostname }); }
  async wait(grantId: string, durationMs: number, signal?: AbortSignal, onEvent?: OperationListener): Promise<{ operationId: string; cancelled: boolean }> {
    return this.operation("/v1/timers/wait", { grantId, durationMs }, signal, onEvent);
  }
  async cancel(operationId: string): Promise<void> { await this.request("POST", "/v1/operations/cancel", { operationId }); }

  private async operation<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal, onEvent?: OperationListener): Promise<T> {
    const operationId = crypto.randomUUID();
    let endEvent: (() => void) | undefined;
    let terminalEventReceived = false;
    const terminalEvent = new Promise<void>((resolvePromise) => { endEvent = resolvePromise; });
    const unsubscribe = onEvent ? this.subscribe((event) => {
      if (event.operationId !== operationId) return;
      onEvent(event);
      if (event.kind === "operation.end") { terminalEventReceived = true; endEvent?.(); }
    }) : undefined;
    const abort = () => { void this.cancel(operationId).catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // Do not abort the control request: after forwarding cancellation we must retain the
      // authenticated SSE subscription through operation.end and receive the terminal result.
      const result = await this.request<T>("POST", path, { ...body, operationId });
      // SSE is delivered independently of the control response. Keep the per-operation
      // progress listener through the terminal frame so completion is observable instead
      // of racing unsubscription when a cancellation settles immediately.
      if (onEvent) await Promise.race([terminalEvent, new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100))]);
      return (typeof result === "object" && result !== null ? { ...result, nativeTerminalEventReceived: terminalEventReceived } : result) as T;
    } finally { signal?.removeEventListener("abort", abort); unsubscribe?.(); }
  }
  private rememberGrant(grant: CapabilityGrant): string {
    for (const [handle, entry] of this.grantHandles) {
      if (entry.id === grant.id) { entry.grant = grant; return handle; }
    }
    const handle = `${grantHandlePrefix}${crypto.randomUUID()}`;
    this.grantHandles.set(handle, { id: grant.id, grant });
    return handle;
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.token) throw new Error("Native bridge is disconnected");
    const response = await fetch(`${this.endpoint}${path}`, { method, credentials: "omit", ...(signal ? { signal } : {}), headers: { Authorization: `Bearer ${this.token}`, "X-BA-Sequence": String(++this.sequence), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Native bridge HTTP ${response.status}`);
    return result;
  }
  private async listen(): Promise<void> {
    if (!this.token || this.eventController) return;
    const controller = this.eventController = new AbortController();
    try {
      const response = await fetch(`${this.endpoint}/v1/bridge/events`, { headers: { Authorization: `Bearer ${this.token}`, "X-BA-Sequence": String(++this.sequence) }, signal: controller.signal, credentials: "omit" });
      if (!response.ok || !response.body) { if (this.eventController === controller) this.eventController = undefined; return; }
      void this.consumeEvents(response.body, controller);
    } catch { if (this.eventController === controller) this.eventController = undefined; }
  }
  private async consumeEvents(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    try {
      const reader = body.getReader(); const decoder = new TextDecoder(); let buffered = "";
      while (!controller.signal.aborted) {
        const part = await reader.read(); if (part.done) break;
        buffered += decoder.decode(part.value, { stream: true });
        let boundary: number;
        while ((boundary = buffered.indexOf("\n\n")) >= 0) {
          const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          try { const event = JSON.parse(data) as NativeOperationEvent; for (const listener of this.listeners) listener(event); } catch { /* malformed daemon event is ignored */ }
        }
      }
    } catch { /* disconnect/reload is normal; active daemon operations are bounded and revocable. */ }
    finally { if (this.eventController === controller) this.eventController = undefined; }
  }
}

/** Not product-facing: app DOM, Worker code execution, and cache storage are not agent tools. */
export class BrowserCapabilityAdapter {
  private readonly namespace = `ba-native:${crypto.randomUUID()}:`;
  async createWorker(source: string): Promise<Worker> { const blob = new Blob([source], { type: "text/javascript" }); return new Worker(URL.createObjectURL(blob), { type: "module", name: "browser-agent-native-isolated" }); }
  async storageGet(key: string): Promise<unknown> { return (await caches.open(this.namespace)).match(new Request(`https://bridge.invalid/${encodeURIComponent(key)}`)).then(async (response) => response ? response.json() : undefined); }
  async storagePut(key: string, value: unknown): Promise<void> { const cache = await caches.open(this.namespace); await cache.put(new Request(`https://bridge.invalid/${encodeURIComponent(key)}`), new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } })); }
  createOpaqueDocument(): Document { return document.implementation.createHTMLDocument("Browser Agent isolated automation document"); }
}
