import assert from "node:assert/strict";
import test from "node:test";
import { selectSupportedImages, toolRunShouldBeOpen, visibleFileTreeItems } from "../apps/web/src/ui";

function image(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

test("图片选择仅接受受支持格式并执行单图与消息总量限制", () => {
  const result = selectSupportedImages([
    image("first.png", "image/png", 8 * 1024 * 1024),
    image("large.webp", "image/webp", 8 * 1024 * 1024 + 1),
    image("document.pdf", "application/pdf", 20),
    image("second.jpg", "image/jpeg", 8 * 1024 * 1024),
    image("overflow.jpg", "image/jpeg", 1)
  ]);

  assert.deepEqual(result.accepted.map((file) => file.name), ["first.png", "second.jpg"]);
  assert.deepEqual(result.rejected.map(({ file, reason }) => [file.name, reason]), [
    ["large.webp", "单张图片不能超过 8 MiB"],
    ["document.pdf", "仅支持 JPEG、PNG 和 WebP"],
    ["overflow.jpg", "单条消息的图片合计不能超过 16 MiB"]
  ]);
});

test("工具运行折叠策略区分运行、失败、历史成功和用户展开", () => {
  assert.equal(toolRunShouldBeOpen("running"), true);
  assert.equal(toolRunShouldBeOpen("failed"), true);
  assert.equal(toolRunShouldBeOpen("completed"), false);
  assert.equal(toolRunShouldBeOpen("completed", true), true);
  assert.equal(toolRunShouldBeOpen("completed", false), false);
});

test("文件树默认隐藏 Browser Agent 内部目录并支持路径搜索", () => {
  const entries = [
    { path: "/src", kind: "directory" as const },
    { path: "/src/App.ts", kind: "file" as const },
    { path: "/README.md", kind: "file" as const },
    { path: "/.browser-agent/logs/today.jsonl", kind: "file" as const }
  ];

  assert.deepEqual(visibleFileTreeItems(entries).map((entry) => entry.path), ["/src", "/README.md", "/src/App.ts"]);
  assert.deepEqual(visibleFileTreeItems(entries, "app").map((entry) => entry.path), ["/src/App.ts"]);
});
