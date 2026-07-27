import assert from "node:assert/strict";
import test from "node:test";
import { ToolLoopDetector } from "../packages/agent-kernel/src/index";

test("工具循环检测忽略时间戳和对象键顺序", () => {
  const detector = new ToolLoopDetector();
  let warning = "";
  for (let index = 0; index < 3; index += 1) {
    const observation = detector.inspect(
      "workspace.read",
      index % 2 ? { path: "/a.txt", callId: `call-${index}` } : { callId: `call-${index}`, path: "/a.txt" },
      JSON.stringify({ updatedAt: `2026-07-26T00:00:0${index}.000Z`, content: "same" })
    );
    warning = observation.warning ?? warning;
  }
  assert.match(warning, /连续 3 次/);
});

test("工具循环检测允许结果发生进展", () => {
  const detector = new ToolLoopDetector();
  for (let index = 0; index < 10; index += 1) {
    const observation = detector.inspect("workspace.read", { path: "/a.txt" }, JSON.stringify({ content: String(index) }));
    assert.equal(observation.warning, undefined);
    assert.equal(observation.blocked, undefined);
  }
});

test("轮询工具持续无进展时会阻断", () => {
  const detector = new ToolLoopDetector();
  let blocked = "";
  for (let index = 0; index < 6; index += 1) {
    blocked = detector.inspect("workspace.list", { path: "/" }, "[]").blocked ?? blocked;
  }
  assert.match(blocked, /已停止以避免无进展循环/);
});

test("交替调用不同工具也能识别各自没有进展", () => {
  const detector = new ToolLoopDetector();
  let warning = "";
  for (let index = 0; index < 3; index += 1) {
    warning = detector.inspect("workspace.read", { path: "/a.txt" }, "{\"content\":\"same\"}").warning ?? warning;
    detector.inspect("workspace.list", { path: "/" }, "[]");
  }
  assert.match(warning, /workspace\.read/);
});
