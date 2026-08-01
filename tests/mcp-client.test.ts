import assert from "node:assert/strict";
import test from "node:test";
import { AgentToolRegistry } from "../packages/command-core/src/index";
import { McpHttpClient, registerConfiguredMcpTools } from "../packages/mcp-client/src/index";
import type { McpServerRecord } from "../packages/persistence/src/index";

const server: McpServerRecord = {
  id: "server-1",
  name: "Demo MCP",
  url: "https://mcp.example.test/mcp",
  enabled: true,
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z"
};

test("MCP Streamable HTTP 完成初始化、工具发现和调用，且同一连接只授权一次", async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  let authorizations = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    methods.push(body.method);
    const headers = body.method === "initialize" ? { "content-type": "application/json", "mcp-session-id": "session-1" } : { "content-type": "application/json" };
    if (body.method === "notifications/initialized") return new Response("", { status: 202, headers });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "demo", version: "1" } } }, { headers });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lookup", description: "查找条目", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }] } }, { headers });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "结果" }] } }, { headers });
  }) as typeof fetch;
  try {
    const client = new McpHttpClient(server, async () => { authorizations += 1; });
    const tools = await client.listTools();
    const result = await client.callTool("lookup", { query: "测试" }) as { untrustedExternalContent?: boolean };
    assert.equal(tools[0]?.name, "lookup");
    assert.equal(result.untrustedExternalContent, true);
    assert.equal(authorizations, 1);
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("启用的 MCP 工具注册到 AgentToolRegistry 并标记为网络执行", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; id?: number };
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { ok: true } });
  }) as typeof fetch;
  try {
    const registry = new AgentToolRegistry();
    const configured = { ...server, cachedTools: [{ name: "lookup", inputSchema: { type: "object" } }] };
    const connections = await registerConfiguredMcpTools(registry, [configured], async () => undefined);
    const tool = registry.list()[0];
    assert.equal(connections[0]?.tools.length, 1);
    assert.equal(tool?.scope, "network");
    assert.equal(tool?.effect, "execute");
    assert.match(tool?.id ?? "", /^mcp\./);
    assert.deepEqual(await registry.execute(tool!.id, {}), { server: "Demo MCP", result: { ok: true }, untrustedExternalContent: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
