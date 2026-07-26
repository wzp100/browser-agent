import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLangChainModelProvider, type ModelTurnRequest } from "../../../packages/model-adapters/src/index";

const port = Number(process.env.PORT ?? 8787);
let apiKey = process.env.OPENAI_API_KEY;
let legacyDefaultModel = process.env.OPENAI_MODEL ?? "gpt-5.6";
if (!apiKey) console.warn("Gateway 未配置密钥；可从浏览器设置页临时配置到本进程内存。 ");

createServer(async (request, response) => {
  setCors(response);
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
  try {
    if (request.method === "GET" && request.url === "/health") return json(response, 200, { ok: Boolean(apiKey), model: legacyDefaultModel, keyLocation: "gateway-memory" });
    if (request.method === "GET" && request.url === "/v1/models") {
      if (!apiKey) return json(response, 503, { error: "Gateway 未配置 API Key。请在浏览器设置页填写并保存。" });
      return proxyModels(response, apiKey);
    }
    if (request.method === "POST" && request.url === "/v1/settings/model") {
      const settings = await readJson<{ apiKey?: string; model?: string }>(request);
      if (settings.apiKey) apiKey = settings.apiKey;
      if (settings.model) legacyDefaultModel = settings.model;
      return json(response, 200, { ok: Boolean(apiKey), model: legacyDefaultModel, keyLocation: "gateway-memory" });
    }
    if (request.method === "POST" && request.url === "/v1/agent/turn") {
      if (!apiKey) return json(response, 503, { error: "Gateway 未配置 API Key。请在浏览器设置页填写并保存。" });
      const turn = await readJson<ModelTurnRequest>(request);
      const requestedModel = normalizeModelId(turn.modelId) ?? legacyDefaultModel;
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      response.once("close", () => { if (!response.writableEnded) controller.abort(); });
      return streamTurn(response, turn, apiKey, requestedModel, controller.signal);
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    if (response.headersSent) { writeSse(response, { type: "error", error: errorMessage(error) }); response.end(); return; }
    return json(response, 500, { error: errorMessage(error) });
  }
}).listen(port, "127.0.0.1", () => console.log(`browser agent gateway listening on http://127.0.0.1:${port}`));

async function streamTurn(response: ServerResponse, turn: ModelTurnRequest, currentApiKey: string, modelId: string, signal: AbortSignal): Promise<void> {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  response.flushHeaders();
  try {
    const provider = createLangChainModelProvider({ provider: "openai", endpoint: "https://api.openai.com/v1/responses", model: modelId, apiKey: currentApiKey });
    const result = await provider.runTurn(turn, (delta) => { writeSse(response, { type: "text-delta", delta }); }, signal);
    writeSse(response, { type: "turn-complete", response: result });
  } catch (error) {
    writeSse(response, { type: "error", error: errorMessage(error) });
  } finally {
    response.end();
  }
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 24 * 1024 * 1024) throw new Error("请求过大。 ");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
async function proxyModels(response: ServerResponse, currentApiKey: string): Promise<void> {
  const upstream = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${currentApiKey}` } });
  const body = await upstream.text();
  response.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8" }).end(body);
}
function normalizeModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const modelId = value.trim();
  if (!modelId || modelId.length > 200 || /[\u0000-\u001f]/.test(modelId)) throw new Error("modelId 无效。");
  return modelId;
}
function writeSse(response: ServerResponse, value: unknown): void { response.write(`data: ${JSON.stringify(value)}\n\n`); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function setCors(response: ServerResponse): void { response.setHeader("Access-Control-Allow-Origin", "http://localhost:5173"); response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); response.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept"); }
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value)); }
