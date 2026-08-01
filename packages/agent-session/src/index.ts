import {
  emptyAgentRunMetrics,
  type AgentCheckpoint,
  type AgentCheckpointV2,
  type AgentEndStatus,
  type AgentErrorKind,
  type AgentLifecycleEvent,
  type AgentRunMetrics,
  type RuntimeErrorRecord,
  type SteeringRecord,
  type ToolEvidence
} from "../../agent-kernel/src/index";
import type { AgentModelMessage, ModelContentPart } from "../../model-adapters/src/index";
import type { ConversationRepository, RunRecord } from "../../persistence/src/index";
import type { ChangeSet, ChangeSetStatus } from "../../workspace-contracts/src/index";

export interface AgentSessionInput {
  intent: string;
  attachments?: ModelContentPart[];
}

export interface AgentSessionDriverRequest extends AgentSessionInput {
  runId: string;
  signal: AbortSignal;
  resumeCheckpoint?: AgentCheckpointV2;
  onCheckpoint(checkpoint: AgentCheckpoint): void | Promise<void>;
  onEvent(event: AgentLifecycleEvent): void | Promise<void>;
  takeSteering(): Promise<SteeringRecord[]>;
}

export interface AgentSessionDriverResult {
  status: AgentEndStatus;
  errorKind?: AgentErrorKind;
  reply?: string;
  error?: string;
  checkpoint?: AgentCheckpoint;
  metrics?: AgentRunMetrics;
}

export interface AgentSessionDriver {
  run(request: AgentSessionDriverRequest): Promise<AgentSessionDriverResult>;
}

export interface AgentSessionChangeSetController {
  beginRun(runId: string): Promise<ChangeSet>;
  reopenRun(runId: string): Promise<ChangeSet>;
  endRun(status: Exclude<ChangeSetStatus, "active">): Promise<ChangeSet | undefined>;
  readChangeSet(runId: string): Promise<ChangeSet | undefined>;
}

export interface AgentSessionDependencies {
  conversations: Pick<ConversationRepository, "putRun">;
  changeSets: AgentSessionChangeSetController;
  driver: AgentSessionDriver;
  compactCheckpoint?: (checkpoint: AgentCheckpointV2, signal: AbortSignal) => Promise<AgentCheckpointV2>;
  takeSteering?: (runId: string) => Promise<SteeringRecord[]>;
  consumeSteering?: (runId: string, steeringIds: readonly string[]) => Promise<void>;
  onEvent?: (event: AgentLifecycleEvent) => void | Promise<void>;
}

export interface AgentSessionResumeInput {
  run: RunRecord;
  checkpoint?: AgentCheckpoint;
}

export class AgentSession {
  private controller: AbortController | undefined;
  private active: Promise<AgentSessionDriverResult> | undefined;
  private lastResult: AgentSessionDriverResult | undefined;
  private checkpointValue: AgentCheckpointV2 | undefined;
  private readonly orchestrationSteering = new Map<string, SteeringRecord>();
  private settledPromise: Promise<void> = Promise.resolve();

  constructor(private runRecord: RunRecord, private readonly dependencies: AgentSessionDependencies) {
    this.checkpointValue = runRecord.checkpoint ? migrateAgentCheckpoint(runRecord.checkpoint, runRecord.id) : undefined;
    for (const item of this.checkpointValue?.steering ?? []) this.orchestrationSteering.set(item.id, item);
  }

  get run(): Readonly<RunRecord> { return this.runRecord; }
  get busy(): boolean { return Boolean(this.active); }

  prompt(input: AgentSessionInput): Promise<AgentSessionDriverResult> {
    if (this.active) throw new Error("AgentSession 已在运行。 ");
    if (input.intent.trim() !== this.runRecord.intent.trim()) throw new Error("AgentSession 的初始意图与 RunRecord 不一致。 ");
    return this.start(input, false);
  }

  continue(): Promise<AgentSessionDriverResult> {
    if (this.active) throw new Error("AgentSession 已在运行。 ");
    if (!this.checkpointValue) throw new Error("当前 AgentSession 没有可继续的检查点。 ");
    return this.start({ intent: this.runRecord.intent }, true);
  }

  resume(input: AgentSessionResumeInput = { run: this.runRecord }): Promise<AgentSessionDriverResult> {
    if (this.active) throw new Error("AgentSession 已在运行。 ");
    if (input.run.id !== this.runRecord.id) throw new Error("恢复必须复用当前 AgentSession 的 runId。 ");
    this.runRecord = input.run;
    this.checkpointValue = migrateAgentCheckpoint(input.checkpoint ?? input.run.checkpoint, input.run.id);
    if (!this.checkpointValue) throw new Error("运行记录中没有有效检查点。 ");
    this.orchestrationSteering.clear();
    for (const item of this.checkpointValue.steering) this.orchestrationSteering.set(item.id, item);
    return this.start({ intent: input.run.intent }, true);
  }

  abort(reason: unknown = new DOMException("用户停止了运行。", "AbortError")): void {
    this.controller?.abort(reason);
  }

  async waitForIdle(): Promise<AgentSessionDriverResult | undefined> {
    if (this.active) return this.active;
    return this.lastResult;
  }

  async waitForSettled(): Promise<AgentSessionDriverResult | undefined> {
    await this.settledPromise;
    return this.lastResult;
  }

  checkpoint(): AgentCheckpointV2 | undefined {
    return this.checkpointValue ? structuredClone(this.checkpointValue) : undefined;
  }

  private start(input: AgentSessionInput, reopening: boolean): Promise<AgentSessionDriverResult> {
    const controller = new AbortController();
    this.controller = controller;
    const operation = this.runLoop(input, reopening, controller).finally(() => {
      this.controller = undefined;
      this.active = undefined;
    });
    this.active = operation;
    this.settledPromise = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async runLoop(input: AgentSessionInput, reopening: boolean, controller: AbortController): Promise<AgentSessionDriverResult> {
    await (reopening ? this.dependencies.changeSets.reopenRun(this.runRecord.id) : this.dependencies.changeSets.beginRun(this.runRecord.id));
    await this.updateRun({ status: "running" });
    let checkpoint = this.checkpointValue;
    try {
      while (true) {
        const result = await this.dependencies.driver.run({
          ...input,
          runId: this.runRecord.id,
          signal: controller.signal,
          ...(checkpoint ? { resumeCheckpoint: checkpoint } : {}),
          onCheckpoint: async (value) => { await this.saveCheckpoint(value); },
          onEvent: (event) => this.observe(event),
          takeSteering: async () => this.takeSteeringForDriver()
        });
        this.lastResult = result;
        if (result.checkpoint) checkpoint = await this.saveCheckpoint(result.checkpoint);
        if (result.metrics) await this.updateRun({ metrics: result.metrics });
        if (result.status === "recoverable_error" && result.errorKind === "context_overflow" && checkpoint && this.dependencies.compactCheckpoint) {
          await this.saveCheckpoint(checkpoint);
          try {
            checkpoint = await this.dependencies.compactCheckpoint(checkpoint, controller.signal);
            checkpoint = await this.saveCheckpoint({ ...checkpoint, stage: "compacted" });
            continue;
          } catch {
            const paused = { ...checkpoint, stage: "paused" as const, updatedAt: new Date().toISOString() };
            await this.saveCheckpoint(paused);
            const pausedResult = { ...result, status: "paused" as const, checkpoint: paused };
            this.lastResult = pausedResult;
            await this.finish("paused", pausedResult);
            return pausedResult;
          }
        }
        if (result.status === "recoverable_error") {
          const paused = checkpoint ? { ...checkpoint, stage: "paused" as const, updatedAt: new Date().toISOString() } : undefined;
          if (paused) await this.saveCheckpoint(paused);
          const pausedResult: AgentSessionDriverResult = { ...result, status: "paused", ...(paused ? { checkpoint: paused } : {}) };
          this.lastResult = pausedResult;
          await this.finish("paused", pausedResult);
          return pausedResult;
        }
        await this.finish(result.status, result);
        return result;
      }
    } catch (error) {
      const aborted = controller.signal.aborted;
      const result: AgentSessionDriverResult = { status: aborted ? "aborted" : "error", error: errorMessage(error), ...(checkpoint ? { checkpoint } : {}) };
      this.lastResult = result;
      await this.finish(result.status, result);
      return result;
    }
  }

  private async saveCheckpoint(value: AgentCheckpoint): Promise<AgentCheckpointV2> {
    const migrated = migrateAgentCheckpoint(value, this.runRecord.id);
    if (!migrated) throw new Error("Agent 返回了无效检查点。 ");
    for (const item of migrated.steering) this.orchestrationSteering.set(item.id, item);
    const checkpoint = { ...migrated, steering: [...this.orchestrationSteering.values()] };
    this.checkpointValue = checkpoint;
    await this.updateRun({
      checkpoint,
      metrics: checkpoint.metrics,
      completedToolCallIds: [...checkpoint.completedToolCallIds],
      outputPaths: [...checkpoint.accumulatedFiles],
      runtimeErrors: [...checkpoint.runtimeErrors]
    });
    return checkpoint;
  }

  private async takeSteeringForDriver(): Promise<SteeringRecord[]> {
    const records = await this.dependencies.takeSteering?.(this.runRecord.id) ?? [];
    for (const record of records) this.orchestrationSteering.set(record.id, record);
    if (!records.length || !this.checkpointValue) return records;
    await this.saveCheckpoint({ ...this.checkpointValue, steering: [...this.orchestrationSteering.values()], updatedAt: new Date().toISOString() });
    return records;
  }

  private async observe(event: AgentLifecycleEvent): Promise<void> {
    if ("metrics" in event) await this.updateRun({ metrics: event.metrics });
    if (event.kind === "tool_execution_end" && !event.isError && !this.runRecord.completedToolCallIds?.includes(event.callId)) {
      await this.updateRun({ completedToolCallIds: [...(this.runRecord.completedToolCallIds ?? []), event.callId] });
    }
    if (isPersistedLifecycleBoundary(event)) {
      const kind = event.kind === "tool_execution_end" ? event.isError ? "error" : "tool" : event.kind === "agent_end" && event.status === "error" ? "error" : "phase";
      const content = lifecycleEventContent(event);
      await this.updateRun({ events: [...this.runRecord.events, { at: event.at, kind, content, ...(event.kind === "tool_execution_start" ? { eventKind: "tool-start" as const, toolName: event.toolName } : {}), ...(event.kind === "tool_execution_end" ? { eventKind: event.isError ? "error" as const : "tool-result" as const, toolName: event.toolName } : {}) }] });
    }
    await this.dependencies.onEvent?.(event);
  }

  private async finish(status: AgentEndStatus, result: AgentSessionDriverResult): Promise<void> {
    const runStatus: RunRecord["status"] = status === "completed" ? "completed" : status === "paused" || status === "recoverable_error" ? "paused" : status === "aborted" ? "cancelled" : "failed";
    const changeSetStatus: Exclude<ChangeSetStatus, "active"> = runStatus === "completed" ? "completed" : runStatus === "paused" ? "paused" : runStatus === "cancelled" ? "cancelled" : "failed";
    let outputPaths = this.runRecord.outputPaths ?? [];
    try { outputPaths = rebuildRunOutputPaths(await this.dependencies.changeSets.readChangeSet(this.runRecord.id), this.checkpointValue?.evidence ?? [], outputPaths); }
    catch { /* 文件面板刷新可稍后重建，不能覆盖运行的最终状态。 */ }
    await this.dependencies.changeSets.endRun(changeSetStatus);
    const consumedSteeringIds = this.checkpointValue?.steering.filter((item) => item.status === "delivered" && checkpointContainsSteering(this.checkpointValue!, item.id)).map((item) => item.id) ?? [];
    if (consumedSteeringIds.length) {
      await this.dependencies.consumeSteering?.(this.runRecord.id, consumedSteeringIds);
      for (const id of consumedSteeringIds) {
        const item = this.orchestrationSteering.get(id);
        if (item) this.orchestrationSteering.set(id, { ...item, status: "consumed" });
      }
      if (this.checkpointValue) await this.saveCheckpoint({ ...this.checkpointValue, steering: this.checkpointValue.steering.map((item) => consumedSteeringIds.includes(item.id) ? { ...item, status: "consumed" } : item), updatedAt: new Date().toISOString() });
    }
    await this.updateRun({ status: runStatus, outputPaths, ...(result.metrics ? { metrics: result.metrics } : {}) });
    const metrics = result.metrics ?? this.runRecord.metrics ?? emptyAgentRunMetrics();
    await this.observe({ at: new Date().toISOString(), runId: this.runRecord.id, taskId: this.runRecord.id, kind: "agent_settled", status, ...(result.reply ? { reply: result.reply } : {}), metrics, ...(this.checkpointValue ? { checkpoint: this.checkpointValue } : {}) });
    await this.updateRun({ settledAt: new Date().toISOString() });
  }

  private async updateRun(patch: Partial<RunRecord>): Promise<void> {
    this.runRecord = { ...this.runRecord, ...patch, updatedAt: new Date().toISOString() };
    await this.dependencies.conversations.putRun(this.runRecord);
  }
}

export function migrateAgentCheckpoint(value: unknown, runId: string): AgentCheckpointV2 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const checkpoint = value as AgentCheckpoint;
  if (checkpoint.version === 2) return checkpoint.runId === runId ? structuredClone(checkpoint) : undefined;
  if (checkpoint.version !== 1 || !Array.isArray(checkpoint.messages) || !Array.isArray(checkpoint.evidence)) return undefined;
  const evidence = checkpoint.evidence.filter(isToolEvidence);
  const completedToolCallIds = [...new Set(evidence.map((item) => item.callId))];
  const successfulToolResults = checkpoint.messages.flatMap((message) => {
    if (message.role !== "tool" || !message.toolCallId || !completedToolCallIds.includes(message.toolCallId)) return [];
    const matching = evidence.find((item) => item.callId === message.toolCallId);
    if (!matching) return [];
    return [{ callId: message.toolCallId, toolName: message.name ?? matching.toolName, content: messageText(message), effect: matching.effect, scope: matching.scope, completedAt: checkpoint.updatedAt }];
  });
  return {
    version: 2,
    stage: "after-tools",
    runId,
    turn: checkpoint.turn,
    requiredEvidence: checkpoint.requiredEvidence,
    messages: structuredClone(checkpoint.messages),
    pendingToolCalls: [],
    successfulToolResults,
    completedToolCallIds,
    evidence,
    metrics: { ...emptyAgentRunMetrics(), toolCalls: completedToolCallIds.length, successfulToolCalls: completedToolCallIds.length, newEvidenceCount: evidence.length },
    accumulatedFiles: [],
    runtimeErrors: [],
    steering: [],
    updatedAt: checkpoint.updatedAt
  };
}

export function rebuildRunOutputPaths(changeSet: ChangeSet | undefined, evidence: readonly ToolEvidence[], priorPaths: readonly string[] = []): string[] {
  const paths = new Set(priorPaths.filter(isPublicOutputPath));
  const remove = (path: string): void => { for (const current of paths) if (current === path || current.startsWith(`${path}/`)) paths.delete(current); };
  const writeCallIds = new Set(evidence.filter((item) => item.effect === "write").map((item) => item.callId));
  if (writeCallIds.size || changeSet?.changes.length) {
    for (const change of changeSet?.changes ?? []) {
      if (change.type === "delete" || change.type === "move") remove(change.path);
      else if (change.kind === "file" && isPublicOutputPath(change.path)) paths.add(change.path);
      if (change.kind === "file" && change.targetPath && isPublicOutputPath(change.targetPath)) paths.add(change.targetPath);
    }
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

export function shouldAutoStartFollowUp(run: Pick<RunRecord, "status" | "settledAt">, runtimeDeterministicFailure = false): boolean {
  return !runtimeDeterministicFailure && run.status === "completed" && Boolean(run.settledAt);
}

export function isPersistedLifecycleBoundary(event: AgentLifecycleEvent): boolean {
  return event.kind === "agent_start" || event.kind === "turn_start" || event.kind === "tool_execution_start" || event.kind === "tool_execution_end" || event.kind === "turn_end" || event.kind === "agent_end" || event.kind === "agent_settled";
}

function lifecycleEventContent(event: AgentLifecycleEvent): string {
  if (event.kind === "agent_start") return event.intent;
  if (event.kind === "turn_start" || event.kind === "turn_end") return `turn ${event.turn}`;
  if (event.kind === "tool_execution_start") return `${event.toolName} ${JSON.stringify(event.arguments)}`;
  if (event.kind === "tool_execution_end") return event.content;
  if (event.kind === "agent_end") return event.error ?? event.reply ?? event.status;
  if (event.kind === "agent_settled") return event.reply ?? event.status;
  return event.kind;
}

function isToolEvidence(value: unknown): value is ToolEvidence {
  return Boolean(value && typeof value === "object" && typeof (value as ToolEvidence).callId === "string" && typeof (value as ToolEvidence).toolName === "string");
}

function messageText(message: AgentModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((part): part is Extract<ModelContentPart, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n");
}

function checkpointContainsSteering(checkpoint: AgentCheckpointV2, steeringId: string): boolean {
  const marker = `[用户 Steering：${steeringId}]`;
  return checkpoint.messages.some((message) => typeof message.content === "string"
    ? message.content.includes(marker)
    : message.content.some((part) => part.type === "text" && part.text.includes(marker)));
}

function isPublicOutputPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("/.browser-agent/") && path !== "/.browser-agent";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
}
