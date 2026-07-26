import * as XLSX from "xlsx";
import type { WorkbookResource } from "../../office-ir/src/index";
import { tableFromMatrix, type TableResource } from "../../table-engine/src/index";

export function inspectWorkbook(path: string, data: Uint8Array): WorkbookResource {
  const workbook = XLSX.read(data, { type: "array" });
  return { resourceId: `workbook:${path}`, sourcePath: path, format: extension(path) as "xlsx" | "xls" | "csv", sheetDescriptors: workbook.SheetNames.map((name, index) => { const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name]!, { header: 1, defval: null }); const header = matrix[0] ?? []; return { sheetId: `sheet:${index}`, name, rowCount: Math.max(matrix.length - 1, 0), columnCount: header.length, columns: header.map((value, column) => ({ name: String(value || `column_${column + 1}`), type: infer(matrix.slice(1).map((row) => row[column])) })) }; }) };
}
export function workbookTable(data: Uint8Array, sheetName?: string): TableResource { const workbook = XLSX.read(data, { type: "array" }); const sheet = workbook.Sheets[sheetName ?? workbook.SheetNames[0] ?? ""]; if (!sheet) throw new Error("工作簿没有可读取的工作表。"); return tableFromMatrix(XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null })); }
export function createWorkbook(sheetName: string, table: TableResource): Uint8Array { const matrix: unknown[][] = [table.columns, ...table.rows.map((row) => table.columns.map((column) => row[column]))]; const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), sheetName); return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" })); }
export function validateWorkbook(data: Uint8Array): string { const inspected = inspectWorkbook("/artifact.xlsx", data); if (inspected.sheetDescriptors.length === 0) throw new Error("XLSX 中没有工作表。"); return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; }
function extension(path: string): string { return path.toLowerCase().split(".").pop() ?? "xlsx"; }
function infer(values: unknown[]): "string" | "number" | "boolean" | "date" | "empty" { const meaningful = values.filter((value) => value !== null && value !== ""); if (!meaningful.length) return "empty"; if (meaningful.every((value) => typeof value === "number")) return "number"; if (meaningful.every((value) => typeof value === "boolean")) return "boolean"; return "string"; }
