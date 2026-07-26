import assert from "node:assert/strict";
import test from "node:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { fakeModel } from "@langchain/core/testing";
import { GatewayModelProvider, LangChainModelProvider, type ModelTurnRequest } from "../packages/model-adapters/src/index";

const request: ModelTurnRequest = {
  messages: [{ role: "user", content: "请使用 Markdown 回复" }],
  tools: [{ id: "workspace.list", description: "列出文件", inputSchema: { type: "object" } }]
};

test("LangChain Provider 输出文本并还原工具名称", async () => {
  const model = fakeModel().respond(new AIMessage({
    content: "## 标题\n\n**加粗**",
    tool_calls: [{ id: "call-1", name: "workspace__list", args: { path: "/" }, type: "tool_call" }]
  }));
  const deltas: string[] = [];
  const result = await new LangChainModelProvider(model, "test").runTurn(request, (delta) => { deltas.push(delta); });
  assert.deepEqual(deltas, ["## 标题\n\n**加粗**"]);
  assert.equal(result.text, "## 标题\n\n**加粗**");
  assert.deepEqual(result.toolCalls, [{ id: "call-1", name: "workspace.list", arguments: { path: "/" } }]);
});

test("LangChain Provider 使用 AIMessage 和 ToolMessage 传递工具上下文", async () => {
  const model = fakeModel().respond((messages) => {
    assert.ok(messages[0] instanceof AIMessage);
    assert.equal(messages[0].tool_calls?.[0]?.name, "workspace__list");
    assert.equal(messages[0].additional_kwargs.reasoning_content, "我需要先读取目录");
    assert.ok(messages[1] instanceof ToolMessage);
    assert.equal(messages[1].tool_call_id, "call-1");
    assert.equal(messages[1].name, "workspace__list");
    return new AIMessage("已完成");
  });
  const provider = new LangChainModelProvider(model, "test");
  const result = await provider.runTurn({
    messages: [
      { role: "assistant", content: "", reasoningContent: "我需要先读取目录", toolCalls: [{ id: "call-1", name: "workspace.list", arguments: {} }] },
      { role: "tool", name: "workspace.list", toolCallId: "call-1", content: "[]" }
    ],
    tools: []
  });
  assert.deepEqual(result, { text: "已完成", toolCalls: [] });
});

test("思考模式拒绝 tool_choice 时自动省略参数并记住兼容性", async () => {
  const toolChoices: string[] = [];
  const model = {
    bindTools: (_tools: unknown, options?: { tool_choice?: string }) => {
      const toolChoice = options?.tool_choice ?? "omitted";
      toolChoices.push(toolChoice);
      return {
        stream: async function* () {
          if (toolChoice !== "omitted") throw new Error("400 Thinking mode does not support this tool_choice");
          yield new AIMessageChunk("完成");
        }
      };
    }
  } as unknown as BaseChatModel;
  const provider = new LangChainModelProvider(model, "thinking-test");
  const requiredRequest = { ...request, toolChoice: "required" as const };

  assert.deepEqual(await provider.runTurn(requiredRequest), { text: "完成", toolCalls: [] });
  assert.deepEqual(await provider.runTurn({ ...request, toolChoice: "auto" }), { text: "完成", toolCalls: [] });
  assert.deepEqual(toolChoices, ["required", "omitted", "omitted"]);
});

test("LangChain Provider 从思考工具响应中保留 reasoning_content", async () => {
  const model = fakeModel().respond(new AIMessageChunk({
    content: "",
    additional_kwargs: { reasoning_content: "先查看项目文件" },
    tool_calls: [{ id: "call-2", name: "workspace__list", args: {}, type: "tool_call" }]
  }));
  const result = await new LangChainModelProvider(model, "thinking-test").runTurn(request);
  assert.equal(result.reasoningContent, "先查看项目文件");
  assert.deepEqual(result.toolCalls, [{ id: "call-2", name: "workspace.list", arguments: {} }]);
});

test("Gateway Provider 消费自定义 SSE 并保留最终工具结果", async () => {
  await withFetch(async () => sseResponse([
    { type: "text-delta", delta: "流式" },
    { type: "text-delta", delta: " Markdown" },
    { type: "turn-complete", response: { text: "流式 Markdown", toolCalls: [] } }
  ]), async () => {
    const deltas: string[] = [];
    const result = await new GatewayModelProvider("http://127.0.0.1:8787").runTurn(request, (delta) => { deltas.push(delta); });
    assert.deepEqual(deltas, ["流式", " Markdown"]);
    assert.deepEqual(result, { text: "流式 Markdown", toolCalls: [] });
  });
});

async function withFetch(factory: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = factory;
  try { await run(); } finally { globalThis.fetch = original; }
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const payload = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
  const midpoint = Math.floor(payload.length / 2);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload.slice(0, midpoint)));
      controller.enqueue(encoder.encode(payload.slice(midpoint)));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}
