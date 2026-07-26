import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkContextMessagesForSummary,
  DEFAULT_HISTORY_BUDGET_RATIO,
  FALLBACK_CONTEXT_WINDOW,
  MINIMUM_RECENT_MESSAGES,
  estimateTextTokens,
  resolveContextWindow,
  selectContextMessages
} from "../packages/context-manager/src/index";

test("摘要分块只在完整覆盖消息后推进完成计数", () => {
  const chunks = chunkContextMessagesForSummary(
    [{ content: "a".repeat(12) }, { content: "tail" }],
    (message) => message.content,
    5
  );
  assert.deepEqual(chunks.map((chunk) => chunk.completedMessages), [0, 0, 1, 1]);
  assert.equal(chunks.map((chunk) => chunk.content).join(""), `${"a".repeat(12)}tail`);
});

test("未知模型使用 32k 上下文且历史预算为 60%", () => {
  const selection = selectContextMessages([]);
  assert.equal(resolveContextWindow(undefined), FALLBACK_CONTEXT_WINDOW);
  assert.equal(selection.contextWindow, 32_000);
  assert.equal(selection.historyBudget, 19_200);
  assert.equal(DEFAULT_HISTORY_BUDGET_RATIO, 0.6);
});

test("上下文选择器保留连续的最近消息并把较早前缀交给摘要", () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({ content: `message-${index}` }));
  const selection = selectContextMessages(messages, {
    contextWindow: 100,
    historyBudgetRatio: 0.6,
    minimumRecentMessages: 2,
    estimateMessageTokens: () => 10
  });
  assert.deepEqual(selection.messagesToSummarize, messages.slice(0, 2));
  assert.deepEqual(selection.retainedMessages, messages.slice(2));
  assert.equal(selection.retainedEstimatedTokens, 60);
  assert.equal(selection.compressedMessageCount, 2);
  assert.equal(selection.exceedsBudget, false);
});

test("即使最近消息超过预算也至少保留 8 条完整消息", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({ content: String(index) }));
  const selection = selectContextMessages(messages, {
    contextWindow: 1_000,
    estimateMessageTokens: () => 100
  });
  assert.equal(MINIMUM_RECENT_MESSAGES, 8);
  assert.deepEqual(selection.retainedMessages, messages.slice(2));
  assert.equal(selection.retainedEstimatedTokens, 800);
  assert.equal(selection.exceedsBudget, true);
});

test("token 粗估对中文比 ASCII 更保守且会计入现有摘要", () => {
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("中文测试"), 4);
  const selection = selectContextMessages([{ content: "内容" }], { existingSummary: "旧摘要" });
  assert.ok(selection.summaryEstimatedTokens > 0);
  assert.equal(selection.totalEstimatedTokens, selection.retainedEstimatedTokens);
});
