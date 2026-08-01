import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageFiles = ["package.json", "apps/web/package.json", "apps/gateway/package.json"];
const versionFile = "packages/version.ts";
const checkOnly = process.argv.includes("--check");
const requested = process.argv.find((value) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value));
const rootPackage = JSON.parse(await readFile(resolve(root, packageFiles[0]), "utf8"));
const version = requested ?? rootPackage.version;

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("用法：pnpm version:set <semver>，例如 pnpm version:set 0.2.0");
}

const mismatches = [];
for (const relativePath of packageFiles) {
  const path = resolve(root, relativePath);
  const packageJson = JSON.parse(await readFile(path, "utf8"));
  if (packageJson.version !== version) mismatches.push(`${relativePath}: ${packageJson.version}`);
  if (!checkOnly) {
    packageJson.version = version;
    await writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }
}

const versionPath = resolve(root, versionFile);
const versionSource = await readFile(versionPath, "utf8");
const runtimeVersion = versionSource.match(/APP_VERSION = "([^"]+)"/)?.[1];
if (runtimeVersion !== version) mismatches.push(`${versionFile}: ${runtimeVersion ?? "missing"}`);
if (!checkOnly) {
  await writeFile(versionPath, versionSource.replace(/APP_VERSION = "[^"]+"/, `APP_VERSION = "${version}"`), "utf8");
}

if (checkOnly && mismatches.length) throw new Error(`版本不一致：\n${mismatches.join("\n")}`);
console.log(checkOnly ? `版本一致：${version}` : `版本已更新为 ${version}`);
