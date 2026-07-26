export type TaskPhase = "CREATED" | "INITIALIZING" | "DISCOVERING" | "RUNNING" | "VALIDATING" | "COMPLETED" | "FAILED_RECOVERABLE";

export interface TaskState {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  phase: TaskPhase;
  userIntent: string;
  activeSkills: string[];
  workingDirectory: string;
  observations: string[];
  failure?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceInspection { path: string; type: string; metadata: Record<string, unknown>; warnings: string[]; }
export interface ResourceInspector { inspect(path: string, data: Uint8Array): Promise<ResourceInspection | undefined>; }
export interface ArtifactValidator { supports(name: string): boolean; validate(name: string, data: Uint8Array): Promise<string>; }
export interface ArtifactDraft { sourcePath: string; targetName: string; data: Uint8Array; }
export interface ArtifactComposer { compose(intent: string, summary: Record<string, unknown>): Promise<ArtifactDraft | undefined>; }

export function workspacePath(input: string): string {
  if (input.includes("\\") || /^[a-zA-Z]:/.test(input) || /%2e|%2f/i.test(input)) throw new Error("WorkspacePath 拒绝 OS 路径、反斜杠和编码路径。");
  const parts = input.split("/").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === "." || part === ".." || /[\u0000-\u001f]/.test(part))) throw new Error("WorkspacePath 无效或越界。");
  return `/${parts.join("/")}`;
}
