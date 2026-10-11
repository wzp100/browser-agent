import type { AgentToolRegistry, ToolExecutionContext } from "../../command-core/src/index";
import type { NativeCapability } from "../../native-bridge-contracts/src/index";
import type { NativeOperationEvent, NativeBridgeClient } from "../../runtime-native/src/index";

/** Separately named host tools: virtual shell/javascript tools are never upgraded implicitly. */
export function registerNativeBridgeTools(registry: AgentToolRegistry, bridge: NativeBridgeClient): void {
  const text = (description: string) => ({ type: "string", description });
  const base = (properties: Record<string, { type: string; description: string }>, required: string[]) => ({ type: "object" as const, properties, required, additionalProperties: false });
  // A handle is an app-local reference, not the daemon grant id and never a bearer credential.
  const grant = { grantHandle: text("Opaque Native grant handle from the injected agent environment.") };
  const file = { ...grant, rootId: text("Configured native root id."), path: text("Relative POSIX path.") };
  const host = { requiresAuthorization: true as const, scope: "host" as const };
  const available = new Set(bridge.bridge?.capabilities.filter((item) => item.available).map((item) => item.capability) ?? []);
  const register = (capability: NativeCapability, tool: Parameters<AgentToolRegistry["register"]>[0]): void => { if (available.has(capability)) registry.register(tool); };
  // This resolver is deliberately called inside execute, after AgentToolRegistry.prepare has
  // run the product's visible per-call confirmation hook.
  const resolve = (handle: unknown, capability: NativeCapability): string => bridge.resolveAgentGrantHandle(required(handle), capability);

  register("host.fs.read", { id: "host.fs.list", description: "List a user-granted native root through the paired local bridge.", effect: "read", ...host, inputSchema: base(file, ["grantHandle", "rootId", "path"]), execute: (args) => bridge.fsList(resolve(args.grantHandle, "host.fs.read"), required(args.rootId), required(args.path)) });
  register("host.fs.read", { id: "host.fs.read", description: "Read a file inside a user-granted native root through the paired local bridge.", effect: "read", ...host, inputSchema: base(file, ["grantHandle", "rootId", "path"]), execute: (args) => bridge.fsRead(resolve(args.grantHandle, "host.fs.read"), required(args.rootId), required(args.path)) });
  register("host.fs.write", { id: "host.fs.write", description: "Write a file inside a user-granted native root. This direct host I/O is not browser ChangeSet rollback-managed.", effect: "write", ...host, inputSchema: base({ ...file, content: text("File text.") }, ["grantHandle", "rootId", "path", "content"]), execute: (args) => bridge.fsWrite(resolve(args.grantHandle, "host.fs.write"), required(args.rootId), required(args.path), required(args.content)) });
  register("host.fs.write", { id: "host.fs.mkdir", description: "Create one empty directory inside a user-granted native root. This direct host mutation is not rollback-managed.", effect: "write", ...host, inputSchema: base(file, ["grantHandle", "rootId", "path"]), execute: (args) => bridge.fsMkdir(resolve(args.grantHandle, "host.fs.write"), required(args.rootId), required(args.path)) });
  register("host.fs.write", { id: "host.fs.move", description: "Rename or move one host path within a user-granted root. The grant must explicitly allow rename.", effect: "write", ...host, inputSchema: base({ ...file, to: text("Destination relative POSIX path in the same root.") }, ["grantHandle", "rootId", "path", "to"]), execute: (args) => bridge.fsMove(resolve(args.grantHandle, "host.fs.write"), required(args.rootId), required(args.path), required(args.to)) });
  register("host.fs.write", { id: "host.fs.delete", description: "Delete one empty directory or file inside a user-granted root. The grant must explicitly allow deletion; recursive deletion is unavailable.", effect: "write", ...host, inputSchema: base(file, ["grantHandle", "rootId", "path"]), execute: (args) => bridge.fsDelete(resolve(args.grantHandle, "host.fs.write"), required(args.rootId), required(args.path)) });

  register("host.command.spawn", { id: "host.command.run", description: "Run a host-policy configured command template without a shell. Requires an explicit native command grant; stream progress is ephemeral.", effect: "execute", ...host, inputSchema: { type: "object", properties: { ...grant, commandId: text("Host-configured command id."), args: { type: "array", description: "Arguments constrained by host command schema.", items: { type: "string" } } }, required: ["grantHandle", "commandId"], additionalProperties: false }, execute: (args, context) => bridge.runCommand(resolve(args.grantHandle, "host.command.spawn"), required(args.commandId), strings(args.args), context?.signal, progress(context)) });
  register("net.http", { id: "host.network.fetch", description: "Fetch only a host-configured HTTPS profile through the local bridge. No ambient browser credentials are sent; body stream progress is ephemeral.", effect: "read", ...host, inputSchema: base({ ...grant, profileId: text("Host-configured HTTPS profile id."), path: text("Path under that exact origin.") }, ["grantHandle", "profileId"]), execute: (args, context) => bridge.fetchProfile(resolve(args.grantHandle, "net.http"), required(args.profileId), typeof args.path === "string" ? args.path : "/", context?.signal, progress(context)) });
  register("net.dns.lookup", { id: "host.dns.lookup", description: "Resolve a hostname only when it is covered by a user-granted DNS suffix. Private answers are removed by the bridge.", effect: "read", ...host, inputSchema: base({ ...grant, hostname: text("Granted hostname.") }, ["grantHandle", "hostname"]), execute: (args) => bridge.dnsLookup(resolve(args.grantHandle, "net.dns.lookup"), required(args.hostname)) });
  register("runtime.timers", { id: "host.timer.wait", description: "Wait for a bounded duration through the paired bridge. Requires an explicit timer grant and can be cancelled.", effect: "execute", ...host, inputSchema: { type: "object", properties: { ...grant, durationMs: { type: "integer", description: "Duration from 0 to 60000 milliseconds." } }, required: ["grantHandle", "durationMs"], additionalProperties: false }, execute: (args, context) => bridge.wait(resolve(args.grantHandle, "runtime.timers"), requiredInteger(args.durationMs, "durationMs"), context?.signal, progress(context)) });
}

function progress(context?: ToolExecutionContext): ((event: NativeOperationEvent) => void) | undefined {
  const update = context?.onUpdate;
  if (!update) return undefined;
  return (event) => {
    if (event.kind === "stream.chunk") {
      const stream = typeof event.payload.stream === "string" ? event.payload.stream : "output";
      const data = typeof event.payload.data === "string" ? event.payload.data : "";
      void update(`${stream} stream: ${data.length} bytes received`);
    } else if (event.kind === "operation.end") void update("operation stream completed");
  };
}
function required(value: unknown): string { if (typeof value !== "string" || !value) throw new Error("Missing required bridge argument"); return value; }
function requiredInteger(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 60_000) throw new Error(`${name} must be an integer from 0 to 60000`); return value; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
