export interface RuntimeSession { id: string; workingDirectory: string; }
export interface ScriptExecutionRequest { source: string; workingDirectory: string; kind?: "shell" | "javascript"; timeoutMs?: number; signal?: AbortSignal; scratchDirectory?: string; }
export interface ScriptExecutionResult { exitCode: number; stdout: string; stderr: string; }
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
  startInteractive?(onOutput: (data: string) => void, dimensions: TerminalDimensions): Promise<InteractiveRuntimeSession>;
  terminate(session: RuntimeSession): Promise<void>;
  limitations?(): string[];
}
