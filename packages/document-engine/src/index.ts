import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type FileChild
} from "docx";
import JSZip from "jszip";
import type { DocumentResource } from "../../office-ir/src/index";

export interface DocumentTheme {
  fontFamily?: string;
  titleColor?: string;
  headingColor?: string;
  bodyColor?: string;
  accentColor?: string;
}

export interface DocumentImage {
  data: string | Uint8Array;
  mimeType?: "image/png" | "image/jpeg";
  width?: number;
  height?: number;
  altText?: string;
}

export type DocumentBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "paragraph"; text: string; bold?: boolean; italic?: boolean; alignment?: "left" | "center" | "right" | "justify" }
  | { type: "list"; items: string[]; ordered?: boolean }
  | { type: "table"; headers?: string[]; rows: string[][] }
  | { type: "image"; image: DocumentImage; caption?: string };

export interface DocumentSpec {
  title?: string;
  blocks: DocumentBlock[];
  header?: string;
  footer?: string;
  theme?: DocumentTheme;
}

export interface DocumentStructuredSummary {
  title?: string;
  headings: Array<{ level: number; text: string }>;
  paragraphs: string[];
  lists: string[][];
  tables: Array<{ rows: string[][] }>;
  imageCount: number;
  hasHeader: boolean;
  hasFooter: boolean;
}

export interface DocumentInspection extends DocumentResource {
  summary: DocumentStructuredSummary;
}

const DEFAULT_THEME: Required<DocumentTheme> = {
  fontFamily: "Aptos",
  titleColor: "172554",
  headingColor: "1E3A8A",
  bodyColor: "1F2937",
  accentColor: "2563EB"
};

export function createDocument(title: string, paragraphs: string[]): Promise<Uint8Array>;
export function createDocument(spec: DocumentSpec): Promise<Uint8Array>;
export async function createDocument(titleOrSpec: string | DocumentSpec, paragraphs: string[] = []): Promise<Uint8Array> {
  const spec: DocumentSpec = typeof titleOrSpec === "string"
    ? { title: titleOrSpec, blocks: paragraphs.map((text) => ({ type: "paragraph" as const, text })) }
    : titleOrSpec;
  validateDocumentSpec(spec);
  const rawTheme = { ...DEFAULT_THEME, ...spec.theme };
  const theme: Required<DocumentTheme> = {
    fontFamily: rawTheme.fontFamily.trim() || DEFAULT_THEME.fontFamily,
    titleColor: normalizeColor(rawTheme.titleColor),
    headingColor: normalizeColor(rawTheme.headingColor),
    bodyColor: normalizeColor(rawTheme.bodyColor),
    accentColor: normalizeColor(rawTheme.accentColor)
  };
  const children: FileChild[] = [];
  if (spec.title) children.push(new Paragraph({ text: spec.title, heading: HeadingLevel.TITLE, spacing: { after: 360 } }));
  for (const block of spec.blocks) children.push(...documentBlock(block, theme));
  const document = new Document({
    ...(spec.title ? { title: spec.title } : {}),
    creator: "Browser Agent",
    styles: {
      default: {
        document: { run: { font: theme.fontFamily, size: 22, color: theme.bodyColor }, paragraph: { spacing: { after: 160, line: 300 } } },
        title: { run: { font: theme.fontFamily, size: 40, bold: true, color: theme.titleColor }, paragraph: { spacing: { after: 360 } } },
        heading1: { run: { font: theme.fontFamily, size: 32, bold: true, color: theme.headingColor }, paragraph: { spacing: { before: 280, after: 160 }, keepNext: true } },
        heading2: { run: { font: theme.fontFamily, size: 28, bold: true, color: theme.headingColor }, paragraph: { spacing: { before: 240, after: 120 }, keepNext: true } },
        heading3: { run: { font: theme.fontFamily, size: 24, bold: true, color: theme.headingColor }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true } }
      }
    },
    numbering: {
      config: [{
        reference: "browser-agent-ordered-list",
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }]
      }]
    },
    sections: [{
      ...(spec.header ? { headers: { default: new Header({ children: [new Paragraph({ children: [new TextRun({ text: spec.header, color: theme.bodyColor, size: 18 })] })] }) } } : {}),
      ...(spec.footer ? { footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: spec.footer, color: theme.bodyColor, size: 18 })] })] }) } } : {}),
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080, header: 540, footer: 540 } } },
      children
    }]
  });
  const data = new Uint8Array(await Packer.toArrayBuffer(document));
  await validateDocument(data);
  await inspectDocument("/artifact.docx", data);
  return data;
}

export async function inspectDocument(path: string, data: Uint8Array): Promise<DocumentInspection> {
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file("word/document.xml")?.async("text");
  if (!xml) throw new Error("不是有效的 DOCX 文档。");
  const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
  const paragraphSummaries = paragraphs.map((paragraph) => ({ text: xmlText(paragraph), style: paragraph.match(/<w:pStyle[^>]*w:val="([^"]+)"/)?.[1], isList: /<w:numPr[ >]/.test(paragraph) })).filter((item) => item.text);
  const tables = (xml.match(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g) ?? []).map((table) => ({
    rows: (table.match(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g) ?? []).map((row) => (row.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) ?? []).map(xmlText))
  }));
  const listItems = paragraphSummaries.filter((item) => item.isList).map((item) => item.text);
  const title = paragraphSummaries.find((item) => item.style === "Title")?.text;
  const summary: DocumentStructuredSummary = {
    ...(title ? { title } : {}),
    headings: paragraphSummaries.flatMap((item) => {
      const level = item.style?.match(/^Heading([1-6])$/)?.[1];
      return level ? [{ level: Number(level), text: item.text }] : [];
    }),
    paragraphs: paragraphSummaries.filter((item) => !item.style?.startsWith("Heading") && item.style !== "Title" && !item.isList).map((item) => item.text),
    lists: listItems.length ? [listItems] : [],
    tables,
    imageCount: Object.keys(zip.files).filter((name) => /^word\/media\//.test(name) && !zip.files[name]?.dir).length,
    hasHeader: Object.keys(zip.files).some((name) => /^word\/header\d+\.xml$/.test(name)),
    hasFooter: Object.keys(zip.files).some((name) => /^word\/footer\d+\.xml$/.test(name))
  };
  return {
    resourceId: `document:${path}`,
    sourcePath: path,
    format: "docx",
    paragraphCount: paragraphs.length,
    tableCount: tables.length,
    summary
  };
}

export async function summarizeDocument(data: Uint8Array): Promise<DocumentStructuredSummary> {
  return (await inspectDocument("/artifact.docx", data)).summary;
}

export async function validateDocument(data: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(data);
  if (!zip.file("[Content_Types].xml") || !zip.file("_rels/.rels")) throw new Error("DOCX 包结构不完整。");
  await inspectDocument("/artifact.docx", data);
  return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

function documentBlock(block: DocumentBlock, theme: Required<DocumentTheme>): FileChild[] {
  if (block.type === "heading") return [new Paragraph({ text: block.text, heading: headingLevel(block.level ?? 1) })];
  if (block.type === "paragraph") {
    const paragraphAlignment = alignment(block.alignment);
    return [new Paragraph({
      ...(paragraphAlignment ? { alignment: paragraphAlignment } : {}),
      children: [new TextRun({ text: block.text, ...(block.bold !== undefined ? { bold: block.bold } : {}), ...(block.italic !== undefined ? { italics: block.italic } : {}), color: theme.bodyColor })]
    })];
  }
  if (block.type === "list") return block.items.map((text) => new Paragraph(block.ordered
    ? { text, numbering: { reference: "browser-agent-ordered-list", level: 0 } }
    : { text, bullet: { level: 0 } }));
  if (block.type === "table") {
    const rows = [
      ...(block.headers ? [new TableRow({ tableHeader: true, children: block.headers.map((text) => new TableCell({ shading: { type: ShadingType.CLEAR, fill: theme.accentColor, color: "auto" }, children: [new Paragraph({ children: [new TextRun({ text, bold: true, color: "FFFFFF" })] })] })) })] : []),
      ...block.rows.map((row) => new TableRow({ children: row.map((text) => new TableCell({ children: [new Paragraph(text)] })) }))
    ];
    return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, margins: { top: 80, bottom: 80, left: 100, right: 100 } })];
  }
  const image = normalizeDocumentImage(block.image);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: image.type, data: image.data, transformation: { width: image.width, height: image.height }, altText: { name: block.image.altText ?? "Document image", description: block.image.altText ?? "Document image" } })] }),
    ...(block.caption ? [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: block.caption, italics: true, color: theme.bodyColor, size: 18 })] })] : [])
  ];
}

function validateDocumentSpec(spec: DocumentSpec): void {
  if (!spec || !Array.isArray(spec.blocks)) throw new Error("DocumentSpec.blocks 必须是数组。");
  if (!spec.title?.trim() && spec.blocks.length === 0) throw new Error("文档不能为空。");
  for (const block of spec.blocks) {
    if ((block.type === "heading" || block.type === "paragraph") && !block.text.trim()) throw new Error(`${block.type} 文本不能为空。`);
    if (block.type === "list" && (!block.items.length || block.items.some((item) => !item.trim()))) throw new Error("列表至少需要一个非空条目。");
    if (block.type === "table" && !block.rows.length) throw new Error("表格至少需要一行数据。");
  }
}

function normalizeDocumentImage(image: DocumentImage): { type: "png" | "jpg"; data: Uint8Array; width: number; height: number } {
  const source = typeof image.data === "string" ? parseDataUrl(image.data) : { data: image.data, mimeType: image.mimeType ?? detectImageMime(image.data) };
  if (source.mimeType !== "image/png" && source.mimeType !== "image/jpeg") throw new Error("Word 图片仅支持 PNG 或 JPEG。");
  const width = positiveDimension(image.width, 640);
  const height = positiveDimension(image.height, 360);
  return { type: source.mimeType === "image/png" ? "png" : "jpg", data: source.data, width, height };
}

function parseDataUrl(value: string): { data: Uint8Array; mimeType: "image/png" | "image/jpeg" } {
  const match = value.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match?.[1] || !match[2]) throw new Error("图片必须是 PNG/JPEG base64 data URL。");
  const binary = atob(match[2].replace(/\s/g, ""));
  return { data: Uint8Array.from(binary, (character) => character.charCodeAt(0)), mimeType: match[1] as "image/png" | "image/jpeg" };
}

function detectImageMime(data: Uint8Array): "image/png" | "image/jpeg" {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  throw new Error("无法识别图片格式，请显式提供 mimeType。");
}

function positiveDimension(value: number | undefined, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback; }
function normalizeColor(value: string): string { const color = value.trim().replace(/^#/, "").toUpperCase(); if (!/^[0-9A-F]{6}$/.test(color)) throw new Error(`颜色必须是六位十六进制值：${value}`); return color; }
function headingLevel(level: 1 | 2 | 3 | 4 | 5 | 6): (typeof HeadingLevel)[keyof typeof HeadingLevel] { return HeadingLevel[`HEADING_${level}` as keyof typeof HeadingLevel]; }
function alignment(value: "left" | "center" | "right" | "justify" | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  if (value === "center") return AlignmentType.CENTER;
  if (value === "right") return AlignmentType.RIGHT;
  if (value === "justify") return AlignmentType.JUSTIFIED;
  return value === "left" ? AlignmentType.LEFT : undefined;
}
function xmlText(xml: string): string { return (xml.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) ?? []).map((item) => decodeXml(item.replace(/^<w:t(?:\s[^>]*)?>|<\/w:t>$/g, ""))).join(""); }
function decodeXml(value: string): string { return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"); }
