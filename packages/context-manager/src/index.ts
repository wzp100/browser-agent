export const FALLBACK_CONTEXT_WINDOW = 32_000;
export const DEFAULT_HISTORY_BUDGET_RATIO = 0.6;
export const MINIMUM_RECENT_MESSAGES = 8;

export interface ContextMessageLike {
  content: string;
}

export interface ContextSelectionOptions<T extends ContextMessageLike> {
  contextWindow?: number;
  historyBudgetRatio?: number;
  minimumRecentMessages?: number;
  existingSummary?: string;
  estimateMessageTokens?: (message: T) => number;
}

export interface ContextSelection<T extends ContextMessageLike> {
  contextWindow: number;
  historyBudget: number;
  totalEstimatedTokens: number;
  retainedEstimatedTokens: number;
  summaryEstimatedTokens: number;
  retainedMessages: T[];
  messagesToSummarize: T[];
  compressedMessageCount: number;
  exceedsBudget: boolean;
}

export interface ContextSummaryChunk {
  content: string;
  completedMessages: number;
}

export interface AgentTaskCompactionState {
  goal: string;
  completedWork: string[];
  changedFiles: string[];
  completedToolCallIds: string[];
  runtimeErrors: string[];
  steering: string[];
  remainingWork: string[];
  nextStep: string;
}

export interface ToolRoundMessageLike {
  content: unknown;
  role?: string;
  toolCalls?: Array<{ id?: string }>;
  toolCallId?: string;
}

/** 对未知模型使用 32k，避免未发现模型能力时把无限历史送入请求。 */
export function resolveContextWindow(contextWindow?: number): number {
  return contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.floor(contextWindow)
    : FALLBACK_CONTEXT_WINDOW;
}

/**
 * 粗略 token 估算：ASCII 按约 4 字符/token，非 ASCII 按 1 字符/token，外加消息边界开销。
 * 该算法刻意不依赖 tokenizer，适合浏览器端预算选择与确定性测试。
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) character.codePointAt(0)! <= 0x7f ? ascii += 1 : nonAscii += 1;
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}

export function estimateMessageTokens(message: ContextMessageLike): number {
  return estimateTextTokens(message.content) + 4;
}

/**
 * 保留连续的最近历史。最近至少 8 条消息始终保持完整；更早内容按预算从近到远回填，
 * 未被保留的前缀交给调用方生成或更新滚动摘要。原消息不会被修改。
 */
export function selectContextMessages<T extends ContextMessageLike>(messages: readonly T[], options: ContextSelectionOptions<T> = {}): ContextSelection<T> {
  const contextWindow = resolveContextWindow(options.contextWindow);
  const ratio = validRatio(options.historyBudgetRatio) ? options.historyBudgetRatio : DEFAULT_HISTORY_BUDGET_RATIO;
  const historyBudget = Math.floor(contextWindow * ratio);
  const minimumRecent = nonNegativeInteger(options.minimumRecentMessages, MINIMUM_RECENT_MESSAGES);
  const estimate = options.estimateMessageTokens ?? estimateMessageTokens;
  const tokenCounts = messages.map((message) => Math.max(0, Math.ceil(estimate(message))));
  const summaryEstimatedTokens = options.existingSummary ? estimateTextTokens(options.existingSummary) + 4 : 0;
  const totalEstimatedTokens = tokenCounts.reduce((sum, count) => sum + count, summaryEstimatedTokens);

  let firstRetained = Math.max(0, messages.length - minimumRecent);
  let retainedEstimatedTokens = tokenCounts.slice(firstRetained).reduce((sum, count) => sum + count, summaryEstimatedTokens);
  while (firstRetained > 0) {
    const nextTokens = tokenCounts[firstRetained - 1] ?? 0;
    if (retainedEstimatedTokens + nextTokens > historyBudget) break;
    firstRetained -= 1;
    retainedEstimatedTokens += nextTokens;
  }

  const retainedMessages = messages.slice(firstRetained);
  const messagesToSummarize = messages.slice(0, firstRetained);
  return {
    contextWindow,
    historyBudget,
    totalEstimatedTokens,
    retainedEstimatedTokens,
    summaryEstimatedTokens,
    retainedMessages,
    messagesToSummarize,
    compressedMessageCount: messagesToSummarize.length,
    exceedsBudget: retainedEstimatedTokens > historyBudget
  };
}

/**
 * 将摘要输入按消息边界分块；超长单条消息会继续切段，且只有包含该消息最后一段的
 * chunk 才增加 completedMessages。调用方据此推进 throughSequence，避免截断后误标完成。
 */
export function chunkContextMessagesForSummary<T>(
  messages: readonly T[],
  format: (message: T) => string,
  maxCharacters = 100_000
): ContextSummaryChunk[] {
  const limit = Number.isFinite(maxCharacters) && maxCharacters > 0 ? Math.floor(maxCharacters) : 100_000;
  const chunks: ContextSummaryChunk[] = [];
  let content = "";
  let completedMessages = 0;
  const flush = (): void => {
    if (!content) return;
    chunks.push({ content, completedMessages });
    content = "";
    completedMessages = 0;
  };
  for (const message of messages) {
    const formatted = format(message);
    const pieces = formatted.length ? formatted.match(new RegExp(`[\\s\\S]{1,${limit}}`, "g")) ?? [""] : [""];
    for (let index = 0; index < pieces.length; index += 1) {
      const separator = content ? "\n\n" : "";
      if (content && content.length + separator.length + pieces[index]!.length > limit) flush();
      content += `${content ? "\n\n" : ""}${pieces[index]}`;
      if (index === pieces.length - 1) completedMessages += 1;
      if (content.length >= limit) flush();
    }
  }
  flush();
  return chunks;
}

/** 生成任务内压缩的稳定摘要骨架，确保恢复所需事实不会被自由摘要遗漏。 */
export function formatAgentTaskCompactionState(state: AgentTaskCompactionState): string {
  const section = (title: string, values: readonly string[]): string => `${title}：\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- 无"}`;
  return [
    `目标：${state.goal}`,
    section("已完成", state.completedWork),
    section("累计文件", [...new Set(state.changedFiles)]),
    section("成功 callId", [...new Set(state.completedToolCallIds)]),
    section("Runtime 错误", state.runtimeErrors),
    section("用户 Steering", state.steering),
    section("剩余任务", state.remainingWork),
    `下一步：${state.nextStep}`
  ].join("\n\n");
}

/**
 * 在给定预算下从后向前保留完整消息组。assistant toolCalls 与其后连续 tool 结果视为
 * 一个不可拆分回合，避免压缩留下悬空调用或孤立结果。
 */
export function selectCompleteToolRounds<T extends ToolRoundMessageLike>(messages: readonly T[], tokenBudget: number, estimate: (message: T) => number = estimateToolRoundMessageTokens): { retainedMessages: T[]; messagesToSummarize: T[] } {
  const groups: T[][] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    const group = [message];
    index += 1;
    if (message.role === "assistant" && message.toolCalls?.length) {
      const pending = new Set(message.toolCalls.flatMap((call) => call.id ? [call.id] : []));
      while (index < messages.length && messages[index]!.role === "tool") {
        const toolMessage = messages[index]!;
        group.push(toolMessage);
        if (toolMessage.toolCallId) pending.delete(toolMessage.toolCallId);
        index += 1;
        if (!pending.size && messages[index]?.role !== "tool") break;
      }
    }
    groups.push(group);
  }
  const budget = Math.max(0, Math.floor(tokenBudget));
  let retainedTokens = 0;
  let firstRetainedGroup = groups.length;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const groupTokens = groups[index]!.reduce((sum, message) => sum + Math.max(0, Math.ceil(estimate(message))), 0);
    if (firstRetainedGroup < groups.length && retainedTokens + groupTokens > budget) break;
    retainedTokens += groupTokens;
    firstRetainedGroup = index;
  }
  return {
    messagesToSummarize: groups.slice(0, firstRetainedGroup).flat(),
    retainedMessages: groups.slice(firstRetainedGroup).flat()
  };
}

function estimateToolRoundMessageTokens(message: ToolRoundMessageLike): number {
  return estimateTextTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content)) + 4;
}

function validRatio(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value) && value > 0 && value <= 1; }
function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
