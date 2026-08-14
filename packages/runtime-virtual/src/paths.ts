export const VIRTUAL_WORKSPACE_ROOT = "/workspace";

export class VirtualPathError extends Error {
  readonly code = "PATH_ESCAPE";
  constructor(message: string) { super(message); this.name = "VirtualPathError"; }
}

/** 将 Shell 路径解析为项目根内部路径；内部根始终为 `/`。 */
export function resolveVirtualPath(input: string, cwd = "/"): string {
  const normalizedInput = input.replace(/\\/g, "/");
  let source: string;
  if (normalizedInput === VIRTUAL_WORKSPACE_ROOT) source = "/";
  else if (normalizedInput.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) source = normalizedInput.slice(VIRTUAL_WORKSPACE_ROOT.length);
  else if (normalizedInput.startsWith("/")) throw new VirtualPathError(`虚拟环境只能访问 ${VIRTUAL_WORKSPACE_ROOT}：${input}`);
  else source = `${normalizeInternalPath(cwd)}/${normalizedInput}`;

  const parts: string[] = [];
  for (const part of source.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new VirtualPathError(`路径不能越过 ${VIRTUAL_WORKSPACE_ROOT}：${input}`);
      parts.pop();
      continue;
    }
    if (part.includes("\0")) throw new VirtualPathError("路径不能包含 NUL。 ");
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

export function normalizeInternalPath(path: string): string {
  if (!path.startsWith("/")) throw new VirtualPathError(`内部路径必须是绝对路径：${path}`);
  return resolveVirtualPath(path === "/" ? VIRTUAL_WORKSPACE_ROOT : `${VIRTUAL_WORKSPACE_ROOT}${path}`, "/");
}

export function displayVirtualPath(internalPath: string): string {
  const normalized = normalizeInternalPath(internalPath);
  return normalized === "/" ? VIRTUAL_WORKSPACE_ROOT : `${VIRTUAL_WORKSPACE_ROOT}${normalized}`;
}

export function virtualBasename(path: string): string {
  const normalized = normalizeInternalPath(path);
  return normalized === "/" ? "workspace" : normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function virtualDirname(path: string): string {
  const normalized = normalizeInternalPath(path);
  if (normalized === "/") return "/";
  return normalized.slice(0, normalized.lastIndexOf("/")) || "/";
}

export function joinVirtualPath(base: string, name: string): string {
  return resolveVirtualPath(name, normalizeInternalPath(base));
}
