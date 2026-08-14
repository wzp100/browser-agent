export async function verifyPackageIntegrity(bytes: Uint8Array, integrity: string | undefined, shasum: string | undefined): Promise<void> {
  if (integrity) {
    const candidates = integrity.split(/\s+/).map(parseIntegrity).filter((value): value is IntegrityValue => value !== undefined);
    const preferred = candidates.find((candidate) => candidate.algorithm === "SHA-512")
      ?? candidates.find((candidate) => candidate.algorithm === "SHA-384")
      ?? candidates.find((candidate) => candidate.algorithm === "SHA-256");
    if (!preferred) throw new Error("包完整性算法不受支持");
    const digest = new Uint8Array(await crypto.subtle.digest(preferred.algorithm, ownedBuffer(bytes)));
    if (!constantTimeEqual(digest, decodeBase64(preferred.digest))) throw new Error("npm tarball 完整性校验失败");
    return;
  }
  if (!shasum) throw new Error("npm 包缺少完整性摘要");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", ownedBuffer(bytes)));
  if (toHex(digest) !== shasum.toLowerCase()) throw new Error("npm tarball SHA-1 校验失败");
}

interface IntegrityValue { algorithm: "SHA-256" | "SHA-384" | "SHA-512"; digest: string; }

function parseIntegrity(value: string): IntegrityValue | undefined {
  const separator = value.indexOf("-");
  if (separator < 1) return undefined;
  const algorithm = value.slice(0, separator).toLowerCase();
  const mapped = algorithm === "sha512" ? "SHA-512" : algorithm === "sha384" ? "SHA-384" : algorithm === "sha256" ? "SHA-256" : undefined;
  return mapped ? { algorithm: mapped, digest: value.slice(separator + 1).split("?")[0]! } : undefined;
}

function decodeBase64(value: string): Uint8Array {
  if (typeof atob === "function") return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}
