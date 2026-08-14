export interface QuickJsExecutionOptions {
  source: string;
  filename?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxStackBytes?: number;
}

export interface QuickJsExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  errorCode?: "EXECUTION" | "MEMORY_LIMIT" | "TIMEOUT" | "ABORTED" | "WORKER";
}

export interface QuickJsWorkerRequest extends QuickJsExecutionOptions {
  id: string;
}

export interface QuickJsWorkerResponse extends QuickJsExecutionResult {
  id: string;
}
