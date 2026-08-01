/** WebContainer 文件 API 使用的项目根绝对路径。 */
export function toContainerFsPath(path: string): string {
  const relative = projectRelativePath(path);
  return relative === "." ? "/" : `/${relative}`;
}

/** 传给容器进程的项目根相对路径，避免把文件 API 命名空间误当作 OS 根。 */
export function toProcessRelativePath(path: string): string {
  return projectRelativePath(path);
}

/** WebContainer.spawn 的 cwd；进程始终从项目根或其相对子目录启动。 */
export function toSpawnWorkingDirectory(path: string): string {
  return projectRelativePath(path);
}

/** @deprecated 使用 toContainerFsPath。 */
export const runtimeFsPath = toContainerFsPath;
/** @deprecated 使用 toSpawnWorkingDirectory。 */
export const runtimeCwd = toSpawnWorkingDirectory;

function projectRelativePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const withoutLegacyWorkspace = normalized === "/workspace"
    ? ""
    : normalized.startsWith("/workspace/")
      ? normalized.slice("/workspace/".length)
      : normalized.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of withoutLegacyWorkspace.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error(`Runtime 路径不能越过项目根目录：${path}`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/") || ".";
}
