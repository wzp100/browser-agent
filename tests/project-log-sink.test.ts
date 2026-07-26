import assert from "node:assert/strict";
import test from "node:test";
import type { AppLogRecord } from "../packages/logging/src/index";
import { BROWSER_AGENT_LOG_DIRECTORY, ProjectFileLogSink, type ProjectFileEntry, type ProjectFileChange } from "../packages/workspace-contracts/src/index";

test("项目日志以 UTF-8 JSONL 写入、达到上限后轮转并清理七日前文件", async () => {
  const first = record("first", "测试一");
  const second = record("second", "测试二");
  const encoder = new TextEncoder();
  const combinedBytes = encoder.encode(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`).byteLength;
  const files = new MemoryProjectFiles();
  files.seed(`${BROWSER_AGENT_LOG_DIRECTORY}/2026-07-13.1.jsonl`, "expired\n");
  files.seed(`${BROWSER_AGENT_LOG_DIRECTORY}/2026-07-14.1.jsonl`, "retained\n");
  const sink = new ProjectFileLogSink(files, {
    maxFileBytes: combinedBytes - 1,
    retentionDays: 7,
    now: () => new Date("2026-07-20T12:00:00.000Z")
  });

  await sink.write(first);
  await sink.write(second);

  assert.equal(files.has(`${BROWSER_AGENT_LOG_DIRECTORY}/2026-07-13.1.jsonl`), false);
  assert.equal(files.has(`${BROWSER_AGENT_LOG_DIRECTORY}/2026-07-14.1.jsonl`), true);
  assert.equal(files.text(`${BROWSER_AGENT_LOG_DIRECTORY}/2026-07-20.1.jsonl`), `${JSON.stringify(first)}\n`);
  assert.equal(files.text(`${BROWSER_AGENT_LOG_DIRECTORY}/2026-07-20.2.jsonl`), `${JSON.stringify(second)}\n`);
  assert.equal(new TextDecoder().decode(encoder.encode(files.text(`${BROWSER_AGENT_LOG_DIRECTORY}/2026-07-20.1.jsonl`))), `${JSON.stringify(first)}\n`);
});

test("项目日志 sink 忽略自身文件操作日志以阻止递归", async () => {
  const files = new MemoryProjectFiles();
  const sink = new ProjectFileLogSink(files);
  await sink.write({ ...record("self", "内部写入"), scope: "workspace.files" });
  assert.equal(files.entries().length, 0);
});

function record(id: string, message: string): AppLogRecord {
  return { id, timestamp: "2026-07-20T12:00:00.000Z", level: "info", scope: "test.project-log", message };
}

class MemoryProjectFiles {
  private readonly values = new Map<string, Uint8Array>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  async ensureDirectory(): Promise<boolean> { return false; }
  async exists(path: string): Promise<boolean> { return this.values.has(path); }
  async list(path: string): Promise<ProjectFileEntry[]> {
    return [...this.values.entries()]
      .filter(([entryPath]) => entryPath.startsWith(`${path}/`))
      .map(([entryPath, data]) => ({ path: entryPath, kind: "file" as const, size: data.byteLength }));
  }
  async readText(path: string): Promise<{ content: string; fingerprint: string }> {
    const value = this.values.get(path);
    if (!value) throw new Error("not found");
    return { content: this.decoder.decode(value), fingerprint: String(value.byteLength) };
  }
  async writeText(path: string, content: string, _options?: { expectedFingerprint?: string; source?: ProjectFileChange["source"] }): Promise<string> {
    const value = this.encoder.encode(content);
    this.values.set(path, value);
    return String(value.byteLength);
  }
  async delete(path: string): Promise<void> { this.values.delete(path); }
  seed(path: string, content: string): void { this.values.set(path, this.encoder.encode(content)); }
  has(path: string): boolean { return this.values.has(path); }
  text(path: string): string { const value = this.values.get(path); if (!value) throw new Error(`missing ${path}`); return this.decoder.decode(value); }
  entries(): string[] { return [...this.values.keys()]; }
}
