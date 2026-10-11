/** Versioned, transport-neutral contract for the optional local Native Runtime Bridge. */
export const NATIVE_BRIDGE_PROTOCOL = "ba-native/1" as const;
export type NativeCapability =
  | "host.fs.read" | "host.fs.write" | "host.command.spawn" | "net.http" | "net.dns.lookup"
  | "runtime.timers" | "runtime.streams" | "extension.invoke"
  | "browser.dom" | "browser.worker" | "browser.storage";
export type GrantMode = "once" | "run" | "session" | "project";

export interface CapabilityDescriptor { capability: NativeCapability; available: boolean; reason?: string; limits?: Record<string, number>; }
export interface CapabilityGrant { id: string; projectId?: string; capability: NativeCapability; scope: Record<string, unknown>; mode: GrantMode; expiresAt: string; issuedBy: "user"; policyVersion: 1; }
export interface CapabilityGrantRequest { projectId?: string; capability: NativeCapability; scope: Record<string, unknown>; mode?: GrantMode; expiresAt?: string; }
export interface NativeAuditRecord { id: string; previousHash: string; at: string; connectionId: string; projectId?: string; runId?: string; operationId?: string; grantId?: string; capability: NativeCapability; decision: "allowed" | "denied" | "cancelled" | "completed" | "failed"; targetSummary: string; parameterDigest: string; byteCounts?: { in: number; out: number }; exitCode?: number; errorCode?: string; }
export interface BridgePairRequest { protocol: typeof NATIVE_BRIDGE_PROTOCOL; origin: string; clientInstanceId: string; pairingCode: string; }
export interface BridgePairResponse { protocol: typeof NATIVE_BRIDGE_PROTOCOL; connectionId: string; sessionToken: string; expiresAt: string; fingerprint: string; capabilities: CapabilityDescriptor[]; policyHash: string; }
export interface BridgeStatus { bridgeId: string; version: string; fingerprint: string; sandboxAvailable: boolean; capabilities: CapabilityDescriptor[]; grants: CapabilityGrant[]; }
export interface BridgeEvent { sequence: number; operationId?: string; kind: "stream.chunk" | "operation.end" | "grant.revoked" | "audit"; payload: Record<string, unknown>; }
export interface HostRootDescriptor { id: string; nickname: string; mode: "read" | "readwrite"; }
export interface ProcessResult { operationId: string; exitCode: number; stdout: string; stderr: string; truncated?: boolean; }
export interface HttpResult { operationId: string; status: number; headers: Record<string, string>; body: string; finalUrl: string; truncated?: boolean; cancelled?: boolean; }

export function isNativeCapability(value: unknown): value is NativeCapability {
  return typeof value === "string" && ["host.fs.read", "host.fs.write", "host.command.spawn", "net.http", "net.dns.lookup", "runtime.timers", "runtime.streams", "extension.invoke", "browser.dom", "browser.worker", "browser.storage"].includes(value);
}
