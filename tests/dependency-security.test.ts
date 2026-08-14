import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

test("PptxGenJS 浏览器包不安装或导入 Node image-size 解析器", () => {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(dirname(require.resolve("pptxgenjs")));
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    browser?: Record<string, boolean>;
    exports?: { import?: string };
  };

  assert.equal(manifest.browser?.["image-size"], false);
  assert.ok(manifest.exports?.import);
  const browserBundle = readFileSync(join(packageRoot, manifest.exports.import), "utf8");
  assert.doesNotMatch(browserBundle, /(?:from\s+|require\s*\()\s*["']image-size["']/);

  const packageRequire = createRequire(join(packageRoot, "package.json"));
  assert.throws(() => packageRequire.resolve("image-size"), /Cannot find module/);
});
