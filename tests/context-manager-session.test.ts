import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentTaskCompactionState, selectCompleteToolRounds } from "../packages/context-manager/src/index";

test("任务内压缩摘要保留恢复所需的七类事实", () => {
  const summary = formatAgentTaskCompactionState({ goal: "修复运行时", completedWork: ["路径转换"], changedFiles: ["/a.ts", "/a.ts"], completedToolCallIds: ["call-1"], runtimeErrors: ["EISDIR"], steering: ["继续测试"], remainingWork: ["UI"], nextStep: "运行类型检查" });
  for (const expected of ["目标：修复运行时", "路径转换", "/a.ts", "call-1", "EISDIR", "继续测试", "UI", "运行类型检查"]) assert.ok(summary.includes(expected));
  assert.equal(summary.match(/\/a\.ts/g)?.length, 1);
});

test("最近 assistant toolCalls 与 tool 结果不可被预算拆分", () => {
  const messages = [
    { role: "user", content: "旧消息" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1" }] },
    { role: "tool", toolCallId: "call-1", content: "结果" }
  ];
  const selected = selectCompleteToolRounds(messages, 1, () => 1);
  assert.deepEqual(selected.retainedMessages.map((message) => message.role), ["assistant", "tool"]);
  assert.deepEqual(selected.messagesToSummarize.map((message) => message.role), ["user"]);
});
