import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const limit = 250 * 1024;
const html = await readFile(new URL("../apps/web/dist/index.html", import.meta.url), "utf8");
const entry = html.match(/<script[^>]+type="module"[^>]+src="\/([^\"]+)"/)?.[1];
if (!entry) throw new Error("无法从生产 HTML 找到入口模块。 ");
const source = await readFile(new URL(`../apps/web/dist/${entry}`, import.meta.url));
const bytes = gzipSync(source).byteLength;
if (bytes >= limit) throw new Error(`入口模块 gzip 为 ${bytes} 字节，超过 ${limit} 字节限制。`);
console.log(`Initial entry gzip passed: ${bytes} bytes (< ${limit}).`);
