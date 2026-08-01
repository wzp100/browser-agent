import { ChatDeepSeek } from "@langchain/deepseek";
import type { BaseChatModel, BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, type AIMessageChunk, type BaseMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { concat } from "@langchain/core/utils/stream";
import { ChatOpenAI } from "@langchain/openai";
import type { JsonSchema } from "../../command-core/src/index";
import { logger } from "../../logging/src/index";

const modelLog = logger("model.provider");

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";
export type ModelContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/jpeg" | "image/png" | "image/webp"; data: string; attachmentId?: string };
export interface ConversationTurn { role: "user" | "assistant"; content: string | ModelContentPart[]; }
export interface ModelToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface AgentModelMessage { role: ModelMessageRole; content: string | ModelContentPart[]; name?: string; toolCallId?: string; toolCalls?: ModelToolCall[]; reasoningContent?: string; }
export interface AgentModelTool { id: string; description: string; inputSchema: JsonSchema; }
export type ModelToolChoice = "auto" | "required" | "none";
export interface ModelTurnRequest { messages: AgentModelMessage[]; tools: AgentModelTool[]; toolChoice?: ModelToolChoice; modelId?: string; }
export interface ModelUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number; }
export interface ModelTurnResponse { text: string; toolCalls: ModelToolCall[]; reasoningContent?: string; usage?: ModelUsage; }
export type ModelTextDeltaObserver = (delta: string) => void | Promise<void>;
export interface ModelProvider { runTurn(request: ModelTurnRequest, onTextDelta?: ModelTextDeltaObserver, signal?: AbortSignal): Promise<ModelTurnResponse>; }

export class MockModelProvider implements ModelProvider {
  constructor(private readonly turns: ModelTurnResponse[] = [{ text: "Mock 回复。", toolCalls: [] }]) {}
  async runTurn(_request: ModelTurnRequest, onTextDelta?: ModelTextDeltaObserver, signal?: AbortSignal): Promise<ModelTurnResponse> {
    signal?.throwIfAborted();
    const response = this.turns.shift() ?? { text: "Mock 已完成。", toolCalls: [] };
    if (response.text) await onTextDelta?.(response.text);
    return response;
  }
}

export type LangChainProviderKind = "openai" | "deepseek";
export interface LangChainModelOptions {
  provider: LangChainProviderKind;
  endpoint: string;
  model: string;
  apiKey: string;
}

export class LangChainModelProvider implements ModelProvider {
  private forcedToolChoiceUnsupported = false;

  constructor(
    private readonly chatModel: BaseChatModel,
    private readonly providerName = "langchain",
    private readonly endpoint = ""
  ) {}

  async runTurn(request: ModelTurnRequest, onTextDelta?: ModelTextDeltaObserver, signal?: AbortSignal): Promise<ModelTurnResponse> {
    signal?.throwIfAborted();
    const startedAt = performance.now();
    const wireToToolId = new Map(request.tools.map((tool) => [wireName(tool.id), tool.id]));
    const langChainTools: BindToolsInput[] = request.tools.map((tool) => ({
      type: "function",
      function: { name: wireName(tool.id), description: tool.description, parameters: tool.inputSchema }
    }));
    const requestedToolChoice = request.toolChoice ?? "auto";
    const initialToolChoice = this.forcedToolChoiceUnsupported ? undefined : requestedToolChoice;
    let emittedText = false;

    const execute = async (toolChoice: ModelToolChoice | undefined): Promise<ModelTurnResponse> => {
      const runnable = langChainTools.length
        ? toolChoice === undefined
          ? this.chatModel.bindTools?.(langChainTools)
          : this.chatModel.bindTools?.(langChainTools, { tool_choice: toolChoice })
        : this.chatModel;
      if (!runnable) throw new Error(`当前 LangChain ${this.providerName} 模型不支持工具调用。`);

      modelLog.info("发送 LangChain 模型回合", {
        provider: this.providerName,
        endpointOrigin: endpointOrigin(this.endpoint),
        messages: request.messages.length,
        tools: request.tools.length,
        requestedToolChoice,
        toolChoice: toolChoice ?? "omitted"
      });

      let combined: AIMessageChunk | undefined;
      let streamedText = "";
      const stream = await runnable.stream(request.messages.map((message) => toLangChainMessage(message)), signal ? { signal } : undefined);
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        combined = combined ? concat(combined, chunk) : chunk;
        const delta = chunk.text;
        if (delta) {
          emittedText = true;
          streamedText += delta;
          await onTextDelta?.(delta);
        }
      }

      const text = streamedText || combined?.text || "";
      if (!streamedText && text) {
        emittedText = true;
        await onTextDelta?.(text);
      }
      const toolCalls = (combined?.tool_calls ?? []).map((call) => ({
        id: call.id ?? crypto.randomUUID(),
        name: wireToToolId.get(call.name) ?? call.name.replace(/__/g, "."),
        arguments: normalizeArguments(call.args)
      }));
      const reasoningContent = stringValue(combined?.additional_kwargs?.reasoning_content);
      if (combined?.invalid_tool_calls?.length) modelLog.warn("LangChain 返回无法解析的工具调用", { provider: this.providerName, count: combined.invalid_tool_calls.length });
      modelLog.info("LangChain 模型回合完成", {
        provider: this.providerName,
        textCharacters: text.length,
        toolCalls: toolCalls.length,
        elapsedMs: Math.round(performance.now() - startedAt)
      });
      return { text, toolCalls, ...(reasoningContent ? { reasoningContent } : {}) };
    };

    try {
      return await execute(initialToolChoice);
    } catch (error) {
      if (initialToolChoice === undefined || emittedText || !isThinkingToolChoiceCompatibilityError(error)) throw error;
      this.forcedToolChoiceUnsupported = true;
      modelLog.warn("思考模式不支持 tool_choice，已省略参数并重试", {
        provider: this.providerName,
        endpointOrigin: endpointOrigin(this.endpoint),
        requestedToolChoice,
        fallbackToolChoice: "omitted"
      });
      return execute(undefined);
    }
  }
}

export function createLangChainModelProvider(options: LangChainModelOptions): LangChainModelProvider {
  if (!options.apiKey) throw new Error(options.provider === "deepseek" ? "请先在设置中输入 DeepSeek API Key。 " : "请先在设置中输入 API Key。 ");
  const configuration = {
    baseURL: modelBaseUrl(options.endpoint, options.provider),
    dangerouslyAllowBrowser: true
  };
  const chatModel: BaseChatModel = options.provider === "deepseek"
    ? new ChatDeepSeek({ apiKey: options.apiKey, model: options.model, streaming: true, streamUsage: false, configuration })
    : new ChatOpenAI({ apiKey: options.apiKey, model: options.model, streaming: true, useResponsesApi: true, configuration });
  return new LangChainModelProvider(chatModel, options.provider, options.endpoint);
}

export class GatewayModelProvider implements ModelProvider {
  constructor(private readonly gatewayUrl: string, private readonly modelId?: string) {}
  async runTurn(request: ModelTurnRequest, onTextDelta?: ModelTextDeltaObserver, signal?: AbortSignal): Promise<ModelTurnResponse> {
    signal?.throwIfAborted();
    const startedAt = performance.now();
    modelLog.info("发送 Gateway 模型回合", { endpointOrigin: endpointOrigin(this.gatewayUrl), messages: request.messages.length, tools: request.tools.length });
    const response = await fetch(`${this.gatewayUrl.replace(/\/$/, "")}/v1/agent/turn`, {
      method: "POST",
      headers: { "Accept": "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, modelId: request.modelId ?? this.modelId }),
      ...(signal ? { signal } : {})
    });
    modelLog.info("Gateway 响应头已收到", { status: response.status, contentType: response.headers.get("content-type"), elapsedMs: Math.round(performance.now() - startedAt) });
    if (!response.ok) throw new Error(await responseError(response, `Gateway 返回 ${response.status}`));
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      const body = await response.json() as Partial<ModelTurnResponse> & { error?: string };
      if (body.error) throw new Error(body.error);
      const normalized = normalizeTurn(body);
      if (normalized.text) await onTextDelta?.(normalized.text);
      return normalized;
    }
    let streamedText = "";
    let result: ModelTurnResponse | undefined;
    await readSse(response, async (data) => {
      const event = parseJson<GatewayStreamEvent>(data);
      if (event.type === "text-delta" && event.delta) {
        streamedText += event.delta;
        await onTextDelta?.(event.delta);
      } else if (event.type === "turn-complete" && event.response) result = normalizeTurn(event.response);
      else if (event.type === "error") throw new Error(event.error || "Gateway 流式响应失败。");
    }, signal);
    if (!result) throw new Error("Gateway 流式响应未正常结束。");
    return { ...result, text: result.text || streamedText };
  }
}

interface GatewayStreamEvent { type?: "text-delta" | "turn-complete" | "error"; delta?: string; response?: Partial<ModelTurnResponse>; error?: string; }

function toLangChainMessage(message: AgentModelMessage): BaseMessage {
  if (message.role === "system") return new SystemMessage(textContent(message.content));
  if (message.role === "user") return new HumanMessage(toLangChainContent(message.content));
  if (message.role === "assistant") {
    if (!message.toolCalls?.length) return new AIMessage(toLangChainContent(message.content));
    return new AIMessage({
      content: toLangChainContent(message.content),
      ...(message.reasoningContent ? { additional_kwargs: { reasoning_content: message.reasoningContent } } : {}),
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, name: wireName(call.name), args: call.arguments, type: "tool_call" }))
    });
  }
  if (!message.toolCallId) return new HumanMessage(`[工具 ${message.name ?? "unknown"} 返回]\n${textContent(message.content)}`);
  return new ToolMessage({
    content: textContent(message.content),
    tool_call_id: message.toolCallId,
    ...(message.name ? { name: wireName(message.name) } : {})
  });
}

function modelBaseUrl(endpoint: string, provider: LangChainProviderKind): string {
  const trimmed = endpoint.trim().replace(/\/$/, "");
  return provider === "deepseek" ? trimmed.replace(/\/chat\/completions$/i, "") : trimmed.replace(/\/responses$/i, "");
}

function wireName(id: string): string { return id.replace(/\./g, "__").slice(0, 64); }
function normalizeArguments(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function normalizeTurn(value: Partial<ModelTurnResponse>): ModelTurnResponse {
  const reasoningContent = stringValue(value.reasoningContent);
  return {
    text: typeof value.text === "string" ? value.text : "",
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls.filter((call): call is ModelToolCall => Boolean(call && call.id && call.name && call.arguments && typeof call.arguments === "object")) : [],
    ...(reasoningContent ? { reasoningContent } : {})
  };
}
function parseJson<T>(value: string): T { try { return JSON.parse(value) as T; } catch { throw new Error("模型返回了无效的流式 JSON 数据。"); } }

async function readSse(response: Response, onData: (data: string) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!response.body) throw new Error("模型响应没有可读取的流。");
  const reader = response.body.getReader();
  const cancelReader = () => { void reader.cancel(signal?.reason); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data && data !== "[DONE]") await onData(data);
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const data = buffer.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data && data !== "[DONE]") await onData(data);
  } finally {
    signal?.removeEventListener("abort", cancelReader);
  }
}

function toLangChainContent(content: AgentModelMessage["content"]): string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text"
    ? { type: "text" as const, text: part.text }
    : { type: "image_url" as const, image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
}

function textContent(content: AgentModelMessage["content"]): string {
  return typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string | { message?: string }; message?: string };
    if (typeof body.error === "string") return body.error;
    return body.error?.message ?? body.message ?? fallback;
  } catch { return fallback; }
}
function endpointOrigin(value: string): string { try { return new URL(value).origin; } catch { return "invalid-url"; } }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function isThinkingToolChoiceCompatibilityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /tool_choice/i.test(message)
    && /(?:thinking mode|extended thinking|reasoner)/i.test(message)
    && /(?:does not support|not supported|unsupported)/i.test(message);
}
