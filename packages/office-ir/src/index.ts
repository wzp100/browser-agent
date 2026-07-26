export type OfficeFormat = "xlsx" | "xls" | "csv" | "docx" | "pptx" | "pdf";
export interface ColumnDescriptor { name: string; type: "string" | "number" | "boolean" | "date" | "empty"; }
export interface SheetDescriptor { sheetId: string; name: string; rowCount: number; columnCount: number; columns: ColumnDescriptor[]; }
export interface WorkbookResource { resourceId: string; sourcePath: string; format: OfficeFormat; sheetDescriptors: SheetDescriptor[]; }
export interface DocumentResource { resourceId: string; sourcePath: string; format: "docx"; paragraphCount: number; tableCount: number; }
export interface PresentationResource { resourceId: string; sourcePath: string; format: "pptx"; slideCount: number; }
export interface PdfResource { resourceId: string; sourcePath: string; format: "pdf"; pageCount: number; title?: string; author?: string; }
