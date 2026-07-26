import assert from "node:assert/strict";
import test from "node:test";
import { appendWorkspaceFileLinks, workspaceFileHref, workspacePathFromHref } from "../packages/workspace-contracts/src/index";

test("项目文件链接对中文、空格和 Markdown 特殊字符安全编码", () => {
  assert.equal(
    workspaceFileHref("/输出 报告/结果[最终].md"),
    "/__workspace_file__/%E8%BE%93%E5%87%BA%20%E6%8A%A5%E5%91%8A/%E7%BB%93%E6%9E%9C%5B%E6%9C%80%E7%BB%88%5D.md"
  );
});

test("项目文件链接只解析当前页面同源且位于保留路由下的路径", () => {
  const base = "http://127.0.0.1:5173/chat";
  assert.equal(workspacePathFromHref("/__workspace_file__/%E8%BE%93%E5%87%BA/%E6%8A%A5%E5%91%8A.md", base), "/输出/报告.md");
  assert.equal(workspacePathFromHref("https://example.com/__workspace_file__/secret.txt", base), undefined);
  assert.equal(workspacePathFromHref("/__workspace_file__/../secret.txt", base), undefined);
  assert.equal(workspacePathFromHref("/__workspace_file__/%E0%A4%A", base), undefined);
});

test("最终答复自动追加实际输出文件并避免重复链接", () => {
  const existing = workspaceFileHref("/报告.md");
  const content = `已完成：[报告](${existing})`;
  const result = appendWorkspaceFileLinks(content, ["/报告.md", "/数据 表.csv", "/数据 表.csv", "C:/越界.txt"]);
  assert.equal(result.split(existing).length - 1, 1);
  assert.match(result, /本次输出文件：/);
  assert.match(result, /\[数据 表\.csv\]\(\/__workspace_file__\/%E6%95%B0%E6%8D%AE%20%E8%A1%A8\.csv\)/);
  assert.doesNotMatch(result, /越界/);
});

test("失败答复将产物明确标记为可能不完整", () => {
  const result = appendWorkspaceFileLinks("任务未完成", ["/analyze_sales.js"], "失败前产生的文件（可能不完整）：");
  assert.match(result, /失败前产生的文件（可能不完整）：/);
  assert.doesNotMatch(result, /本次输出文件：/);
});
