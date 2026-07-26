import assert from "node:assert/strict";
import test from "node:test";
import { validateModelSettings } from "../apps/web/src/model-settings";

test("模型配置拒绝空值、无效网址和非 HTTP 协议", () => {
  assert.deepEqual(validateModelSettings({ mode: "direct", endpoint: "", model: "gpt-5.4" }), { ok: false, message: "Endpoint 和模型不能为空。" });
  assert.deepEqual(validateModelSettings({ mode: "direct", endpoint: "not-a-valid-url", model: "gpt-5.4" }), { ok: false, message: "API Endpoint 不是有效的网址。" });
  assert.deepEqual(validateModelSettings({ mode: "direct", endpoint: "file:///tmp/api", model: "gpt-5.4" }), { ok: false, message: "API Endpoint 仅支持 HTTP 或 HTTPS。" });
});

test("模型配置规范化空白并拒绝在网址中夹带凭据", () => {
  assert.deepEqual(validateModelSettings({ mode: "gateway", endpoint: "http://user:secret@127.0.0.1:8787", model: "gpt-5.4" }), { ok: false, message: "请勿在 API Endpoint 中包含用户名或密码。" });
  assert.deepEqual(validateModelSettings({ mode: "gateway", endpoint: "  http://127.0.0.1:8787  ", model: "  gpt-5.4  " }), {
    ok: true,
    settings: { key: "model", mode: "gateway", endpoint: "http://127.0.0.1:8787", model: "gpt-5.4" }
  });
});
