import assert from "node:assert/strict";
import test from "node:test";
import { resolveDirectoryPermission, type BrowserDirectoryHandle } from "../packages/workspace-contracts/src/index";

const requiredHandle = {
  kind: "directory",
  name: "test",
  async *values() {},
  getFileHandle: async () => { throw new Error("not used"); },
  getDirectoryHandle: async () => { throw new Error("not used"); },
  removeEntry: async () => undefined
} satisfies BrowserDirectoryHandle;

test("OPFS 风格目录句柄缺少权限 API 时按已授权处理", async () => {
  assert.equal(await resolveDirectoryPermission(requiredHandle, "query"), "granted");
  assert.equal(await resolveDirectoryPermission(requiredHandle, "request"), "granted");
});

test("原生目录句柄保留 query/request 的 prompt、denied 与 granted 结果", async () => {
  const calls: string[] = [];
  const handle: BrowserDirectoryHandle = {
    ...requiredHandle,
    queryPermission: async ({ mode } = {}) => { calls.push(`query:${mode}`); return "prompt"; },
    requestPermission: async ({ mode } = {}) => { calls.push(`request:${mode}`); return "denied"; }
  };
  assert.equal(await resolveDirectoryPermission(handle, "query"), "prompt");
  assert.equal(await resolveDirectoryPermission(handle, "request", "read"), "denied");
  assert.deepEqual(calls, ["query:readwrite", "request:read"]);
});
