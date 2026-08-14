export interface PackageRequest { name: string; range: string; }

export function parsePackageSpec(spec: string): PackageRequest {
  const value = spec.trim();
  if (!value || /^(?:https?:|git(?:\+|:)|file:|\.\.?[\\/])/.test(value)) {
    throw new Error(`不支持的包说明：${spec}`);
  }
  if (value.startsWith("@")) {
    const separator = value.indexOf("@", 1);
    const slash = value.indexOf("/");
    if (slash < 2) throw new Error(`无效的 scoped 包名：${spec}`);
    if (separator > slash) return { name: value.slice(0, separator), range: value.slice(separator + 1) || "latest" };
    return { name: value, range: "latest" };
  }
  const separator = value.lastIndexOf("@");
  return separator > 0
    ? { name: value.slice(0, separator), range: value.slice(separator + 1) || "latest" }
    : { name: value, range: "latest" };
}

export function validatePackageName(name: string): void {
  if (name.length > 214 || (!/^@[a-z0-9._~-]+\/[a-z0-9._~-]+$/i.test(name) && !/^[a-z0-9._~-]+$/i.test(name))) {
    throw new Error(`无效的 npm 包名：${name}`);
  }
}
