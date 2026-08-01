import assert from "node:assert/strict";
import test from "node:test";
import { emptyAgentRunMetrics, type AgentCheckpointV2 } from "../packages/agent-kernel/src/protocol";
import { AgentSession, migrateAgentCheckpoint, rebuildRunOutputPaths, shouldAutoStartFollowUp, type AgentSessionDriver, type AgentSessionDriverResult } from "../packages/agent-session/src/index";
import type { RunRecord } from "../packages/persistence/src/index";
import type { ChangeSet, ChangeSetStatus } from "../packages/workspace-contracts/src/index";

test("AgentSession 恢复时复用 runId 与 ChangeSet，并保存逐工具检查点", async () => {
  const now = new Date().toISOString();
  let stored = runRecord(now, "paused");
  const changeSet = changeSetRecord(now, "paused");
  const actions: string[] = [];
  const events: string[] = [];
  const checkpoint = checkpointV2(now);
  stored.checkpoint = checkpoint;
  const driver: AgentSessionDriver = {
    async run(request): Promise<AgentSessionDriverResult> {
      assert.equal(request.runId, "run-1");
      assert.equal(request.resumeCheckpoint?.runId, "run-1");
      await request.onCheckpoint(checkpoint);
      return { status: "completed", checkpoint, metrics: checkpoint.metrics, reply: "完成" };
    }
  };
  const session = new AgentSession(stored, {
    conversations: { putRun: async (run) => { stored = structuredClone(run); } },
    changeSets: {
      beginRun: async () => { actions.push("begin"); return changeSet; },
      reopenRun: async (runId) => { actions.push(`reopen:${runId}`); changeSet.status = "active"; return changeSet; },
      endRun: async (status) => { actions.push(`end:${status}`); changeSet.status = status; return changeSet; },
      readChangeSet: async () => changeSet
    },
    driver,
    consumeSteering: async (runId) => { actions.push(`consume:${runId}`); },
    onEvent: (event) => { events.push(event.kind); }
  });
  const result = await session.resume();
  assert.equal(result.status, "completed");
  assert.deepEqual(actions, ["reopen:run-1", "end:completed"]);
  assert.equal(stored.id, "run-1");
  assert.equal(stored.changeSetId, "run-1");
  assert.deepEqual(stored.completedToolCallIds, ["call-1"]);
  assert.ok(stored.settledAt);
  assert.ok(events.includes("agent_settled"));
});

test("recoverable_error 先压缩检查点，再在同一 AgentSession 自动继续", async () => {
  const now = new Date().toISOString();
  let stored = runRecord(now, "running");
  const changeSet = changeSetRecord(now, "active");
  const checkpoint = checkpointV2(now);
  let calls = 0;
  let compactions = 0;
  const session = new AgentSession(stored, {
    conversations: { putRun: async (run) => { stored = structuredClone(run); } },
    changeSets: {
      beginRun: async () => changeSet,
      reopenRun: async () => changeSet,
      endRun: async (status) => { changeSet.status = status; return changeSet; },
      readChangeSet: async () => changeSet
    },
    driver: { run: async (request) => (++calls === 1 ? { status: "recoverable_error", errorKind: "context_overflow", checkpoint } : { status: "completed", ...(request.resumeCheckpoint ? { checkpoint: request.resumeCheckpoint } : {}) }) },
    compactCheckpoint: async (value) => { compactions += 1; return { ...value, stage: "compacted", compactionSummary: "已压缩" }; }
  });
  const result = await session.prompt({ intent: "修复" });
  assert.equal(result.status, "completed");
  assert.equal(calls, 2);
  assert.equal(compactions, 1);
  assert.equal(stored.status, "completed");
});

test("非 context_overflow 的可恢复错误保留检查点并暂停，不触发压缩", async () => {
  const now = new Date().toISOString();
  let stored = runRecord(now, "running");
  const changeSet = changeSetRecord(now, "active");
  const checkpoint = checkpointV2(now);
  let compactions = 0;
  const session = new AgentSession(stored, {
    conversations: { putRun: async (run) => { stored = structuredClone(run); } },
    changeSets: {
      beginRun: async () => changeSet,
      reopenRun: async () => changeSet,
      endRun: async (status) => { changeSet.status = status; return changeSet; },
      readChangeSet: async () => changeSet
    },
    driver: { run: async () => ({ status: "recoverable_error", errorKind: "runtime", checkpoint }) },
    compactCheckpoint: async (value) => { compactions += 1; return value; }
  });
  const result = await session.prompt({ intent: "修复" });
  assert.equal(result.status, "paused");
  assert.equal(compactions, 0);
  assert.equal(stored.status, "paused");
  assert.equal((stored.checkpoint as AgentCheckpointV2).stage, "paused");
});

test("仅在检查点已包含 Steering 消息后标记 consumed", async () => {
  const now = new Date().toISOString();
  let stored = runRecord(now, "running");
  const changeSet = changeSetRecord(now, "active");
  const checkpoint: AgentCheckpointV2 = {
    ...checkpointV2(now),
    messages: [{ role: "user", content: "[用户 Steering：steer-1]\n继续测试" }],
    steering: [{ id: "steer-1", content: "继续测试", status: "delivered" }]
  };
  let consumed: readonly string[] = [];
  const session = new AgentSession(stored, {
    conversations: { putRun: async (run) => { stored = structuredClone(run); } },
    changeSets: {
      beginRun: async () => changeSet,
      reopenRun: async () => changeSet,
      endRun: async (status) => { changeSet.status = status; return changeSet; },
      readChangeSet: async () => changeSet
    },
    driver: { run: async () => ({ status: "completed", checkpoint }) },
    consumeSteering: async (_runId, ids) => { consumed = ids; }
  });
  await session.prompt({ intent: "修复" });
  assert.deepEqual(consumed, ["steer-1"]);
  assert.equal((stored.checkpoint as AgentCheckpointV2).steering[0]?.status, "consumed");
});

test("v1 检查点迁移会从 evidence 与 tool message 推导已完成 callId", () => {
  const now = new Date().toISOString();
  const migrated = migrateAgentCheckpoint({
    version: 1,
    stage: "after-tools",
    turn: 3,
    requiredEvidence: "grounded",
    messages: [{ role: "tool", name: "workspace.write", toolCallId: "call-1", content: "ok" }],
    evidence: [{ callId: "call-1", toolName: "workspace.write", effect: "write", scope: "workspace" }],
    updatedAt: now
  }, "run-1");
  assert.equal(migrated?.version, 2);
  assert.deepEqual(migrated?.completedToolCallIds, ["call-1"]);
  assert.equal(migrated?.successfulToolResults[0]?.content, "ok");
});

test("最终文件从完整 ChangeSet 重建，过滤内部路径和删除项", () => {
  const now = new Date().toISOString();
  const changeSet = changeSetRecord(now, "completed");
  changeSet.changes = [
    { id: "1", runId: "run-1", type: "create", path: "/report.md", kind: "file", createdAt: now },
    { id: "2", runId: "run-1", type: "create", path: "/.browser-agent/runtime-tmp/a.mjs", kind: "file", createdAt: now },
    { id: "3", runId: "run-1", type: "delete", path: "/old.txt", kind: "file", createdAt: now }
  ];
  assert.deepEqual(rebuildRunOutputPaths(changeSet, [{ callId: "call-1", toolName: "workspace.write", effect: "write", scope: "workspace" }], ["/old.txt"]), ["/report.md"]);
  assert.equal(shouldAutoStartFollowUp({ status: "completed", settledAt: now }), true);
  assert.equal(shouldAutoStartFollowUp({ status: "completed" }), false);
  assert.equal(shouldAutoStartFollowUp({ status: "paused" }), false);
  assert.equal(shouldAutoStartFollowUp({ status: "completed" }, true), false);
});

function runRecord(now: string, status: RunRecord["status"]): RunRecord {
  return { id: "run-1", threadId: "thread-1", status, intent: "修复", changeSetId: "run-1", events: [], createdAt: now, updatedAt: now };
}

function changeSetRecord(now: string, status: ChangeSetStatus): ChangeSet {
  return { id: "changes-1", projectId: "project-1", runId: "run-1", status, changes: [], createdAt: now, updatedAt: now };
}

function checkpointV2(now: string): AgentCheckpointV2 {
  return {
    version: 2,
    stage: "after-tool",
    runId: "run-1",
    turn: 1,
    requiredEvidence: "grounded",
    messages: [],
    pendingToolCalls: [],
    successfulToolResults: [{ callId: "call-1", toolName: "workspace.write", content: "ok", effect: "write", scope: "workspace", completedAt: now }],
    completedToolCallIds: ["call-1"],
    evidence: [{ callId: "call-1", toolName: "workspace.write", effect: "write", scope: "workspace" }],
    metrics: { ...emptyAgentRunMetrics(), toolCalls: 1, successfulToolCalls: 1, newEvidenceCount: 1 },
    accumulatedFiles: ["/report.md"],
    runtimeErrors: [],
    steering: [],
    updatedAt: now
  };
}
