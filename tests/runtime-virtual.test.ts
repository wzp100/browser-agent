import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "fflate";
import { MemoryVirtualFileSystem, VirtualShell, VirtualPackageManager, VirtualModuleBundler, VirtualRuntimeProvider, displayVirtualPath, resolveVirtualPath, textBytes, bytesText, lexShell, parseShell, runQuickJsScript, extractNpmTarball } from "../packages/runtime-virtual/src/index";

test("虚拟路径只允许访问 /workspace 且拒绝越过项目根", () => {
  assert.equal(resolveVirtualPath("src/index.ts", "/app"), "/app/src/index.ts");
  assert.equal(resolveVirtualPath("/workspace/src/../package.json"), "/package.json");
  assert.equal(displayVirtualPath("/src"), "/workspace/src");
  assert.throws(() => resolveVirtualPath("../../secret", "/src"), /不能越过/);
  assert.throws(() => resolveVirtualPath("/etc/passwd"), /只能访问 \/workspace/);
});

test("内存虚拟文件系统支持目录、二进制追加、重命名和递归删除", async () => {
  const fs = new MemoryVirtualFileSystem();
  await fs.mkdir("/src/lib", { recursive: true });
  await fs.writeFile("/src/lib/a.txt", textBytes("A"));
  await fs.writeFile("/src/lib/a.txt", textBytes("B"), { append: true });
  assert.equal(bytesText(await fs.readFile("/src/lib/a.txt")), "AB");
  assert.deepEqual((await fs.list("/src/lib")).map((entry) => [entry.name, entry.kind, entry.size]), [["a.txt", "file", 2]]);

  await fs.rename("/src", "/app");
  assert.equal(bytesText(await fs.readFile("/app/lib/a.txt")), "AB");
  assert.equal(await fs.exists("/src"), false);
  await assert.rejects(() => fs.remove("/app"), /ENOTEMPTY/);
  await fs.remove("/app", { recursive: true });
  assert.equal(await fs.exists("/app"), false);
});

test("Shell lexer 保留引号语义、变量、管道与重定向", () => {
  const tokens = lexShell(`FOO=world echo 'hello $FOO' "$FOO" | grep world 2>&1 >> out.txt`);
  assert.deepEqual(tokens.filter((token) => token.kind === "operator").map((token) => token.value), ["|", "2>&1", ">>"]);
  const words = tokens.filter((token) => token.kind === "word").map((token) => token.word);
  assert.equal(words[2]?.parts[0]?.value, "hello $FOO");
  assert.equal(words[2]?.parts[0]?.quoted, true);
  assert.equal(words[3]?.parts[0]?.kind, "variable");
});

test("Shell parser 构建条件链、管道和重定向 AST", () => {
  const program = parseShell("cat input.txt | grep ok > result.txt && echo done || echo failed; pwd");
  assert.equal(program.chains.length, 2);
  assert.deepEqual(program.chains[0]?.operators, ["&&", "||"]);
  assert.equal(program.chains[0]?.pipelines[0]?.commands.length, 2);
  assert.equal(program.chains[0]?.pipelines[0]?.commands[1]?.redirects[0]?.operator, ">");
  assert.throws(() => parseShell("echo 'missing"), /单引号没有闭合/);
  assert.throws(() => parseShell("echo ok |"), /缺少命令/);
});

test("VirtualShell 执行变量、条件链、管道和重定向", async () => {
  const fs = new MemoryVirtualFileSystem();
  const shell = new VirtualShell(fs);
  const result = await shell.execute("export NAME=world; echo hello $NAME | grep world > result.txt && cat result.txt || echo failed");
  assert.equal(result.exitCode, 0);
  assert.equal(bytesText(result.stdout), "hello world\n");
  assert.equal(bytesText(await fs.readFile("/result.txt")), "hello world\n");
  assert.equal(bytesText(result.stderr), "");
});

test("VirtualShell 文件命令、glob、条件退出码与路径状态", async () => {
  const fs = new MemoryVirtualFileSystem();
  const shell = new VirtualShell(fs);
  const result = await shell.execute("mkdir -p src/lib; printf 'b\\na\\na\\n' > src/lib/items.txt; sort < src/lib/items.txt | uniq -c; cd src; pwd; cp -r lib copy; ls */items.txt; false || echo recovered");
  assert.equal(result.exitCode, 0);
  assert.match(bytesText(result.stdout), /2 a/);
  assert.match(bytesText(result.stdout), /\/workspace\/src/);
  assert.equal((bytesText(result.stdout).match(/items\.txt/g) ?? []).length, 2);
  assert.match(bytesText(result.stdout), /recovered/);
  assert.equal(bytesText(await fs.readFile("/src/copy/items.txt")), "b\na\na\n");
});

test("VirtualShell 阻止未知命令和越界路径", async () => {
  const shell = new VirtualShell(new MemoryVirtualFileSystem());
  assert.deepEqual(await shell.execute("unknown-tool"), { exitCode: 127, stdout: new Uint8Array(), stderr: textBytes("unknown-tool: command not found\n") });
  const escaped = await shell.execute("cat /etc/passwd");
  assert.equal(escaped.exitCode, 1);
  assert.match(bytesText(escaped.stderr), /只能访问 \/workspace/);
});

test("QuickJS 隔离执行 console、process 参数和退出码", async () => {
  const result = await runQuickJsScript({
    source: `console.log("hello", { ok: true }); console.error(process.argv[2], process.env.MODE); process.exitCode = 7;`,
    args: ["world"],
    env: { MODE: "test" }
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, `hello {"ok":true}\n`);
  assert.equal(result.stderr, "world test\n");
  assert.equal(result.errorCode, undefined);
});

test("QuickJS 中断无限循环并返回明确超时码", async () => {
  const result = await runQuickJsScript({ source: "while (true) {}", timeoutMs: 25 });
  assert.equal(result.exitCode, 124);
  assert.equal(result.errorCode, "TIMEOUT");
  assert.match(result.stderr, /执行超时/);
});

test("npm 安装器解析依赖、校验完整性并写入持久化包仓库", async () => {
  const fs = new MemoryVirtualFileSystem();
  await fs.writeFile("/package.json", textBytes('{"name":"demo-project"}\n'));
  const archives = {
    demo: createNpmArchive("demo", "1.1.0", { "index.js": "module.exports = require('dep') + 1;" }),
    dep: createNpmArchive("dep", "1.0.0", { "index.js": "module.exports = 41;" })
  };
  const integrities = {
    demo: await sha512Integrity(archives.demo),
    dep: await sha512Integrity(archives.dep)
  };
  const metadata = {
    demo: registryMetadata("demo", "1.1.0", integrities.demo, { dep: "^1.0.0" }),
    dep: registryMetadata("dep", "1.0.0", integrities.dep)
  };
  const fetcher = async (url: string): Promise<Response> => {
    if (url.endsWith("/demo")) return Response.json(metadata.demo);
    if (url.endsWith("/dep")) return Response.json(metadata.dep);
    if (url.endsWith("/demo.tgz")) return new Response(Uint8Array.from(archives.demo).buffer);
    if (url.endsWith("/dep.tgz")) return new Response(Uint8Array.from(archives.dep).buffer);
    return new Response("not found", { status: 404 });
  };
  const manager = new VirtualPackageManager(fs, "https://registry.test", fetcher);
  const result = await manager.install(["demo@^1.0.0"]);
  assert.deepEqual(result.lock.roots, { demo: "demo@1.1.0" });
  assert.equal(result.lock.packages["demo@1.1.0"]?.dependencies.dep, "dep@1.0.0");
  assert.equal(bytesText(await fs.readFile("/.browser-agent/packages/store/demo/1.1.0/index.js")), "module.exports = require('dep') + 1;");
  assert.equal(JSON.parse(bytesText(await fs.readFile("/package.json"))).dependencies.demo, "^1.1.0");
  await fs.writeFile("/index.js", textBytes("const answer = require('demo'); console.log(answer);"));
  const bundler = new VirtualModuleBundler(fs, () => manager.readLock());
  const bundled = await bundler.bundleEntry("/index.js");
  const executed = await runQuickJsScript({ source: bundled.code });
  assert.equal(executed.exitCode, 0);
  assert.equal(executed.stdout, "42\n");
});

test("npm tarball 拦截路径穿越", () => {
  const archive = createTarArchive([{ path: "package/../outside.txt", content: "bad" }]);
  assert.throws(() => extractNpmTarball(archive), /不安全路径/);
});

test("VirtualRuntimeProvider 统一执行 Shell、JavaScript 和交互终端", async () => {
  const fs = new MemoryVirtualFileSystem();
  const provider = new VirtualRuntimeProvider(fs, { executor: { execute: (options) => runQuickJsScript(options) } });
  const session = await provider.start();
  const shell = await provider.execute(session, { source: "echo runtime | grep run", workingDirectory: ".", kind: "shell" });
  assert.deepEqual(shell, { exitCode: 0, stdout: "runtime\n", stderr: "" });
  const javascript = await provider.execute(session, { source: "console.log(6 * 7)", workingDirectory: ".", kind: "javascript" });
  assert.equal(javascript.stdout, "42\n");
  const output: string[] = [];
  const terminal = await provider.startInteractive((data) => output.push(data), { cols: 80, rows: 24 });
  await terminal.write("pwd\r");
  assert.match(output.join(""), /Browser Agent Virtual Runtime/);
  assert.match(output.join(""), /\/workspace/);
  terminal.kill();
  await provider.terminate(session);
});

function registryMetadata(name: string, version: string, integrity: string, dependencies: Record<string, string> = {}): object {
  return {
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name, version, dependencies,
        scripts: { install: "malicious-command" },
        dist: { tarball: `https://registry.test/${name}.tgz`, integrity }
      }
    }
  };
}

function createNpmArchive(name: string, version: string, files: Record<string, string>): Uint8Array {
  return createTarArchive([
    { path: "package/package.json", content: JSON.stringify({ name, version }) },
    ...Object.entries(files).map(([path, content]) => ({ path: `package/${path}`, content }))
  ]);
}

function createTarArchive(files: Array<{ path: string; content: string }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    const data = textBytes(file.content);
    const header = new Uint8Array(512);
    writeAscii(header, 0, 100, file.path);
    writeAscii(header, 100, 8, "0000644\0");
    writeAscii(header, 124, 12, `${data.byteLength.toString(8).padStart(11, "0")}\0`);
    header[156] = "0".charCodeAt(0);
    writeAscii(header, 257, 6, "ustar\0");
    chunks.push(header, data, new Uint8Array((512 - data.byteLength % 512) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const tar = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { tar.set(chunk, offset); offset += chunk.byteLength; }
  return gzipSync(tar);
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(textBytes(value).subarray(0, length), offset);
}

async function sha512Integrity(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", Uint8Array.from(bytes).buffer));
  return `sha512-${Buffer.from(digest).toString("base64")}`;
}
