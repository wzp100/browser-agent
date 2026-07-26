import type { AppLogRecord, AppLogSink } from "../../logging/src/index";
import { BROWSER_AGENT_LOG_DIRECTORY, type ProjectFileEntry, type ProjectFileService } from "./project-file-service";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = 7;
const SELF_LOG_SCOPE = "workspace.files";

export interface ProjectFileLogSinkOptions {
  maxFileBytes?: number;
  retentionDays?: number;
  now?: () => Date;
}

type ProjectLogFileService = Pick<ProjectFileService, "ensureDirectory" | "exists" | "list" | "delete">
  & Partial<Pick<ProjectFileService, "appendInternalText" | "readText" | "writeText">>;

/**
 * 将已脱敏的 AppLogRecord 以 UTF-8 JSONL 保存到项目目录。
 * workspace.files 由 sink 自身的文件操作产生，必须排除以避免递归写日志。
 */
export class ProjectFileLogSink implements AppLogSink {
  private readonly encoder = new TextEncoder();
  private readonly maxFileBytes: number;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private queue: Promise<void> = Promise.resolve();
  private cleanedDate: string | undefined;

  constructor(private readonly files: ProjectLogFileService, options: ProjectFileLogSinkOptions = {}) {
    this.maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.retentionDays = positiveInteger(options.retentionDays, DEFAULT_RETENTION_DAYS);
    this.now = options.now ?? (() => new Date());
  }

  write(record: AppLogRecord): Promise<void> {
    if (record.scope === SELF_LOG_SCOPE) return Promise.resolve();
    const operation = this.queue.then(() => this.writeNow(record));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async writeNow(record: AppLogRecord): Promise<void> {
    await this.files.ensureDirectory(BROWSER_AGENT_LOG_DIRECTORY);
    const now = this.now();
    const date = utcDate(now);
    if (this.cleanedDate !== date) {
      await this.removeExpiredLogs(now);
      this.cleanedDate = date;
    }

    const entries = await this.files.list(BROWSER_AGENT_LOG_DIRECTORY);
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = this.encoder.encode(line).byteLength;
    const filesForDate = entries
      .filter((entry) => entry.kind === "file")
      .map((entry) => ({ entry, sequence: logSequence(entry.path, date) }))
      .filter((item): item is { entry: ProjectFileEntry; sequence: number } => item.sequence !== undefined)
      .sort((left, right) => left.sequence - right.sequence);
    const latest = filesForDate.at(-1);
    const sequence = latest && (latest.entry.size ?? 0) + lineBytes <= this.maxFileBytes ? latest.sequence : (latest?.sequence ?? 0) + 1;
    const path = `${BROWSER_AGENT_LOG_DIRECTORY}/${date}.${sequence}.jsonl`;
    if (this.files.appendInternalText) await this.files.appendInternalText(path, line);
    else {
      if (!this.files.readText || !this.files.writeText) throw new Error("项目文件服务不支持追加或文本写入。 ");
      const previous = await this.files.exists(path) ? (await this.files.readText(path)).content : "";
      await this.files.writeText(path, `${previous}${line}`, { source: "agent" });
    }
  }

  private async removeExpiredLogs(now: Date): Promise<void> {
    const cutoff = utcDayNumber(now) - (this.retentionDays - 1);
    for (const entry of await this.files.list(BROWSER_AGENT_LOG_DIRECTORY)) {
      if (entry.kind !== "file") continue;
      const match = /\/(\d{4}-\d{2}-\d{2})\.\d+\.jsonl$/.exec(entry.path);
      if (!match?.[1]) continue;
      const day = parseUtcDay(match[1]);
      if (day !== undefined && day < cutoff) await this.files.delete(entry.path, "agent");
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function utcDate(date: Date): string { return date.toISOString().slice(0, 10); }
function utcDayNumber(date: Date): number { return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000); }
function parseUtcDay(value: string): number | undefined {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return undefined;
  return Math.floor(timestamp / 86_400_000);
}
function logSequence(path: string, date: string): number | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d+)\.jsonl$/.exec(name);
  if (match?.[1] !== date || !match[2]) return undefined;
  const sequence = Number(match[2]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}
