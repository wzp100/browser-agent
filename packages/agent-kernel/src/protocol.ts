import type { AgentToolDefinition } from "../../command-core/src/index";
import type { TaskPhase } from "../../contracts/src/index";
import type { AgentModelMessage, ModelToolCall } from "../../model-adapters/src/index";

export type CompletionRequirement = "grounded";
export type AgentErrorOrigin = "model" | "tool" | "runtime" | "permission";
export type AgentPolicyAction = "continue" | "pause" | "stop";
export type AgentEndStatus = "completed" | "paused" | "aborted" | "recoverable_error" | "error";
export type AgentErrorKind = "context_overflow" | "runtime" | "permission" | "model" | "infrastructure" | "policy";

export interface ToolEvidence {
  callId: string;
  toolName: string;
  effect: AgentToolDefinition["effect"];
  scope: AgentToolDefinition["scope"];
}

export interface AgentRunMetrics {
  modelTurns: number;
  toolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  newEvidenceCount: number;
  changedFileCount: number;
  elapsedMs: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface AgentRunBudget {
  maxFailedToolCalls?: number;
  maxElapsedMs?: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface FailureFingerprint {
  toolName: string;
  normalizedError: string;
  normalizedArguments: string;
  origin: AgentErrorOrigin;
}

export interface CompletedToolCallResult {
  callId: string;
  toolName: string;
  content: string;
  effect: AgentToolDefinition["effect"];
  scope: AgentToolDefinition["scope"];
  completedAt: string;
}

export interface RuntimeErrorRecord {
  at: string;
  message: string;
  callId?: string;
  toolName?: string;
  fingerprint?: string;
}

export interface SteeringRecord {
  id: string;
  content: string;
  status: "pending" | "delivered" | "consumed" | "withdrawn";
  attachments?: unknown[];
}

export interface AgentCheckpointV1 {
  version: 1;
  stage: "after-tools";
  turn: number;
  requiredEvidence: CompletionRequirement;
  messages: AgentModelMessage[];
  evidence: ToolEvidence[];
  updatedAt: string;
}

export interface AgentCheckpointV2 {
  version: 2;
  stage: "after-tool" | "after-tools" | "paused" | "compacted";
  runId: string;
  turn: number;
  requiredEvidence: CompletionRequirement;
  messages: AgentModelMessage[];
  pendingToolCalls: ModelToolCall[];
  successfulToolResults: CompletedToolCallResult[];
  completedToolCallIds: string[];
  evidence: ToolEvidence[];
  metrics: AgentRunMetrics;
  accumulatedFiles: string[];
  runtimeErrors: RuntimeErrorRecord[];
  steering: SteeringRecord[];
  compactionSummary?: string;
  updatedAt: string;
}

export type AgentCheckpoint = AgentCheckpointV1 | AgentCheckpointV2;

interface AgentLifecycleEventBase {
  at: string;
  runId: string;
  taskId: string;
}

export type AgentLifecycleEvent =
  | (AgentLifecycleEventBase & { kind: "agent_start"; intent: string; workspaceId: string; metrics: AgentRunMetrics })
  | (AgentLifecycleEventBase & { kind: "turn_start"; turn: number; metrics: AgentRunMetrics })
  | (AgentLifecycleEventBase & { kind: "message_start"; messageId: string; role: "assistant" | "system"; turn: number })
  | (AgentLifecycleEventBase & { kind: "message_update"; messageId: string; content: string; updateKind: "text_delta" | "tool_progress" | "compaction_progress" | "phase"; turn?: number; phase?: TaskPhase })
  | (AgentLifecycleEventBase & { kind: "message_end"; messageId: string; role: "assistant" | "system"; content: string; turn: number; final: boolean; validated: boolean })
  | (AgentLifecycleEventBase & { kind: "tool_execution_start"; callId: string; toolName: string; arguments: Record<string, unknown>; turn: number; index: number })
  | (AgentLifecycleEventBase & { kind: "tool_execution_update"; callId: string; toolName: string; content: string; turn: number })
  | (AgentLifecycleEventBase & { kind: "tool_execution_end"; callId: string; toolName: string; content: string; turn: number; isError: boolean; errorOrigin?: AgentErrorOrigin; errorFingerprint?: string; terminate?: boolean; effect?: AgentToolDefinition["effect"]; scope?: AgentToolDefinition["scope"] })
  | (AgentLifecycleEventBase & { kind: "turn_end"; turn: number; metrics: AgentRunMetrics; action: AgentPolicyAction })
  | (AgentLifecycleEventBase & { kind: "agent_end"; status: AgentEndStatus; reply?: string; error?: string; errorKind?: AgentErrorKind; metrics: AgentRunMetrics; checkpoint?: AgentCheckpointV2 })
  | (AgentLifecycleEventBase & { kind: "agent_settled"; status: AgentEndStatus; reply?: string; metrics: AgentRunMetrics; checkpoint?: AgentCheckpointV2 });

export type AgentEvent = AgentLifecycleEvent;

export interface NormalizedToolResult {
  call: ModelToolCall;
  content: string;
  isError: boolean;
  errorOrigin?: AgentErrorOrigin;
  errorFingerprint?: string;
  terminate?: boolean;
  definition?: AgentToolDefinition;
  modelContentMessages?: AgentModelMessage[];
}

export interface AgentHookContext {
  runId: string;
  turn: number;
  messages: AgentModelMessage[];
  evidence: ToolEvidence[];
  metrics: AgentRunMetrics;
  completedToolCallIds: ReadonlySet<string>;
}

export interface AgentLoopHooks {
  beforeToolCall?(call: ModelToolCall, context: AgentHookContext): AgentPolicyAction | void | Promise<AgentPolicyAction | void>;
  afterToolCall?(result: NormalizedToolResult, context: AgentHookContext): AgentPolicyAction | void | Promise<AgentPolicyAction | void>;
  prepareNextTurn?(context: AgentHookContext): AgentModelMessage[] | void | Promise<AgentModelMessage[] | void>;
  shouldStopAfterTurn?(context: AgentHookContext & { candidateReply: string; hasToolCalls: boolean }): AgentPolicyAction | void | Promise<AgentPolicyAction | void>;
  transformContext?(messages: AgentModelMessage[], context: AgentHookContext): AgentModelMessage[] | Promise<AgentModelMessage[]>;
}

export function emptyAgentRunMetrics(): AgentRunMetrics {
  return { modelTurns: 0, toolCalls: 0, successfulToolCalls: 0, failedToolCalls: 0, newEvidenceCount: 0, changedFileCount: 0, elapsedMs: 0, totalTokens: 0, totalCostUsd: 0 };
}
