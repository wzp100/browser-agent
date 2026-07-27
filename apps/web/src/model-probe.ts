import type { ModelProvider } from "../../../packages/model-adapters/src/index";

export interface ModelProbeResult {
  text: boolean;
  toolCalling: boolean;
  imageInput: boolean;
  streaming: boolean;
  details: Record<string, string>;
}

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export async function probeModel(provider: ModelProvider, signal?: AbortSignal): Promise<ModelProbeResult> {
  const details: Record<string, string> = {};
  let text = false;
  let streaming = false;
  let toolCalling = false;
  let imageInput = false;

  try {
    let deltas = 0;
    const response = await provider.runTurn({
      messages: [
        { role: "system", content: "这是连接诊断。请严格按要求回复。" },
        { role: "user", content: "只回复 OK。" }
      ],
      tools: [],
      toolChoice: "none"
    }, (delta) => { if (delta) deltas += 1; }, signal);
    text = Boolean(response.text.trim());
    streaming = deltas > 0;
    details.text = text ? "文本响应正常" : "没有文本响应";
    details.streaming = streaming ? `收到 ${deltas} 个文本增量` : "未收到文本增量";
  } catch (error) {
    details.text = errorMessage(error);
    details.streaming = "文本请求失败，未测试";
  }

  try {
    const response = await provider.runTurn({
      messages: [{ role: "user", content: "调用 diagnostic.echo，并将 value 设为 probe。" }],
      tools: [{
        id: "diagnostic.echo",
        description: "连接诊断工具；必须调用。",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string", description: "固定填写 probe" } },
          required: ["value"],
          additionalProperties: false
        }
      }],
      toolChoice: "required"
    }, undefined, signal);
    toolCalling = response.toolCalls.some((call) => call.name === "diagnostic.echo");
    details.toolCalling = toolCalling ? "工具调用正常" : "模型没有返回要求的工具调用";
  } catch (error) {
    details.toolCalling = errorMessage(error);
  }

  try {
    const response = await provider.runTurn({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "这是连接诊断。用一个词描述这张图片。" },
          { type: "image", mimeType: "image/png", data: ONE_PIXEL_PNG }
        ]
      }],
      tools: [],
      toolChoice: "none"
    }, undefined, signal);
    imageInput = Boolean(response.text.trim());
    details.imageInput = imageInput ? "图片输入正常" : "图片请求没有文本响应";
  } catch (error) {
    details.imageInput = errorMessage(error);
  }

  return { text, toolCalling, imageInput, streaming, details };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
