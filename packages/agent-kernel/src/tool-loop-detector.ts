const VOLATILE_KEYS = new Set([
  "callid",
  "createdat",
  "duration",
  "durationms",
  "elapsed",
  "elapsedms",
  "requestid",
  "timestamp",
  "tool_title",
  "traceid",
  "updatedat"
]);

const POLLING_TOOLS = new Set([
  "browser.snapshot",
  "browser.tabs.list",
  "conversation.get_context",
  "runtime.info",
  "workspace.list",
  "workspace.read"
]);

export interface ToolLoopObservation {
  warning?: string;
  blocked?: string;
  repeatCount: number;
}

interface ToolLoopRecord {
  signature: string;
  resultHash: string;
}

export class ToolLoopDetector {
  private readonly history: ToolLoopRecord[] = [];

  inspect(toolName: string, argumentsValue: Record<string, unknown>, result: string): ToolLoopObservation {
    const record = {
      signature: `${toolName}:${stableValue(argumentsValue)}`,
      resultHash: stableResult(result)
    };
    this.history.push(record);
    if (this.history.length > 30) this.history.shift();

    let repeatCount = 0;
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const previous = this.history[index]!;
      if (previous.signature !== record.signature) continue;
      if (previous.resultHash !== record.resultHash) break;
      repeatCount += 1;
    }

    const polling = POLLING_TOOLS.has(toolName);
    const warningAt = polling ? 3 : 4;
    const blockAt = polling ? 6 : 7;
    if (repeatCount >= blockAt) {
      return {
        repeatCount,
        blocked: `工具 ${toolName} 以相同参数连续得到相同结果 ${repeatCount} 次，已停止以避免无进展循环。`
      };
    }
    if (repeatCount >= warningAt) {
      return {
        repeatCount,
        warning: `检测到工具 ${toolName} 已连续 ${repeatCount} 次得到相同结果。请改变参数、改用其他工具，或根据现有证据结束任务。`
      };
    }
    return { repeatCount };
  }
}

function stableResult(result: string): string {
  try {
    return stableValue(JSON.parse(result));
  } catch {
    return result
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
      .trim();
  }
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => !VOLATILE_KEYS.has(key.toLowerCase()))
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}
