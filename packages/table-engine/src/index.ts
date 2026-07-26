export type TableValue = string | number | boolean | null;
export interface TableResource { columns: string[]; rows: Array<Record<string, TableValue>>; }
export interface TableProfile { rows: number; columns: Array<{ name: string; nonNull: number; distinct: number; type: string }>; }
export type AggregateOperation = "sum" | "average" | "min" | "max" | "count";
export interface AggregateMetric { column: string; operation: AggregateOperation; label?: string; }

export function tableFromMatrix(matrix: unknown[][]): TableResource {
  const header = (matrix[0] ?? []).map((value, index) => String(value || `column_${index + 1}`));
  return { columns: header, rows: matrix.slice(1).map((row) => Object.fromEntries(header.map((column, index) => [column, normalize(row[index])])) as Record<string, TableValue>) };
}
export function profile(table: TableResource): TableProfile {
  return { rows: table.rows.length, columns: table.columns.map((name) => { const values = table.rows.map((row) => row[name]).filter((value) => value !== null); return { name, nonNull: values.length, distinct: new Set(values.map(String)).size, type: values.every((value) => typeof value === "number") ? "number" : values.every((value) => typeof value === "boolean") ? "boolean" : "string" }; }) };
}
export function filter(table: TableResource, column: string, value: TableValue): TableResource { return { ...table, rows: table.rows.filter((row) => row[column] === value) }; }
export function sort(table: TableResource, column: string, direction: "asc" | "desc" = "asc"): TableResource { const multiplier = direction === "asc" ? 1 : -1; return { ...table, rows: [...table.rows].sort((left, right) => String(left[column] ?? "").localeCompare(String(right[column] ?? "")) * multiplier) }; }
export function dedupe(table: TableResource, columns = table.columns): TableResource { const seen = new Set<string>(); return { ...table, rows: table.rows.filter((row) => { const key = JSON.stringify(columns.map((column) => row[column])); if (seen.has(key)) return false; seen.add(key); return true; }) }; }
export function groupCount(table: TableResource, column: string): TableResource { const counts = new Map<string, number>(); for (const row of table.rows) { const key = String(row[column] ?? ""); counts.set(key, (counts.get(key) ?? 0) + 1); } return { columns: [column, "count"], rows: [...counts].map(([key, count]) => ({ [column]: key, count })) }; }
export function aggregate(table: TableResource, groupBy: string[], metrics: AggregateMetric[]): TableResource {
  if (!metrics.length) throw new Error("至少需要一个聚合指标。");
  for (const column of [...groupBy, ...metrics.map((metric) => metric.column)]) if (!table.columns.includes(column)) throw new Error(`表格中不存在列：${column}`);
  const labels = metrics.map((metric) => metric.label?.trim() || `${metric.column}_${metric.operation}`);
  if (new Set([...groupBy, ...labels]).size !== groupBy.length + labels.length) throw new Error("分组列或聚合结果名称重复。");
  const groups = new Map<string, { values: TableValue[]; rows: Array<Record<string, TableValue>> }>();
  for (const row of table.rows) {
    const values = groupBy.map((column) => row[column] ?? null);
    const key = JSON.stringify(values);
    const group = groups.get(key) ?? { values, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  if (!groupBy.length && !groups.size) groups.set("[]", { values: [], rows: [] });
  return {
    columns: [...groupBy, ...labels],
    rows: [...groups.values()].map((group) => {
      const result: Record<string, TableValue> = Object.fromEntries(groupBy.map((column, index) => [column, group.values[index] ?? null]));
      metrics.forEach((metric, index) => {
        const values = group.rows.map((row) => row[metric.column]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        const nonNull = group.rows.filter((row) => row[metric.column] !== null && row[metric.column] !== undefined).length;
        if (metric.operation === "count") result[labels[index]!] = nonNull;
        else if (metric.operation === "sum") result[labels[index]!] = values.reduce((total, value) => total + value, 0);
        else if (!values.length) result[labels[index]!] = null;
        else if (metric.operation === "average") result[labels[index]!] = values.reduce((total, value) => total + value, 0) / values.length;
        else if (metric.operation === "min") result[labels[index]!] = Math.min(...values);
        else result[labels[index]!] = Math.max(...values);
      });
      return result;
    })
  };
}
function normalize(value: unknown): TableValue { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null; }
