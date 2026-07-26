import assert from "node:assert/strict";
import test from "node:test";
import { CompositeLogSink, EnabledLogSink, configureLogging, flushLogs, logger, type AppLogRecord } from "../packages/logging/src/index";

test("诊断日志包含时间、级别、模块、错误栈并脱敏敏感字段", async () => {
  const records: AppLogRecord[] = [];
  configureLogging({
    level: "trace",
    sink: { write: async (record) => { records.push(record); } }
  });
  const log = logger("test.logging");
  log.debug("开始排查", { projectId: "project-1", apiKey: "sk-should-not-appear" });
  log.error("启动失败", { authorization: "Bearer secret", nested: { password: "hidden" } }, new Error("Unable to create more instances"));
  log.error("请求失败 sk-proj-abcdefghijklmnopqrstuvwxyz", { note: "Authorization: Bearer abcdefghijklmnop", url: "https://example.com/?api_key=secret-value" }, new Error("token=very-secret-token-value"));
  await flushLogs();

  const debug = records.find((record) => record.message === "开始排查");
  const failure = records.find((record) => record.message === "启动失败");
  assert.equal(debug?.level, "debug");
  assert.equal(debug?.scope, "test.logging");
  assert.match(debug?.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(debug?.context?.apiKey, "[已隐藏]");
  assert.equal(failure?.context?.authorization, "[已隐藏]");
  assert.equal((failure?.context?.nested as Record<string, unknown>)?.password, "[已隐藏]");
  assert.equal(failure?.errorMessage, "Unable to create more instances");
  assert.match(failure?.stack ?? "", /Error: Unable to create more instances/);
  assert.doesNotMatch(JSON.stringify(records), /sk-should-not-appear|Bearer secret|sk-proj-|abcdefghijklmnop|secret-value|very-secret-token-value/);
});

test("复合日志 sink 独立写入多个目标且支持即时关闭单个目标", async () => {
  const first: AppLogRecord[] = [];
  const second: AppLogRecord[] = [];
  const optional = new EnabledLogSink({ write: async (record) => { second.push(record); } });
  const sink = new CompositeLogSink([
    { write: async (record) => { first.push(record); } },
    optional
  ]);
  const record: AppLogRecord = { id: "1", timestamp: "2026-07-20T00:00:00.000Z", level: "info", scope: "test", message: "one" };
  await sink.write(record);
  optional.setEnabled(false);
  await sink.write({ ...record, id: "2", message: "two" });
  assert.deepEqual(first.map((item) => item.id), ["1", "2"]);
  assert.deepEqual(second.map((item) => item.id), ["1"]);
});
