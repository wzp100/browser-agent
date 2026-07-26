import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_BACKUP_SCHEMA,
  importProjectBackup,
  parseProjectBackup,
  serializeProjectBackup,
  validateProjectBackup,
  type ProjectBackupImportBundle,
  type ProjectBackupSource
} from "../packages/project-backup/src/index";

test("项目备份以版本化 UTF-8 JSON 往返并将附件 Blob 转为 base64", async () => {
  const source = backupSource();
  const bytes = await serializeProjectBackup(source);
  const json = new TextDecoder().decode(bytes);
  assert.match(json, new RegExp(PROJECT_BACKUP_SCHEMA));
  assert.doesNotMatch(json, /directoryHandle|apiKey|sk-secret/);
  assert.equal(parseProjectBackup(bytes).attachments[0]?.dataBase64, "5Zu+54mH");

  let imported: ProjectBackupImportBundle | undefined;
  const result = await importProjectBackup(bytes, { commit: async (bundle) => { imported = bundle; } });
  assert.equal(result.projectId, "project-1");
  assert.equal(result.attachments, 1);
  assert.equal(result.recoveryBackups, 1);
  assert.equal(await imported?.attachments[0]?.blob.text(), "图片");
  assert.equal(new TextDecoder().decode(imported?.recoveryBackups[0]?.data), "旧内容");
  assert.equal(imported?.changeSets[0]?.runId, "run-1");
});

test("项目备份在 commit 前拒绝未知版本、超限、敏感字段和悬空关系", async () => {
  const valid = parseProjectBackup(await serializeProjectBackup(backupSource()));
  assert.throws(() => parseProjectBackup(JSON.stringify({ ...valid, version: 99 })), /版本不受支持/);
  assert.throws(() => parseProjectBackup(JSON.stringify(valid), { maxBytes: 10 }), /字节限制/);

  const secret = structuredClone(valid) as unknown as Record<string, unknown>;
  (secret.providerProfiles as Array<Record<string, unknown>>)[0]!.apiKey = "sk-secret";
  assert.throws(() => validateProjectBackup(secret), /敏感字段/);

  const orphan = structuredClone(valid) as unknown as Record<string, unknown>;
  (orphan.messages as Array<Record<string, unknown>>)[0]!.threadId = "missing";
  assert.throws(() => validateProjectBackup(orphan), /不存在的对话/);

  let commits = 0;
  const invalidAttachment = structuredClone(valid) as unknown as Record<string, unknown>;
  (invalidAttachment.attachments as Array<Record<string, unknown>>)[0]!.size = 999;
  await assert.rejects(() => importProjectBackup(JSON.stringify(invalidAttachment), { commit: async () => { commits += 1; } }), /声明大小/);
  assert.equal(commits, 0);
});

function backupSource(): ProjectBackupSource {
  return {
    project: {
      id: "project-1",
      name: "测试项目",
      directoryHandle: { kind: "directory", name: "local" },
      permissionHint: "granted",
      legacyRelinkRequired: false,
      permissionMode: "confirmWrites",
      createdAt: "2026-07-20T00:00:00.000Z",
      lastOpenedAt: "2026-07-20T01:00:00.000Z"
    },
    threads: [{ id: "thread-1", projectId: "project-1", title: "测试", createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" }],
    messages: [{ id: "message-1", threadId: "thread-1", sequence: 1, role: "user", kind: "user", content: "分析图片", createdAt: "2026-07-20T00:00:00.000Z" }],
    runs: [{ id: "run-1", threadId: "thread-1", status: "completed", intent: "分析", events: [], createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" }],
    providerProfiles: [{ id: "provider-1", name: "OpenAI", kind: "openai", endpoint: "https://api.openai.com/v1", defaultModelId: "model-1", builtIn: true, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" }],
    models: [{ id: "model-1", name: "Model", providerProfileId: "provider-1", capabilities: { toolCalling: "supported", imageInput: "supported", pdfInput: "unknown" }, source: "provider" }],
    skills: [{ id: "test-skill", name: "test-skill", description: "测试", source: "user", instructions: "# Test", files: [], enabled: true, permissions: [], updatedAt: "2026-07-20T00:00:00.000Z" }],
    changeSets: [{ id: "changes-1", projectId: "project-1", runId: "run-1", status: "completed", changes: [{ id: "change-1", runId: "run-1", type: "modify", path: "/report.txt", kind: "file", backupRef: "backup-1", createdAt: "2026-07-20T00:00:00.000Z" }], createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" }],
    recoveryBackups: [{ record: { id: "backup-1", projectId: "project-1", path: "/report.txt", operation: "modify", createdAt: "2026-07-20T00:00:00.000Z", bytes: 9 }, data: new TextEncoder().encode("旧内容") }],
    attachments: [{ id: "attachment-1", threadId: "thread-1", messageId: "message-1", name: "image.png", mimeType: "image/png", size: 6, blob: new Blob(["图片"], { type: "image/png" }), createdAt: "2026-07-20T00:00:00.000Z" }],
    exportedAt: "2026-07-20T02:00:00.000Z"
  };
}
