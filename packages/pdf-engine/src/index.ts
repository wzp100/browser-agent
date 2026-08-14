import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PdfResource } from "../../office-ir/src/index";

export interface PdfTextPage { page: number; text: string; }

export async function inspectPdf(path: string, data: Uint8Array): Promise<PdfResource> {
  const document = await PDFDocument.load(data, { updateMetadata: false });
  const title = document.getTitle();
  const author = document.getAuthor();
  return {
    resourceId: `pdf:${path}`,
    sourcePath: path,
    format: "pdf",
    pageCount: document.getPageCount(),
    ...(title ? { title } : {}),
    ...(author ? { author } : {})
  };
}

export async function validatePdf(data: Uint8Array): Promise<string> {
  const resource = await inspectPdf("/artifact.pdf", data);
  if (resource.pageCount < 1) throw new Error("PDF 中没有页面。");
  return "application/pdf";
}

export async function readPdf(data: Uint8Array, startPage = 1, pageCount = 20): Promise<PdfTextPage[]> {
  const { document: pdf, loading } = await loadSafePdf(data);
  const first = Math.min(Math.max(Math.trunc(startPage), 1), pdf.numPages);
  const last = Math.min(pdf.numPages, first + Math.min(Math.max(Math.trunc(pageCount), 1), 50) - 1);
  const pages: PdfTextPage[] = [];
  try {
    for (let pageNumber = first; pageNumber <= last; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => "str" in item ? item.str : "").filter(Boolean).join(" ");
      pages.push({ page: pageNumber, text });
      page.cleanup();
    }
  } finally { await loading.destroy(); }
  return pages;
}

export async function renderPdfPage(data: Uint8Array, pageNumber: number, scale = 1.5): Promise<Uint8Array> {
  if (typeof document === "undefined") throw new Error("PDF 页面渲染需要浏览器 Canvas。 ");
  const { document: pdf, loading } = await loadSafePdf(data);
  try {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) throw new Error(`PDF 页码越界：${pageNumber}`);
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: Math.min(Math.max(scale, 0.5), 3) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建 PDF 渲染画布。 ");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("PDF 页面 PNG 编码失败。")), "image/png"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally { await loading.destroy(); }
}

async function loadSafePdf(data: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({ data: data.slice() });
  try {
    const document = await loading.promise;
    // Browser Agent never creates PDF.js' scripting manager or annotation layer.
    // Reject scripted documents as a second boundary beyond the patched parser.
    if (await document.hasJSActions()) throw new Error("出于安全原因，不支持包含嵌入脚本的 PDF。 ");
    return { document, loading };
  } catch (error) {
    await loading.destroy();
    throw error;
  }
}

export async function createPdf(title: string, paragraphs: string[]): Promise<Uint8Array> {
  if (!title.trim() || !paragraphs.length) throw new Error("PDF 标题和正文不能为空。 ");
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.setAuthor("Browser Agent");
  if (/[^\u0000-\u00ff]/.test([title, ...paragraphs].join("")) && typeof window !== "undefined" && typeof globalThis.document !== "undefined") {
    await addRasterizedPages(document, title, paragraphs);
  } else {
    const font = await document.embedFont(StandardFonts.Helvetica);
    const bold = await document.embedFont(StandardFonts.HelveticaBold);
    let page = document.addPage([595.28, 841.89]);
    let y = 790;
    page.drawText(title, { x: 48, y, size: 22, font: bold, color: rgb(0.08, 0.12, 0.18) });
    y -= 42;
    for (const paragraph of paragraphs) {
      for (const line of wrapText(paragraph, 82)) {
        if (y < 55) { page = document.addPage([595.28, 841.89]); y = 790; }
        page.drawText(line, { x: 48, y, size: 11, font, color: rgb(0.12, 0.16, 0.2) });
        y -= 17;
      }
      y -= 8;
    }
  }
  const data = await document.save();
  await validatePdf(data);
  return data;
}

export async function mergePdfs(inputs: Uint8Array[]): Promise<Uint8Array> {
  if (inputs.length < 2) throw new Error("至少需要两个 PDF 才能合并。 ");
  const output = await PDFDocument.create();
  for (const input of inputs) {
    const source = await PDFDocument.load(input);
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) output.addPage(page);
  }
  const data = await output.save();
  await validatePdf(data);
  return data;
}

async function addRasterizedPages(pdf: PDFDocument, title: string, paragraphs: string[]): Promise<void> {
  const lines = [title, "", ...paragraphs.flatMap((paragraph) => [...wrapText(paragraph, 38), ""] )];
  for (let offset = 0; offset < lines.length; offset += 32) {
    const canvas = globalThis.document.createElement("canvas");
    canvas.width = 1190; canvas.height = 1684;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建 PDF 画布。 ");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#172033";
    lines.slice(offset, offset + 32).forEach((line, index) => {
      context.font = index === 0 && offset === 0 ? "bold 44px system-ui, sans-serif" : "28px system-ui, sans-serif";
      context.fillText(line, 96, 120 + index * 46, 1000);
    });
    const dataUrl = canvas.toDataURL("image/png");
    const image = await pdf.embedPng(dataUrl);
    const page = pdf.addPage([595.28, 841.89]);
    page.drawImage(image, { x: 0, y: 0, width: 595.28, height: 841.89 });
  }
}

function wrapText(value: string, width: number): string[] {
  const text = value.trim();
  if (!text) return [""];
  const lines: string[] = [];
  for (let offset = 0; offset < text.length; offset += width) lines.push(text.slice(offset, offset + width));
  return lines;
}
