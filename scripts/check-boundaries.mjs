import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const kernelRoot = join(root, "packages", "agent-kernel", "src");
const heavyKernelDependencies = ["sheetjs", "exceljs", "duckdb", "pptxgenjs", "workspace-adapter-files"];
const deletedLegacyModules = ["agent-shell", "artifact-core", "workspace-projection", "workspace-safety-kernel"];

for (const file of await sourceFiles(kernelRoot)) {
  const source = (await readFile(file, "utf8")).toLowerCase();
  for (const dependency of heavyKernelDependencies) {
    if (source.includes(dependency)) throw new Error(`agent-kernel 不得依赖 ${dependency}：${relative(root, file)}`);
  }
}

for (const area of ["apps", "packages", "tests"]) {
  for (const file of await sourceFiles(join(root, area))) {
    const source = (await readFile(file, "utf8")).toLowerCase();
    for (const legacy of deletedLegacyModules) {
      if (source.includes(legacy)) throw new Error(`已删除的旧架构模块仍被引用：${legacy}（${relative(root, file)}）`);
    }
  }
}

console.log("Dependency boundary passed.");

async function sourceFiles(directory) {
  const files = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if ((await stat(path)).isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:ts|mjs)$/.test(name)) files.push(path);
  }
  return files;
}
