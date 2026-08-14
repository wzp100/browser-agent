import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { AgentToolRegistry } from "../packages/command-core/src/index";
import { createDocument, inspectDocument, validateDocument } from "../packages/document-engine/src/index";
import { OfficeCapabilityProvider, registerOfficeAgentTools } from "../packages/office-pack/src/index";
import { createPdf, inspectPdf, mergePdfs, readPdf, validatePdf } from "../packages/pdf-engine/src/index";
import { createPresentation, inspectPresentation, validatePresentation } from "../packages/presentation-engine/src/index";
import { createWorkbook, inspectWorkbook, validateWorkbook, workbookTable } from "../packages/spreadsheet-engine/src/index";
import { aggregate, dedupe, filter, groupCount, profile, sort, type TableResource } from "../packages/table-engine/src/index";
import type { ProjectFileService } from "../packages/workspace-contracts/src/index";

test("XLSX 创建、重新解析与表格查询", () => { const table: TableResource = { columns: ["区域", "金额"], rows: [{ 区域: "华北", 金额: 100 }, { 区域: "华东", 金额: 120 }, { 区域: "华北", 金额: 100 }] }; const data = createWorkbook("销售", table); const inspection = inspectWorkbook("/sales.xlsx", data); assert.equal(inspection.sheetDescriptors[0]?.rowCount, 3); assert.equal(validateWorkbook(data), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"); assert.equal(workbookTable(data).rows[1]?.金额, 120); assert.equal(groupCount(dedupe(filter(table, "区域", "华北")), "区域").rows[0]?.count, 1); assert.equal(profile(sort(table, "金额", "desc")).rows, 3); });

test("XLSX 拒绝异常工作簿", () => {
  assert.throws(() => validateWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])));
});
test("表格引擎支持分组财务聚合", () => {
  const table: TableResource = { columns: ["区域", "金额"], rows: [{ 区域: "华北", 金额: 10 }, { 区域: "华东", 金额: 20 }, { 区域: "华北", 金额: 30 }, { 区域: "华北", 金额: null }] };
  const result = aggregate(table, ["区域"], [
    { column: "金额", operation: "sum", label: "销售额" },
    { column: "金额", operation: "average", label: "平均销售额" },
    { column: "金额", operation: "count", label: "订单数" }
  ]);
  assert.deepEqual(result.rows, [
    { 区域: "华北", 销售额: 40, 平均销售额: 20, 订单数: 2 },
    { 区域: "华东", 销售额: 20, 平均销售额: 20, 订单数: 1 }
  ]);
});
test("DOCX 创建后必须可重新解析", async () => { const data = await createDocument("总结", ["第一段", "第二段"]); const resource = await inspectDocument("/summary.docx", data); assert.ok(resource.paragraphCount >= 3); assert.equal(await validateDocument(data), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"); });
test("PPTX 创建后必须包含演示文稿和幻灯片", async () => { const data = await createPresentation("运行摘要", ["安全发布", "本地处理"]); const resource = await inspectPresentation("/summary.pptx", data); assert.equal(resource.slideCount, 1); assert.equal(await validatePresentation(data), "application/vnd.openxmlformats-officedocument.presentationml.presentation"); });
test("Office Provider 只识别支持格式", async () => { const office = new OfficeCapabilityProvider(); const workbook = createWorkbook("数据", { columns: ["值"], rows: [{ 值: 1 }] }); const inspection = await office.inspect("/data.xlsx", workbook); assert.equal(inspection?.type, "workbook"); assert.equal(await office.inspect("/notes.txt", new TextEncoder().encode("x")), undefined); });
test("Office Provider 生成的演示文稿可重新验证", async () => { const office = new OfficeCapabilityProvider(); const draft = await office.compose("生成 PowerPoint 演示", { files: 2, summary: "本地内容" }); assert.ok(draft); assert.equal(await office.validate(draft.targetName, draft.data), "application/vnd.openxmlformats-officedocument.presentationml.presentation"); });

test("PDF 创建后可重新检查、读取文本并合并", async () => {
  const first = await createPdf("Browser Agent Report", ["Validated PDF output.", "Second paragraph."]);
  const second = await createPdf("Appendix", ["Appendix content."]);
  assert.equal(await validatePdf(first), "application/pdf");
  assert.equal((await inspectPdf("/report.pdf", first)).pageCount, 1);
  assert.match((await readPdf(first))[0]?.text ?? "", /Validated PDF output/);
  assert.equal((await inspectPdf("/merged.pdf", await mergePdfs([first, second]))).pageCount, 2);
});

test("PDF 读取拒绝包含 JavaScript 动作的文件", async () => {
  const document = await PDFDocument.create();
  document.addPage();
  document.addJavaScript("malicious", "globalThis.__browserAgentPdfScriptExecuted = true");
  const data = await document.save();
  await assert.rejects(() => readPdf(data), /不支持包含嵌入脚本的 PDF/);
  assert.equal((globalThis as typeof globalThis & { __browserAgentPdfScriptExecuted?: boolean }).__browserAgentPdfScriptExecuted, undefined);
});

test("Office Agent 工具可在浏览器主线程读取并转换工作簿", async () => {
  const files = new Map<string, Uint8Array>([["/source.xlsx", createWorkbook("数据", { columns: ["区域", "金额"], rows: [{ 区域: "华北", 金额: 10 }, { 区域: "华东", 金额: 20 }, { 区域: "华北", 金额: 30 }] })]]);
  const workspace = {
    read: async (path: string) => { const data = files.get(path); if (!data) throw new Error(`missing ${path}`); return { data, fingerprint: `fp:${path}:${data.byteLength}` }; },
    exists: async (path: string) => files.has(path),
    write: async (path: string, data: Uint8Array) => { files.set(path, data); return `fp:${path}:${data.byteLength}`; }
  } as unknown as ProjectFileService;
  const tools = new AgentToolRegistry();
  registerOfficeAgentTools(tools, { workspace });
  assert.ok(tools.list().some((tool) => tool.id === "spreadsheet.read"));
  const presentationSchema = tools.list().find((tool) => tool.id === "presentation.create")?.inputSchema.properties?.spec;
  const slideSchema = presentationSchema?.properties?.slides?.items;
  assert.deepEqual(slideSchema?.properties?.layout?.enum, ["title", "bullets", "two-column", "table", "image"]);
  assert.deepEqual(slideSchema?.properties?.image?.required, ["data"]);
  const read = await tools.execute("spreadsheet.read", { path: "/workspace/source.xlsx", limit: 2 }) as { path: string; totalRows: number; rows: unknown[] };
  assert.equal(read.path, "/source.xlsx");
  assert.equal(read.totalRows, 3);
  assert.equal(read.rows.length, 2);
  const aggregated = await tools.execute("spreadsheet.aggregate", {
    path: "/workspace/source.xlsx",
    groupBy: ["区域"],
    metrics: [
      { column: "金额", operation: "sum", label: "销售额" },
      { column: "金额", operation: "average", label: "平均销售额" },
      { column: "金额", operation: "count", label: "订单数" }
    ]
  }) as { path: string; totalGroups: number; rows: unknown[] };
  assert.equal(aggregated.path, "/source.xlsx");
  assert.equal(aggregated.totalGroups, 2);
  assert.deepEqual(aggregated.rows, [
    { 区域: "华北", 销售额: 40, 平均销售额: 20, 订单数: 2 },
    { 区域: "华东", 销售额: 20, 平均销售额: 20, 订单数: 1 }
  ]);
  const transformed = await tools.execute("spreadsheet.transform", { sourcePath: "/source.xlsx", targetPath: "/north.xlsx", operation: "filter-equals", column: "区域", value: "华北" }) as { rows: number; valid: boolean };
  assert.deepEqual(transformed, { sourcePath: "/source.xlsx", targetPath: "/north.xlsx", operation: "filter-equals", rows: 2, columns: 2, fingerprint: `fp:/north.xlsx:${files.get("/north.xlsx")?.byteLength}`, valid: true });
  assert.equal(validateWorkbook(files.get("/north.xlsx")!), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  const createdPdf = await tools.execute("pdf.create", { path: "/report.pdf", title: "Report", paragraphs: ["Verified content"] }) as { valid: boolean; inspection: { pageCount: number } };
  assert.equal(createdPdf.valid, true);
  assert.equal(createdPdf.inspection.pageCount, 1);
  const readCreatedPdf = await tools.execute("pdf.read", { path: "/report.pdf" }) as { pages: Array<{ text: string }> };
  assert.match(readCreatedPdf.pages[0]?.text ?? "", /Verified content/);

  const structuredDoc = await tools.execute("document.create", { path: "/structured.docx", spec: { title: "结构化报告", header: "Browser Agent", blocks: [{ type: "heading", text: "结论", level: 1 }, { type: "list", items: ["已验证", "可重新读取"] }] } }) as { valid: boolean; inspection: { summary: { headings: unknown[] } } };
  assert.equal(structuredDoc.valid, true);
  assert.ok(structuredDoc.inspection.summary.headings.length >= 1);
  const structuredPpt = await tools.execute("presentation.create", { path: "/structured.pptx", spec: { title: "汇报", slides: [{ layout: "title", title: "汇报", subtitle: "Browser Agent" }, { layout: "two-column", title: "进展", left: { heading: "完成", bullets: ["Word"] }, right: { heading: "待办", bullets: ["发布"] } }] } }) as { valid: boolean; inspection: { slideCount: number } };
  assert.equal(structuredPpt.valid, true);
  assert.equal(structuredPpt.inspection.slideCount, 2);
});
