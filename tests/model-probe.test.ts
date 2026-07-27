import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider } from "../packages/model-adapters/src/index";
import { probeModel } from "../apps/web/src/model-probe";

test("Quick Test 独立验证文本、流式、工具和图片能力", async () => {
  let requestNumber = 0;
  const provider: ModelProvider = {
    async runTurn(request, onTextDelta) {
      requestNumber += 1;
      if (requestNumber === 1) {
        await onTextDelta?.("O");
        await onTextDelta?.("K");
        return { text: "OK", toolCalls: [] };
      }
      if (requestNumber === 2) {
        assert.equal(request.toolChoice, "required");
        return { text: "", toolCalls: [{ id: "probe-1", name: "diagnostic.echo", arguments: { value: "probe" } }] };
      }
      assert.equal(Array.isArray(request.messages[0]?.content), true);
      return { text: "白色", toolCalls: [] };
    }
  };
  const result = await probeModel(provider);
  assert.deepEqual(
    { text: result.text, streaming: result.streaming, toolCalling: result.toolCalling, imageInput: result.imageInput },
    { text: true, streaming: true, toolCalling: true, imageInput: true }
  );
});

test("Quick Test 的单项失败不会掩盖其他能力", async () => {
  let requestNumber = 0;
  const provider: ModelProvider = {
    async runTurn() {
      requestNumber += 1;
      if (requestNumber === 2) throw new Error("tools unsupported");
      if (requestNumber === 3) throw new Error("images unsupported");
      return { text: "OK", toolCalls: [] };
    }
  };
  const result = await probeModel(provider);
  assert.equal(result.text, true);
  assert.equal(result.toolCalling, false);
  assert.equal(result.imageInput, false);
  assert.match(result.details.toolCalling ?? "", /tools unsupported/);
});
