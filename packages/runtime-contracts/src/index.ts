export interface RuntimeSession {
  id: string;
  /** 面向调用方的项目根工作目录，不暴露实现层内部路径。 */
  workingDirectory: ".";
  /** Runtime 命令必须使用项目根相对路径。 */
  runtimeCommandsUseRelativePaths: true;
}
export interface RuntimeStreamEvent { operationId?: string; stream: "stdout" | "stderr" | "event"; data: string; offset?: number; }
export interface ScriptExecutionRequest { source: string; workingDirectory: string; kind?: "shell" | "javascript"; timeoutMs?: number; signal?: AbortSignal; scratchDirectory?: string; onOutput?: (event: RuntimeStreamEvent) => void; }
export interface ScriptExecutionResult { exitCode: number; stdout: string; stderr: string; }

/** Optional capability surface. Virtual providers intentionally do not need to implement it. */
export interface RuntimeCapabilityDescriptor { capability: string; available: boolean; reason?: string; limits?: Record<string, number>; }
export interface RuntimeCapabilityGrant { id: string; capability: string; scope: Record<string, unknown>; expiresAt: string; mode: "once" | "run" | "session" | "project"; }
export interface RuntimeCapabilityProvider {
  capabilities(): Promise<RuntimeCapabilityDescriptor[]>;
  requestGrant(request: { capability: string; scope: Record<string, unknown>; mode?: "once" | "run" | "session" | "project"; projectId?: string }): Promise<RuntimeCapabilityGrant>;
  revokeGrant(id: string): Promise<void>;
}
export interface TerminalDimensions { cols: number; rows: number; }
export interface InteractiveRuntimeSession extends RuntimeSession {
  write(data: string): Promise<void>;
  resize(dimensions: TerminalDimensions): void;
  kill(): void;
}
export interface ScriptRuntimeProvider {
  readonly id: string;
  available(): Promise<boolean>;
  start(): Promise<RuntimeSession>;
  execute(session: RuntimeSession, request: ScriptExecutionRequest): Promise<ScriptExecutionResult>;
  executeStreaming?(session: RuntimeSession, request: ScriptExecutionRequest, onEvent: (event: RuntimeStreamEvent) => void): Promise<ScriptExecutionResult>;
  startInteractive?(onOutput: (data: string) => void, dimensions: TerminalDimensions): Promise<InteractiveRuntimeSession>;
  terminate(session: RuntimeSession): Promise<void>;
  limitations?(): string[];
}
