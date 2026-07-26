import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createDocument, inspectDocument, validateDocument } from "../packages/document-engine/src/index";
import { createPdf, inspectPdf, mergePdfs, validatePdf } from "../packages/pdf-engine/src/index";
import { createPresentation, inspectPresentation, validatePresentation } from "../packages/presentation-engine/src/index";

type ArtifactKind = "docx" | "pptx" | "pdf";

interface QaResult {
  artifact: ArtifactKind;
  bytes: number;
  inspect: string;
  rendered: boolean;
  renderer: string;
  images: number;
  reason?: string;
}

const strict = process.argv.includes("--strict");
const keep = process.argv.includes("--keep");
const workspace = mkdtempSync(join(tmpdir(), "browser-agent-office-qa-"));
const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zf9sAAAAASUVORK5CYII=";

main().catch((error: unknown) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  try {
    const results = await verifyArtifacts(workspace);
    if (strict) {
      for (const result of results) assert.equal(result.rendered, true, `${result.artifact} 未完成渲染：${result.reason ?? "无可用渲染器"}`);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, strict, workspace: keep ? workspace : undefined, results }, null, 2)}\n`);
  } finally {
    if (!keep) rmSync(workspace, { recursive: true, force: true });
  }
}

async function verifyArtifacts(root: string): Promise<QaResult[]> {
  const documentData = await createDocument({
    title: "Browser Agent Office QA",
    header: "Repeatable artifact verification",
    footer: "Generated locally",
    blocks: [
      { type: "heading", level: 1, text: "Validation summary" },
      { type: "paragraph", text: "This document is generated, validated, inspected again, and rendered when an Office renderer is available." },
      { type: "list", ordered: true, items: ["Generate", "Validate", "Inspect", "Render"] },
      { type: "table", headers: ["Check", "Expected"], rows: [["Package", "Valid"], ["Preview", "Non-empty"]] },
      { type: "image", image: { data: pixel, width: 96, height: 64, altText: "QA pixel" }, caption: "Embedded image check" }
    ]
  });
  const documentPath = join(root, "office-qa.docx");
  writeFileSync(documentPath, documentData);
  assert.equal(await validateDocument(readBytes(documentPath)), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const documentInspection = await inspectDocument(documentPath, readBytes(documentPath));
  assert.ok(documentInspection.paragraphCount > 0);
  assert.equal(documentInspection.tableCount, 1);
  assert.equal(documentInspection.summary.imageCount, 1);

  const presentationData = await createPresentation({
    title: "Browser Agent Office QA",
    slides: [
      { layout: "title", title: "Browser Agent Office QA", subtitle: "Generate, validate, inspect, render" },
      { layout: "bullets", title: "Acceptance checks", bullets: ["Valid OOXML package", "Expected slide count", "Non-empty rendered pages"] },
      { layout: "table", title: "Verification matrix", headers: ["Artifact", "Result"], rows: [["PPTX", "Valid"], ["Preview", "Non-empty"]] }
    ]
  });
  const presentationPath = join(root, "office-qa.pptx");
  writeFileSync(presentationPath, presentationData);
  assert.equal(await validatePresentation(readBytes(presentationPath)), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  const presentationInspection = await inspectPresentation(presentationPath, readBytes(presentationPath));
  assert.equal(presentationInspection.slideCount, 3);
  assert.equal(presentationInspection.summary.totalTables, 1);

  const firstPdf = await createPdf("Browser Agent PDF QA", ["The first page must remain readable after serialization."]);
  const secondPdf = await createPdf("Browser Agent PDF QA Appendix", ["The second page verifies multi-page rendering."]);
  const pdfData = await mergePdfs([firstPdf, secondPdf]);
  const pdfPath = join(root, "office-qa.pdf");
  writeFileSync(pdfPath, pdfData);
  assert.equal(await validatePdf(readBytes(pdfPath)), "application/pdf");
  const pdfInspection = await inspectPdf(pdfPath, readBytes(pdfPath));
  assert.equal(pdfInspection.pageCount, 2);

  const documentRender = renderOoxml(documentPath, "docx", root, documentInspection.paragraphCount > 0 ? 1 : 0);
  const presentationRender = renderOoxml(presentationPath, "pptx", root, presentationInspection.slideCount);
  const pdfRender = renderPdf(pdfPath, join(root, "pdf-preview"), pdfInspection.pageCount);

  return [
    {
      artifact: "docx",
      bytes: documentData.byteLength,
      inspect: `${documentInspection.paragraphCount} paragraphs, ${documentInspection.tableCount} table`,
      ...documentRender
    },
    {
      artifact: "pptx",
      bytes: presentationData.byteLength,
      inspect: `${presentationInspection.slideCount} slides, ${presentationInspection.summary.totalTables} table`,
      ...presentationRender
    },
    {
      artifact: "pdf",
      bytes: pdfData.byteLength,
      inspect: `${pdfInspection.pageCount} pages`,
      ...pdfRender
    }
  ];
}

function renderOoxml(inputPath: string, kind: "docx" | "pptx", root: string, expectedPages: number): Pick<QaResult, "rendered" | "renderer" | "images" | "reason"> {
  const pdfPath = join(root, `${kind}-preview.pdf`);
  const soffice = findCommand("soffice") ?? findCommand("libreoffice");
  let renderer = "";
  try {
    if (soffice) {
      const outputDirectory = join(root, `${kind}-convert`);
      const profile = join(root, `${kind}-libreoffice-profile`).replace(/\\/g, "/");
      mkdirSync(outputDirectory, { recursive: true });
      run(soffice, [`-env:UserInstallation=file:///${profile}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", outputDirectory, inputPath]);
      const converted = join(outputDirectory, `${basename(inputPath, extname(inputPath))}.pdf`);
      assert.ok(existsSync(converted), `LibreOffice 未生成 ${kind} PDF`);
      writeFileSync(pdfPath, readFileSync(converted));
      renderer = "LibreOffice + Poppler";
    } else if (process.platform === "win32") {
      convertWithMicrosoftOffice(inputPath, pdfPath, kind);
      renderer = `${kind === "docx" ? "Microsoft Word" : "Microsoft PowerPoint"} + Poppler`;
    } else {
      return { rendered: false, renderer: "none", images: 0, reason: "未找到 LibreOffice" };
    }
    assertNonEmpty(pdfPath, `${kind} 导出的 PDF`);
    const result = renderPdf(pdfPath, join(root, `${kind}-preview`), expectedPages);
    return { ...result, renderer };
  } catch (error) {
    return { rendered: false, renderer: renderer || (soffice ? "LibreOffice" : "Microsoft Office"), images: 0, reason: errorMessage(error) };
  }
}

function renderPdf(inputPath: string, outputDirectory: string, expectedPages: number): Pick<QaResult, "rendered" | "renderer" | "images" | "reason"> {
  const pdftoppm = findCommand("pdftoppm");
  if (!pdftoppm) return { rendered: false, renderer: "none", images: 0, reason: "未找到 Poppler pdftoppm" };
  mkdirSync(outputDirectory, { recursive: true });
  const prefix = join(outputDirectory, "page");
  try {
    run(pdftoppm, ["-png", "-r", "110", inputPath, prefix]);
    const images = readdirSync(outputDirectory)
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .map((name) => join(outputDirectory, name));
    assert.equal(images.length, expectedPages, `渲染页数不匹配：预期 ${expectedPages}，实际 ${images.length}`);
    for (const path of images) assertPng(path);
    return { rendered: true, renderer: "Poppler", images: images.length };
  } catch (error) {
    return { rendered: false, renderer: "Poppler", images: 0, reason: errorMessage(error) };
  }
}

function convertWithMicrosoftOffice(inputPath: string, outputPdf: string, kind: "docx" | "pptx"): void {
  const input = psLiteral(resolve(inputPath));
  const output = psLiteral(resolve(outputPdf));
  const script = kind === "docx"
    ? `$ErrorActionPreference='Stop'; $app=$null; $file=$null; try { $app=New-Object -ComObject Word.Application; $app.Visible=$false; $app.DisplayAlerts=0; $file=$app.Documents.Open('${input}', $false, $true); $file.ExportAsFixedFormat('${output}', 17) } finally { if ($null -ne $file) { $file.Close($false); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($file) }; if ($null -ne $app) { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } }`
    : `$ErrorActionPreference='Stop'; $app=$null; $file=$null; try { $app=New-Object -ComObject PowerPoint.Application; $file=$app.Presentations.Open('${input}', -1, 0, 0); $file.SaveAs('${output}', 32) } finally { if ($null -ne $file) { $file.Close(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($file) }; if ($null -ne $app) { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } }`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const powershell = findCommand("powershell") ?? findCommand("pwsh");
  if (!powershell) throw new Error("未找到 PowerShell，无法使用 Microsoft Office COM 渲染");
  run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], 60_000);
}

function findCommand(name: string): string | undefined {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(locator, [name], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return undefined;
  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform === "win32") candidates.sort((left, right) => Number(/\.(?:cmd|bat)$/i.test(left)) - Number(/\.(?:cmd|bat)$/i.test(right)));
  return candidates[0];
}

function run(command: string, args: string[], timeout = 30_000): void {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} 退出码 ${result.status}: ${(result.stderr || result.stdout).trim()}`);
}

function assertNonEmpty(path: string, label: string): void {
  assert.ok(existsSync(path), `${label} 不存在`);
  assert.ok(statSync(path).size > 100, `${label} 为空或异常短`);
}

function assertPng(path: string): void {
  assertNonEmpty(path, "渲染 PNG");
  const data = readFileSync(path);
  assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${path} 不是 PNG`);
  assert.ok(data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0, `${path} 的图片尺寸无效`);
}

function readBytes(path: string): Uint8Array { return new Uint8Array(readFileSync(path)); }
function psLiteral(value: string): string { return value.replace(/'/g, "''"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
