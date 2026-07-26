import assert from "node:assert/strict";
import test from "node:test";
import { runtimeCwd, runtimeFsPath } from "../packages/runtime-webcontainer/src/paths";
import { isDependencyMutationCommand, isRuntimeNodeModulesPath, runtimePackageEnvironment } from "../packages/runtime-webcontainer/src/package-cache";
import { inspectWebContainerSupport } from "../packages/runtime-webcontainer/src/support";
import { decodeDependencySnapshot, encodeDependencySnapshot, type DependencySnapshotLimits } from "../packages/runtime-webcontainer/src/dependency-snapshot";
import type { FileSystemTree } from "@webcontainer/api";

test("逻辑 /workspace 路径映射到 WebContainer 文件系统根且不会重复 workdir", () => {
  assert.equal(runtimeFsPath("/workspace"), "/");
  assert.equal(runtimeFsPath("/workspace/src/index.ts"), "/src/index.ts");
  assert.equal(runtimeFsPath("/home/workspace"), "/home/workspace");
  assert.equal(runtimeCwd("/workspace"), ".");
  assert.equal(runtimeCwd("/workspace/src"), "src");
});

test("包管理器统一使用项目级 .browser-agent 安装包缓存", () => {
  const environment = runtimePackageEnvironment("/workspace");
  assert.equal(environment.npm_config_cache, "/workspace/.browser-agent/packages/npm-cache");
  assert.equal(environment.npm_config_store_dir, "/workspace/.browser-agent/packages/pnpm-store");
  assert.equal(environment.YARN_CACHE_FOLDER, "/workspace/.browser-agent/packages/yarn-cache");
  assert.equal(environment.npm_config_prefer_offline, "true");
});

test("只把 Runtime 根 node_modules 识别为持久依赖变更", () => {
  assert.equal(isRuntimeNodeModulesPath("/node_modules/lodash/lodash.js"), true);
  assert.equal(isRuntimeNodeModulesPath("node_modules/@scope/pkg/index.js"), true);
  assert.equal(isRuntimeNodeModulesPath("/.browser-agent/packages/installed/node-modules.snapshot"), false);
  assert.equal(isRuntimeNodeModulesPath("/src/index.ts"), false);
});

test("识别常见包管理器依赖变更命令", () => {
  assert.equal(isDependencyMutationCommand("npm install lodash"), true);
  assert.equal(isDependencyMutationCommand("cd app && pnpm add zod"), true);
  assert.equal(isDependencyMutationCommand("yarn remove lodash"), true);
  assert.equal(isDependencyMutationCommand("node scripts/analyze.js"), false);
});

test("依赖快照往返保留文本、二进制和符号链接", async () => {
  const tree: FileSystemTree = {
    lodash: { directory: {
      "package.json": { file: { contents: "{\"name\":\"lodash\"}" } },
      "data.bin": { file: { contents: new Uint8Array([0, 1, 2, 255]) } }
    } },
    ".bin": { directory: { lodash: { file: { symlink: "../lodash/cli.js" } } } }
  };
  const snapshot = await encodeDependencySnapshot(tree);
  assert.ok(snapshot.byteLength > 5);
  assert.deepEqual(await decodeDependencySnapshot(snapshot), tree);
});

test("依赖快照拒绝危险节点名和超限内容", async () => {
  const limits: DependencySnapshotLimits = { maxCompressedBytes: 1024, maxDecompressedBytes: 4096, maxEntries: 2, maxDepth: 2 };
  const dangerousJson = new TextEncoder().encode('BAS1J{"__proto__":{"kind":"directory","entries":{}}}');
  await assert.rejects(() => decodeDependencySnapshot(dangerousJson, limits), /危险节点名/);

  const tooManyEntries: FileSystemTree = {
    a: { file: { contents: "a" } },
    b: { file: { contents: "b" } },
    c: { file: { contents: "c" } }
  };
  await assert.rejects(() => encodeDependencySnapshot(tooManyEntries, limits), /节点数量/);

  const oversized = new TextEncoder().encode(`BAS1J${"x".repeat(4097)}`);
  await assert.rejects(() => decodeDependencySnapshot(oversized, limits), /压缩数据|安全上限/);
});

test("WebContainer 仅在安全且跨源隔离并提供 SharedArrayBuffer 时可用", () => {
  const supported = inspectWebContainerSupport({
    isSecureContext: true,
    crossOriginIsolated: true,
    SharedArrayBuffer: class SharedArrayBuffer {}
  });

  assert.equal(supported.supported, true);
  assert.equal(supported.message, undefined);
});

test("内嵌 Chromium 缺少跨源隔离时在 boot 前被拒绝", () => {
  const unsupported = inspectWebContainerSupport({
    isSecureContext: true,
    crossOriginIsolated: false,
    SharedArrayBuffer: undefined
  });

  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.secureContext, true);
  assert.equal(unsupported.crossOriginIsolated, false);
  assert.equal(unsupported.sharedArrayBuffer, false);
  assert.match(unsupported.message ?? "", /独立 Chrome 或 Edge/);
});

test("非安全上下文给出 localhost 或 HTTPS 恢复提示", () => {
  const unsupported = inspectWebContainerSupport({
    isSecureContext: false,
    crossOriginIsolated: false,
    SharedArrayBuffer: undefined
  });

  assert.equal(unsupported.supported, false);
  assert.match(unsupported.message ?? "", /127\.0\.0\.1|HTTPS/);
});
