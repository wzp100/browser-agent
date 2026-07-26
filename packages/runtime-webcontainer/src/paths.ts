export function runtimeFsPath(path: string): string {
  const relative = path.replace(/^\/workspace\/?/, "").replace(/^\/+/, "");
  return relative ? `/${relative}` : "/";
}

export function runtimeCwd(path: string): string {
  const relative = path.replace(/^\/workspace\/?/, "").replace(/^\/+/, "");
  return relative || ".";
}
