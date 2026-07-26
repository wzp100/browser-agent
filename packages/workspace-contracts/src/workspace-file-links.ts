import { normalizeFilePath } from "./project-file-service";

export const WORKSPACE_FILE_ROUTE = "/__workspace_file__/";

/** 创建可持久化到对话中的项目文件链接；它不依赖浏览器无法获知的宿主绝对路径。 */
export function workspaceFileHref(path: string): string {
  const normalized = normalizeFilePath(path);
  return `${WORKSPACE_FILE_ROUTE}${normalized.slice(1).split("/").map(encodeURIComponent).join("/")}`;
}

/** 仅接受当前页面同源的项目文件链接，并还原为 ProjectFileService 使用的路径。 */
export function workspacePathFromHref(href: string, baseUrl: string): string | undefined {
  try {
    const base = new URL(baseUrl);
    const url = new URL(href, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(WORKSPACE_FILE_ROUTE)) return undefined;
    const encodedPath = url.pathname.slice(WORKSPACE_FILE_ROUTE.length);
    if (!encodedPath) return undefined;
    return normalizeFilePath(encodedPath.split("/").map(decodeURIComponent).join("/"));
  } catch {
    return undefined;
  }
}

/** 在最终答复中为尚未链接的真实输出文件补充一个稳定的 Markdown 链接区。 */
export function appendWorkspaceFileLinks(content: string, paths: Iterable<string>, heading = "本次输出文件："): string {
  const uniquePaths: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    let normalized: string;
    try { normalized = normalizeFilePath(path); } catch { continue; }
    if (!seen.has(normalized)) { seen.add(normalized); uniquePaths.push(normalized); }
  }
  const missing = uniquePaths.filter((path) => !content.includes(workspaceFileHref(path)));
  if (!missing.length) return content;
  const links = missing.map((path) => `- [${escapeMarkdownLabel(path.slice(1))}](${workspaceFileHref(path)})`);
  return `${content.trimEnd()}\n\n${heading}\n\n${links.join("\n")}`;
}

function escapeMarkdownLabel(value: string): string { return value.replace(/([\\\[\]])/g, "\\$1"); }
