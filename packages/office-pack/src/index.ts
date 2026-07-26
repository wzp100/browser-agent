import type { ArtifactComposer, ArtifactDraft, ArtifactValidator, ResourceInspection, ResourceInspector } from "../../contracts/src/index";
import { type AgentToolDefinition, AgentToolRegistry, type JsonSchemaValue } from "../../command-core/src/index";
import { normalizeAgentWorkspacePath, type ProjectFileService } from "../../workspace-contracts/src/index";

export class OfficeCapabilityProvider implements ResourceInspector, ArtifactValidator, ArtifactComposer {
  readonly id = "office.pack";
  async inspect(path: string, data: Uint8Array): Promise<ResourceInspection | undefined> { const suffix = path.toLowerCase().split(".").pop(); if (suffix === "xlsx" || suffix === "xls" || suffix === "csv") { const { inspectWorkbook } = await import("../../spreadsheet-engine/src/index"); const workbook = inspectWorkbook(path, data); return { path, type: "workbook", metadata: { sheets: workbook.sheetDescriptors }, warnings: suffix === "xls" ? ["旧 XLS 应在发布前标准化为 XLSX。"] : [] }; } if (suffix === "docx") { const { inspectDocument } = await import("../../document-engine/src/index"); const document = await inspectDocument(path, data); return { path, type: "document", metadata: { ...document }, warnings: [] }; } if (suffix === "pptx") { const { inspectPresentation } = await import("../../presentation-engine/src/index"); const presentation = await inspectPresentation(path, data); return { path, type: "presentation", metadata: { ...presentation }, warnings: [] }; } if (suffix === "pdf") { const { inspectPdf } = await import("../../pdf-engine/src/index"); const pdf = await inspectPdf(path, data); return { path, type: "pdf", metadata: { ...pdf }, warnings: [] }; } return undefined; }
  supports(name: string): boolean { return /\.(xlsx|xls|csv|docx|pptx|pdf)$/i.test(name); }
  async validate(name: string, data: Uint8Array): Promise<string> { if (/\.(xlsx|xls|csv)$/i.test(name)) { const { validateWorkbook } = await import("../../spreadsheet-engine/src/index"); return validateWorkbook(data); } if (/\.docx$/i.test(name)) { const { validateDocument } = await import("../../document-engine/src/index"); return validateDocument(data); } if (/\.pptx$/i.test(name)) { const { validatePresentation } = await import("../../presentation-engine/src/index"); return validatePresentation(data); } if (/\.pdf$/i.test(name)) { const { validatePdf } = await import("../../pdf-engine/src/index"); return validatePdf(data); } throw new Error(`Office Pack 不支持 ${name}`); }
  async compose(intent: string, summary: Record<string, unknown>): Promise<ArtifactDraft | undefined> {
    const fileCount = Number((summary.totals as { files?: number } | undefined)?.files ?? summary.files ?? 0);
    const bytes = Number((summary.totals as { bytes?: number } | undefined)?.bytes ?? summary.bytes ?? 0);
    const bullets = [`分析文件：${fileCount} 个`, `总数据量：${bytes} 字节`, "产物将在用户授权的项目目录中创建", "生成后会重新解析验证文件结构"];
    if (/\b(ppt|powerpoint)\b|演示|幻灯片/i.test(intent)) { const { createPresentation } = await import("../../presentation-engine/src/index"); return { sourcePath: "/agent-summary.pptx", targetName: "agent-summary.pptx", data: await createPresentation("Agent 工作区摘要", bullets) }; }
    if (/\b(docx?|word)\b|文档|报告/i.test(intent)) { const { createDocument } = await import("../../document-engine/src/index"); return { sourcePath: "/agent-summary.docx", targetName: "agent-summary.docx", data: await createDocument("Agent 工作区摘要", bullets) }; }
    if (/\bpdf\b/i.test(intent)) { const { createPdf } = await import("../../pdf-engine/src/index"); return { sourcePath: "/agent-summary.pdf", targetName: "agent-summary.pdf", data: await createPdf("Agent 工作区摘要", bullets) }; }
    if (/\b(xlsx?|excel)\b|工作簿|表格/i.test(intent)) { const { createWorkbook } = await import("../../spreadsheet-engine/src/index"); return { sourcePath: "/agent-summary.xlsx", targetName: "agent-summary.xlsx", data: createWorkbook("摘要", { columns: ["字段", "值"], rows: [{ 字段: "文件数量", 值: fileCount }, { 字段: "总字节数", 值: bytes }, { 字段: "验证方式", 值: "生成后重新解析" }] }) }; }
    return undefined;
  }
}

export interface OfficeAgentToolOptions {
  workspace: ProjectFileService;
  onWorkspaceWrite?: (path: string) => Promise<void> | void;
}

const PRESENTATION_IMAGE_SCHEMA: JsonSchemaValue = {
  type: "object",
  description: "PNG/JPEG 图片；data 必须是完整的 base64 data URL。",
  properties: {
    data: { type: "string", description: "形如 data:image/png;base64,... 或 data:image/jpeg;base64,...。" },
    mimeType: { type: "string", enum: ["image/png", "image/jpeg"] },
    altText: { type: "string" }
  },
  required: ["data"],
  additionalProperties: false
};

const PRESENTATION_COLUMN_SCHEMA: JsonSchemaValue = {
  type: "object",
  properties: {
    heading: { type: "string" },
    text: { type: "string" },
    bullets: { type: "array", items: { type: "string" } }
  },
  additionalProperties: false
};

const PRESENTATION_SPEC_SCHEMA: JsonSchemaValue = {
  type: "object",
  description: "结构化 PresentationSpec。每页 layout 只能是 title、bullets、two-column、table 或 image；bullets 需要 bullets，双栏需要 left/right，表格需要 headers/rows，图片页需要 image。",
  properties: {
    title: { type: "string" },
    subject: { type: "string" },
    theme: {
      type: "object",
      properties: {
        backgroundColor: { type: "string", description: "六位十六进制颜色。" },
        titleColor: { type: "string", description: "六位十六进制颜色。" },
        textColor: { type: "string", description: "六位十六进制颜色。" },
        mutedColor: { type: "string", description: "六位十六进制颜色。" },
        accentColor: { type: "string", description: "六位十六进制颜色。" },
        titleFontFace: { type: "string" },
        bodyFontFace: { type: "string" }
      },
      additionalProperties: false
    },
    slides: {
      type: "array",
      items: {
        type: "object",
        properties: {
          layout: { type: "string", enum: ["title", "bullets", "two-column", "table", "image"] },
          title: { type: "string" },
          subtitle: { type: "string", description: "仅 title 页使用。" },
          bullets: { type: "array", description: "bullets 页的非空要点。", items: { type: "string" } },
          left: PRESENTATION_COLUMN_SCHEMA,
          right: PRESENTATION_COLUMN_SCHEMA,
          headers: { type: "array", description: "table 页表头。", items: { type: "string" } },
          rows: { type: "array", description: "table 页行数组，每行长度必须与 headers 相同。", items: { type: "array", items: { type: "string" } } },
          image: PRESENTATION_IMAGE_SCHEMA,
          caption: { type: "string", description: "仅 image 页使用。" }
        },
        required: ["layout", "title"],
        additionalProperties: false
      }
    }
  },
  required: ["slides"],
  additionalProperties: false
};

export function registerOfficeAgentTools(registry: AgentToolRegistry, options: OfficeAgentToolOptions): void {
  const office = new OfficeCapabilityProvider();
  registry.register({
    id: "office.inspect",
    description: "直接在浏览器主线程读取真实项目中的 XLSX/XLS/CSV/DOCX/PPTX/PDF，不需要也不得调用 Python；返回结构、警告和 fingerprint。",
    effect: "read",
    scope: "workspace",
    inputSchema: schema({ path: property("string", "Office 文件的项目相对路径。") }, ["path"]),
    execute: async (args) => {
      const path = workspacePath(args.path, "path");
      const source = await options.workspace.read(path);
      const inspection = await office.inspect(path, source.data);
      if (!inspection) throw new Error(`Office 工具不支持该文件：${path}`);
      return { ...inspection, fingerprint: source.fingerprint };
    }
  });
  registry.register({
    id: "office.validate",
    description: "重新解析真实项目中的 XLSX/XLS/CSV/DOCX/PPTX/PDF，确认生成文件结构有效；不使用 Shell 或 Python。",
    effect: "read",
    scope: "workspace",
    inputSchema: schema({ path: property("string", "待验证 Office 文件路径。") }, ["path"]),
    execute: async (args) => {
      const path = workspacePath(args.path, "path");
      const source = await options.workspace.read(path);
      return { path, mime: await office.validate(path, source.data), fingerprint: source.fingerprint, valid: true };
    }
  });
  registry.register({
    id: "spreadsheet.read",
    description: "用浏览器内 Spreadsheet Engine 读取 XLSX/XLS/CSV 的指定工作表，返回列、概要和受限行样本；不要探测 Python。",
    effect: "read",
    scope: "workspace",
    inputSchema: schema({
      path: property("string", "工作簿路径。"),
      sheetName: property("string", "可选工作表名称；省略时读取第一张表。"),
      limit: property("number", "返回的最大样本行数，默认 50，最大 200。")
    }, ["path"]),
    execute: async (args) => {
      const path = workspacePath(args.path, "path");
      const source = await options.workspace.read(path);
      const [{ workbookTable }, { profile }] = await Promise.all([import("../../spreadsheet-engine/src/index"), import("../../table-engine/src/index")]);
      const table = workbookTable(source.data, optionalString(args.sheetName));
      const limit = optionalInteger(args.limit, 50, 1, 200);
      return { path, columns: table.columns, totalRows: table.rows.length, rows: table.rows.slice(0, limit), profile: profile(table), fingerprint: source.fingerprint, truncated: table.rows.length > limit };
    }
  });
  registry.register({
    id: "spreadsheet.aggregate",
    description: "直接在浏览器内对完整工作表执行求和、平均值、最小值、最大值、计数和分组汇总；适合销售与财务分析，不创建脚本、不使用 Shell。",
    effect: "read",
    scope: "workspace",
    inputSchema: schema({
      path: property("string", "工作簿的项目相对路径，例如 /销售数据.xlsx。"),
      sheetName: property("string", "可选工作表名称；省略时读取第一张表。"),
      groupBy: property("array", "可选分组列名数组；省略时汇总整张表。", { type: "string" }),
      metrics: property("array", "聚合指标数组；每项包含 column、operation（sum、average、min、max、count）和可选 label。", { type: "object" }),
      limit: property("number", "返回的最大分组数，默认 200，最大 1000。")
    }, ["path", "metrics"]),
    execute: async (args) => {
      const path = workspacePath(args.path, "path");
      const source = await options.workspace.read(path);
      const [{ workbookTable }, { aggregate }] = await Promise.all([import("../../spreadsheet-engine/src/index"), import("../../table-engine/src/index")]);
      const groupBy = optionalStringArray(args.groupBy, "groupBy");
      const metrics = aggregateMetrics(args.metrics);
      const table = aggregate(workbookTable(source.data, optionalString(args.sheetName)), groupBy, metrics);
      const limit = optionalInteger(args.limit, 200, 1, 1000);
      return { path, groupBy, metrics, totalGroups: table.rows.length, rows: table.rows.slice(0, limit), fingerprint: source.fingerprint, truncated: table.rows.length > limit };
    }
  });
  registry.register({
    id: "spreadsheet.create",
    description: "用浏览器内 Spreadsheet Engine 创建新的 XLSX；若覆盖已有文件必须提供 fingerprint，写入后自动重新解析验证。",
    effect: "write",
    scope: "workspace",
    inputSchema: schema({
      path: property("string", "输出 .xlsx 路径。"),
      sheetName: property("string", "工作表名称。"),
      columns: property("array", "列名数组。", { type: "string" }),
      rows: property("array", "行对象数组，键应对应 columns。", { type: "object" }),
      expectedFingerprint: property("string", "覆盖已有文件时由 office.inspect 或 spreadsheet.read 返回的 fingerprint。")
    }, ["path", "sheetName", "columns", "rows"]),
    execute: async (args) => {
      const path = xlsxPath(workspacePath(args.path, "path"));
      const columns = stringArray(args.columns, "columns");
      const rows = tableRows(args.rows, columns);
      const { createWorkbook, validateWorkbook } = await import("../../spreadsheet-engine/src/index");
      const data = createWorkbook(requiredString(args.sheetName, "sheetName"), { columns, rows });
      validateWorkbook(data);
      const fingerprint = await writeOfficeOutput(options, path, data, optionalString(args.expectedFingerprint));
      return { path, rows: rows.length, columns: columns.length, fingerprint, valid: true };
    }
  });
  registry.register({
    id: "spreadsheet.transform",
    description: "在浏览器内对完整工作表执行 filter-equals、sort、dedupe 或 group-count，并写成新的 XLSX；不把整表交给模型，也不使用 Python。",
    effect: "write",
    scope: "workspace",
    inputSchema: schema({
      sourcePath: property("string", "源 XLSX/XLS/CSV 路径。"),
      targetPath: property("string", "输出 .xlsx 路径，默认应与源文件不同。"),
      operation: property("string", "操作：filter-equals、sort、dedupe、group-count。"),
      sheetName: property("string", "可选源工作表名称。"),
      outputSheetName: property("string", "输出工作表名称，默认 结果。"),
      column: property("string", "filter-equals、sort、group-count 使用的列。"),
      value: property("string", "filter-equals 的匹配值。"),
      direction: property("string", "sort 方向：asc 或 desc。"),
      columns: property("array", "dedupe 使用的列名；省略时使用全部列。", { type: "string" }),
      expectedFingerprint: property("string", "覆盖已有目标文件时的 fingerprint。")
    }, ["sourcePath", "targetPath", "operation"]),
    execute: async (args) => {
      const sourcePath = workspacePath(args.sourcePath, "sourcePath");
      const targetPath = xlsxPath(workspacePath(args.targetPath, "targetPath"));
      const source = await options.workspace.read(sourcePath);
      const [{ workbookTable, createWorkbook, validateWorkbook }, tableEngine] = await Promise.all([import("../../spreadsheet-engine/src/index"), import("../../table-engine/src/index")]);
      let table = workbookTable(source.data, optionalString(args.sheetName));
      const operation = requiredString(args.operation, "operation");
      if (operation === "filter-equals") table = tableEngine.filter(table, requiredString(args.column, "column"), tableValue(args.value));
      else if (operation === "sort") table = tableEngine.sort(table, requiredString(args.column, "column"), args.direction === "desc" ? "desc" : "asc");
      else if (operation === "dedupe") table = tableEngine.dedupe(table, args.columns === undefined ? table.columns : stringArray(args.columns, "columns"));
      else if (operation === "group-count") table = tableEngine.groupCount(table, requiredString(args.column, "column"));
      else throw new Error(`不支持的 spreadsheet.transform 操作：${operation}`);
      const data = createWorkbook(optionalString(args.outputSheetName) ?? "结果", table);
      validateWorkbook(data);
      const fingerprint = await writeOfficeOutput(options, targetPath, data, optionalString(args.expectedFingerprint));
      return { sourcePath, targetPath, operation, rows: table.rows.length, columns: table.columns.length, fingerprint, valid: true };
    }
  });
  registry.register({
    id: "document.create",
    description: "用浏览器内 Document Engine 创建并重新检查 DOCX。优先传 spec（title/header/footer/theme/blocks，blocks 支持 heading、paragraph、list、table、image）；旧 title+paragraphs 保留一个版本。",
    effect: "write",
    scope: "workspace",
    inputSchema: schema({ path: property("string", "输出 .docx 路径。"), spec: property("object", "结构化 DocumentSpec：可含 title、header、footer、theme 和 blocks。"), title: property("string", "旧接口文档标题。"), paragraphs: property("array", "旧接口正文段落数组。", { type: "string" }), expectedFingerprint: property("string", "覆盖 fingerprint。") }, ["path"]),
    execute: async (args) => {
      const path = extensionPath(workspacePath(args.path, "path"), "docx");
      const { createDocument, validateDocument, inspectDocument } = await import("../../document-engine/src/index");
      const data = args.spec && typeof args.spec === "object" && !Array.isArray(args.spec)
        ? await createDocument(args.spec as import("../../document-engine/src/index").DocumentSpec)
        : await createDocument(requiredString(args.title, "title"), stringArray(args.paragraphs, "paragraphs"));
      await validateDocument(data);
      const fingerprint = await writeOfficeOutput(options, path, data, optionalString(args.expectedFingerprint));
      const persisted = await options.workspace.read(path);
      await validateDocument(persisted.data);
      return { path, fingerprint, valid: true, inspection: await inspectDocument(path, persisted.data) };
    }
  });
  registry.register({
    id: "presentation.create",
    description: "用浏览器内 Presentation Engine 创建并重新检查多页 PPTX。优先传 spec（theme/slides，slides 支持 title、bullets、two-column、table、image）；旧 title+bullets 保留一个版本。",
    effect: "write",
    scope: "workspace",
    inputSchema: schema({ path: property("string", "输出 .pptx 路径。"), spec: PRESENTATION_SPEC_SCHEMA, title: property("string", "旧接口演示标题。"), bullets: property("array", "旧接口要点数组。", { type: "string" }), expectedFingerprint: property("string", "覆盖 fingerprint。") }, ["path"]),
    execute: async (args) => {
      const path = extensionPath(workspacePath(args.path, "path"), "pptx");
      const { createPresentation, validatePresentation, inspectPresentation } = await import("../../presentation-engine/src/index");
      const data = args.spec && typeof args.spec === "object" && !Array.isArray(args.spec)
        ? await createPresentation(args.spec as import("../../presentation-engine/src/index").PresentationSpec)
        : await createPresentation(requiredString(args.title, "title"), stringArray(args.bullets, "bullets"));
      await validatePresentation(data);
      const fingerprint = await writeOfficeOutput(options, path, data, optionalString(args.expectedFingerprint));
      const persisted = await options.workspace.read(path);
      await validatePresentation(persisted.data);
      return { path, fingerprint, valid: true, inspection: await inspectPresentation(path, persisted.data) };
    }
  });
  registry.register({
    id: "pdf.inspect",
    description: "在浏览器中检查 PDF 页数和元数据，返回 fingerprint；不把 PDF 自动发送给模型。",
    effect: "read",
    scope: "workspace",
    inputSchema: schema({ path: property("string", "PDF 项目相对路径。") }, ["path"]),
    execute: async (args) => {
      const path = extensionPath(workspacePath(args.path, "path"), "pdf");
      const source = await options.workspace.read(path);
      const { inspectPdf } = await import("../../pdf-engine/src/index");
      return { ...await inspectPdf(path, source.data), fingerprint: source.fingerprint };
    }
  });
  registry.register({
    id: "pdf.read",
    description: "按页提取 PDF 文本；结果最多读取 50 页，不自动把原始 PDF 作为附件发送。",
    effect: "read",
    scope: "workspace",
    inputSchema: schema({ path: property("string", "PDF 路径。"), startPage: property("number", "起始页，默认 1。"), pageCount: property("number", "页数，默认 20，最大 50。") }, ["path"]),
    execute: async (args) => {
      const path = extensionPath(workspacePath(args.path, "path"), "pdf");
      const source = await options.workspace.read(path);
      const { readPdf } = await import("../../pdf-engine/src/index");
      const pages = await readPdf(source.data, optionalInteger(args.startPage, 1, 1, 100_000), optionalInteger(args.pageCount, 20, 1, 50));
      return { path, pages, fingerprint: source.fingerprint };
    }
  });
  registry.register({
    id: "pdf.render_page",
    description: "把单个 PDF 页面渲染为 PNG 文件；后续只有支持图片输入的模型才能分析该 PNG。",
    effect: "write",
    scope: "workspace",
    inputSchema: schema({ path: property("string", "源 PDF 路径。"), page: property("number", "页码。"), targetPath: property("string", "输出 .png 路径。"), scale: property("number", "缩放，0.5 到 3。"), expectedFingerprint: property("string", "覆盖目标 PNG 时的 fingerprint。") }, ["path", "page", "targetPath"]),
    execute: async (args) => {
      const path = extensionPath(workspacePath(args.path, "path"), "pdf");
      const targetPath = extensionPath(workspacePath(args.targetPath, "targetPath"), "png");
      const source = await options.workspace.read(path);
      const { renderPdfPage } = await import("../../pdf-engine/src/index");
      const data = await renderPdfPage(source.data, optionalInteger(args.page, 1, 1, 100_000), typeof args.scale === "number" ? args.scale : 1.5);
      if (data.byteLength > 8 * 1024 * 1024) throw new Error("渲染页超过 8 MiB 图片输入上限，请降低 scale 后重试。 ");
      const fingerprint = await writeOfficeOutput(options, targetPath, data, optionalString(args.expectedFingerprint));
      return {
        path,
        page: optionalInteger(args.page, 1, 1, 100_000),
        targetPath,
        fingerprint,
        mime: "image/png",
        modelContentParts: [{ type: "image", mimeType: "image/png", data: bytesToBase64(data) }]
      };
    }
  });
  registry.register({
    id: "pdf.create",
    description: "创建经过重新解析验证的 PDF；中文内容在浏览器中使用系统字体栅格化以保证可见。",
    effect: "write",
    scope: "workspace",
    inputSchema: schema({ path: property("string", "输出 .pdf 路径。"), title: property("string", "标题。"), paragraphs: property("array", "正文段落。", { type: "string" }), expectedFingerprint: property("string", "覆盖 fingerprint。") }, ["path", "title", "paragraphs"]),
    execute: async (args) => {
      const path = extensionPath(workspacePath(args.path, "path"), "pdf");
      const { createPdf, validatePdf, inspectPdf } = await import("../../pdf-engine/src/index");
      const data = await createPdf(requiredString(args.title, "title"), stringArray(args.paragraphs, "paragraphs"));
      await validatePdf(data);
      const fingerprint = await writeOfficeOutput(options, path, data, optionalString(args.expectedFingerprint));
      const persisted = await options.workspace.read(path);
      await validatePdf(persisted.data);
      return { path, fingerprint, valid: true, inspection: await inspectPdf(path, persisted.data) };
    }
  });
  registry.register({
    id: "pdf.merge",
    description: "按给定顺序合并两个或更多 PDF，并重新解析验证。",
    effect: "write",
    scope: "workspace",
    inputSchema: schema({ sourcePaths: property("array", "源 PDF 路径数组。", { type: "string" }), targetPath: property("string", "输出 .pdf 路径。"), expectedFingerprint: property("string", "覆盖 fingerprint。") }, ["sourcePaths", "targetPath"]),
    execute: async (args) => {
      const sourcePaths = stringArray(args.sourcePaths, "sourcePaths").map((path) => extensionPath(workspacePath(path, "sourcePaths"), "pdf"));
      const targetPath = extensionPath(workspacePath(args.targetPath, "targetPath"), "pdf");
      const inputs = await Promise.all(sourcePaths.map(async (path) => (await options.workspace.read(path)).data));
      const { mergePdfs, inspectPdf, validatePdf } = await import("../../pdf-engine/src/index");
      const data = await mergePdfs(inputs);
      const fingerprint = await writeOfficeOutput(options, targetPath, data, optionalString(args.expectedFingerprint));
      const persisted = await options.workspace.read(targetPath);
      await validatePdf(persisted.data);
      return { sourcePaths, targetPath, fingerprint, valid: true, inspection: await inspectPdf(targetPath, persisted.data) };
    }
  });
}

function schema(properties: NonNullable<AgentToolDefinition["inputSchema"]["properties"]>, required: string[] = []): AgentToolDefinition["inputSchema"] { return { type: "object", properties, required, additionalProperties: false }; }
function property(type: string, description: string, items?: JsonSchemaValue): JsonSchemaValue { return items === undefined ? { type, description } : { type, description, items }; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`缺少工具参数：${name}`); return value.trim(); }
function optionalString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function workspacePath(value: unknown, name: string): string { return normalizeAgentWorkspacePath(requiredString(value, name)); }
function optionalInteger(value: unknown, fallback: number, minimum: number, maximum: number): number { return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), minimum), maximum) : fallback; }
function stringArray(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${name} 必须是非空字符串数组。`); return value.map((item) => String(item).trim()); }
function optionalStringArray(value: unknown, name: string): string[] { return value === undefined ? [] : stringArray(value, name); }
function aggregateMetrics(value: unknown): Array<{ column: string; operation: "sum" | "average" | "min" | "max" | "count"; label?: string }> {
  if (!Array.isArray(value) || value.length === 0) throw new Error("metrics 必须是非空聚合指标数组。");
  const operations = new Set(["sum", "average", "min", "max", "count"]);
  return value.map((metric, index) => {
    if (!metric || typeof metric !== "object" || Array.isArray(metric)) throw new Error(`metrics[${index}] 必须是对象。`);
    const item = metric as Record<string, unknown>;
    const column = requiredString(item.column, `metrics[${index}].column`);
    const operation = requiredString(item.operation, `metrics[${index}].operation`);
    if (!operations.has(operation)) throw new Error(`metrics[${index}].operation 不受支持：${operation}`);
    const label = optionalString(item.label);
    return { column, operation: operation as "sum" | "average" | "min" | "max" | "count", ...(label ? { label } : {}) };
  });
}
function tableValue(value: unknown): string | number | boolean | null { if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value; throw new Error("表格值只能是字符串、数字、布尔值或 null。"); }
function tableRows(value: unknown, columns: string[]): Array<Record<string, string | number | boolean | null>> {
  if (!Array.isArray(value)) throw new Error("rows 必须是对象数组。");
  return value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("rows 中的每一项必须是对象。");
    return Object.fromEntries(columns.map((column) => [column, tableValue((row as Record<string, unknown>)[column] ?? null)]));
  });
}
function extensionPath(path: string, extension: string): string { if (!path.toLowerCase().endsWith(`.${extension}`)) throw new Error(`输出文件必须是 .${extension}：${path}`); return path; }
function xlsxPath(path: string): string { return extensionPath(path, "xlsx"); }
function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < data.length; index += chunkSize) binary += String.fromCharCode(...data.subarray(index, index + chunkSize));
  return btoa(binary);
}
async function writeOfficeOutput(options: OfficeAgentToolOptions, path: string, data: Uint8Array, expectedFingerprint?: string): Promise<string> {
  if (await options.workspace.exists(path) && !expectedFingerprint) throw new Error(`目标文件已存在，覆盖前必须先读取 fingerprint：${path}`);
  const fingerprint = await options.workspace.write(path, data, expectedFingerprint ? { expectedFingerprint } : undefined);
  await options.onWorkspaceWrite?.(path);
  return fingerprint;
}
