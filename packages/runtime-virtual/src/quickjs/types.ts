import type { SandboxFilesystemOverlay, SandboxFilesystemSnapshot } from "./sandbox-filesystem";

export interface QuickJsExecutionOptions {
  source: string;
  filename?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Display path visible to process.cwd(); never a host path. */
  cwd?: string;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  maxStackBytes?: number;
  /** Serializable workspace bytes only; never a browser FileSystemHandle or RPC channel. */
  filesystem?: SandboxFilesystemSnapshot;
}

export interface QuickJsExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  errorCode?: "EXECUTION" | "MEMORY_LIMIT" | "TIMEOUT" | "ABORTED" | "WORKER";
  /** Returned only after QuickJS Promise jobs drain. Parent validates and commits it transactionally. */
  filesystemOverlay?: SandboxFilesystemOverlay;
}

export interface QuickJsWorkerRequest extends QuickJsExecutionOptions {
  id: string;
}

export interface QuickJsWorkerResponse extends QuickJsExecutionResult {
  id: string;
}
