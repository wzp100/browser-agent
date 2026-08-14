import assert from "node:assert/strict";
import test from "node:test";
import { runtimeCwd, runtimeFsPath, toContainerFsPath, toProcessRelativePath, toSpawnWorkingDirectory } from "../packages/runtime-webcontainer/src/paths";
import { isDependencyMutationCommand, isRuntimeNodeModulesPath, runtimePackageEnvironment } from "../packages/runtime-webcontainer/src/package-cache";
import { inspectWebContainerSupport } from "../packages/runtime-webcontainer/src/support";
import { resolveWebContainerApiKey, WEBCONTAINER_API_KEY_ENV_NAME } from "../packages/runtime-webcontainer/src/webcontainer-config";
import { decodeDependencySnapshot, encodeDependencySnapshot, type DependencySnapshotLimits } from "../packages/runtime-webcontainer/src/dependency-snapshot";
import { DependencySnapshotCoordinator, dependencySnapshotRetryDelay, type DependencySnapshotTimers } from "../packages/runtime-webcontainer/src/dependency-snapshot-state";
import { coalesceRuntimeSyncPaths, isDirectorySignal, isRuntimeTemporaryPath, runtimeScriptPaths, shouldMirrorPath } from "../packages/runtime-webcontainer/src/workspace-mirror";
import { serializeError } from "../packages/logging/src/index";
import type { FileSystemTree, WebContainer } from "@webcontainer/api";

test("逻辑 /workspace 路径映射到 WebContainer 文件系统根且不会重复 workdir", () => {
  assert.equal(runtimeFsPath("/workspace"), "/");
  assert.equal(runtimeFsPath("/workspace/src/index.ts"), "/src/index.ts");
  assert.equal(runtimeFsPath("/home/workspace"), "/home/workspace");
  assert.equal(runtimeCwd("/workspace"), ".");
  assert.equal(runtimeCwd("/workspace/src"), "src");
});

test("文件 API、进程参数和 spawn cwd 使用三个明确的路径转换", () => {
  assert.equal(toContainerFsPath("/src/中文 文件.ts"), "/src/中文 文件.ts");
  assert.equal(toProcessRelativePath("/.browser-agent/runtime-tmp/run/a.mjs"), ".browser-agent/runtime-tmp/run/a.mjs");
  assert.equal(toSpawnWorkingDirectory("/workspace/src"), "src");
  assert.equal(toSpawnWorkingDirectory("."), ".");
  assert.throws(() => toProcessRelativePath("../../outside.mjs"), /不能越过项目根目录/);
});

test("javascript 临时脚本只在 runtime-tmp 中并向 Node 暴露相对路径", () => {
  const paths = runtimeScriptPaths("run 中文/with spaces", "exec id");
  assert.equal(paths.fsDirectory, "/.browser-agent/runtime-tmp/run-with-spaces");
  assert.equal(paths.fsPath, "/.browser-agent/runtime-tmp/run-with-spaces/exec-id.mjs");
  assert.equal(paths.processPath, ".browser-agent/runtime-tmp/run-with-spaces/exec-id.mjs");
  assert.equal(isRuntimeTemporaryPath(paths.fsPath), true);
  assert.equal(shouldMirrorPath(paths.fsPath), false);
});

test("javascript 执行向 Node 传相对路径并在 finally 清理内部脚本", async () => {
  const writes: string[] = [];
  const removals: string[] = [];
  const spawns: Array<{ command: string; args: string[]; cwd: string | undefined }> = [];
  const container = {
    workdir: "/home/project",
    fs: {
      mkdir: async () => {},
      writeFile: async (path: string) => { writes.push(path); },
      rm: async (path: string) => { removals.push(path); }
    },
    spawn: async (command: string, args: string[], options?: { cwd?: string }) => {
      spawns.push({ command, args, cwd: options?.cwd });
      return {
        exit: Promise.resolve(0),
        output: new ReadableStream<string>({ start(controller) { controller.enqueue("ok\n"); controller.close(); } }),
        kill() {}
      };
    }
  } as unknown as WebContainer;
  const mirror = new (await import("../packages/runtime-webcontainer/src/workspace-mirror")).WorkspaceMirror();
  Object.assign(mirror as unknown as Record<string, unknown>, { container, fileService: {} });

  const result = await mirror.execute({ source: 'console.log("ok")', workingDirectory: ".", kind: "javascript" }, "run-1");

  assert.deepEqual(result, { exitCode: 0, stdout: "ok\n", stderr: "" });
  assert.equal(writes.length, 1);
  assert.match(writes[0] ?? "", /^\/\.browser-agent\/runtime-tmp\/run-1\/.*\.mjs$/);
  assert.equal(spawns[0]?.command, "node");
  assert.match(spawns[0]?.args[0] ?? "", /^\.browser-agent\/runtime-tmp\/run-1\/.*\.mjs$/);
  assert.equal(spawns[0]?.cwd, ".");
  assert.deepEqual(removals, writes);
});

test("watcher 将 TypeMismatchError 和 EISDIR 识别为目录信号", () => {
  assert.equal(isDirectorySignal({ name: "TypeMismatchError", message: "not a file" }), true);
  assert.equal(isDirectorySignal({ code: "EISDIR" }), true);
  assert.equal(isDirectorySignal(new Error("EISDIR: illegal operation on a directory")), true);
  assert.equal(isDirectorySignal({ code: "EACCES", message: "denied" }), false);
});

test("watcher 父路径事件吸收子路径并忽略内部临时目录", () => {
  assert.deepEqual(coalesceRuntimeSyncPaths([
    "/src/view/button.ts",
    "/src",
    "/src/view",
    "/public/logo.svg",
    "/.browser-agent/runtime-tmp/run/a.mjs"
  ]), ["/src", "/public/logo.svg"]);
});

test("未知对象异常可结构化显示、脱敏并保留有限 cause", () => {
  const error = serializeError({
    name: "SnapshotFailure",
    code: "EWRITE",
    message: "token=super-secret-value",
    cause: { message: "磁盘写入失败", code: 507 }
  });
  assert.equal(error.name, "SnapshotFailure");
  assert.equal(error.code, "EWRITE");
  assert.match(error.message, /已隐藏/);
  assert.notEqual(error.message, "[object Object]");
  assert.deepEqual(error.cause, { message: "磁盘写入失败", code: "507" });
  assert.notEqual(serializeError({ unexpected: true }).message, "[object Object]");
});

test("依赖快照等待 800ms quiet window，失败后按退避重试且事件不会绕过 timer", async () => {
  const timers = new ManualSnapshotTimers();
  let attempts = 0;
  const failures: number[] = [];
  const coordinator = new DependencySnapshotCoordinator(
    async () => { attempts += 1; if (attempts === 1) throw { message: "snapshot failed", code: "EWRITE" }; },
    ({ retryDelayMs }) => failures.push(retryDelayMs),
    timers
  );

  coordinator.markDirty();
  assert.equal(coordinator.state, "waiting_for_quiet");
  assert.equal(timers.nextDelay(), 800);
  timers.runNext();
  await coordinator.waitForSaving();
  assert.equal(attempts, 1);
  assert.equal(coordinator.state, "failed_retryable");
  assert.deepEqual(failures, [1_000]);
  assert.equal(timers.nextDelay(), 1_000);

  coordinator.markDirty();
  assert.equal(timers.nextDelay(), 1_000);
  timers.runNext();
  await coordinator.waitForSaving();
  assert.equal(attempts, 2);
  assert.equal(coordinator.state, "clean");
  assert.equal(coordinator.isDirty, false);
});

test("依赖快照保存期间的新变化重新等待 quiet window，取消会阻止未开始任务", async () => {
  const timers = new ManualSnapshotTimers();
  let finishSave: (() => void) | undefined;
  let attempts = 0;
  const coordinator = new DependencySnapshotCoordinator(
    () => new Promise<void>((resolve) => { attempts += 1; finishSave = resolve; }),
    () => {},
    timers
  );
  coordinator.markDirty();
  timers.runNext();
  coordinator.markDirty();
  finishSave?.();
  await coordinator.waitForSaving();
  assert.equal(attempts, 1);
  assert.equal(coordinator.state, "waiting_for_quiet");
  assert.equal(timers.nextDelay(), 800);
  coordinator.cancelPending();
  assert.equal(timers.count(), 0);
  assert.equal(coordinator.state, "dirty");
  assert.equal(coordinator.isDirty, true);
});

test("依赖快照退避上限为 30 秒", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 10].map(dependencySnapshotRetryDelay), [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});

test("包管理器统一使用项目级 .browser-agent 安装包缓存", () => {
  const environment = runtimePackageEnvironment("/home/project");
  assert.equal(environment.npm_config_cache, "/home/project/.browser-agent/packages/npm-cache");
  assert.equal(environment.npm_config_store_dir, "/home/project/.browser-agent/packages/pnpm-store");
  assert.equal(environment.YARN_CACHE_FOLDER, "/home/project/.browser-agent/packages/yarn-cache");
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

test("WebContainer client key 必须显式配置且会清理首尾空白", () => {
  assert.equal(resolveWebContainerApiKey({ [WEBCONTAINER_API_KEY_ENV_NAME]: "  wc-test-key  " }), "wc-test-key");
  assert.throws(() => resolveWebContainerApiKey(undefined), new RegExp(WEBCONTAINER_API_KEY_ENV_NAME));
  assert.throws(() => resolveWebContainerApiKey({ [WEBCONTAINER_API_KEY_ENV_NAME]: "   " }), /StackBlitz WebContainer API/);
});

class ManualSnapshotTimers implements DependencySnapshotTimers {
  private nextId = 0;
  private readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  set(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.pending.set(id, { callback, delayMs });
    return id;
  }

  clear(handle: unknown): void { this.pending.delete(handle as number); }
  count(): number { return this.pending.size; }
  nextDelay(): number | undefined { return this.pending.values().next().value?.delayMs; }
  runNext(): void {
    const next = this.pending.entries().next().value as [number, { callback: () => void; delayMs: number }] | undefined;
    if (!next) throw new Error("没有待执行的 timer");
    this.pending.delete(next[0]);
    next[1].callback();
  }
}
