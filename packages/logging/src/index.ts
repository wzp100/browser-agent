import loglevel, { type Logger } from "loglevel";

export type AppLogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type LogContext = Record<string, unknown>;

export interface AppLogRecord {
  id: string;
  timestamp: string;
  level: AppLogLevel;
  scope: string;
  message: string;
  context?: Record<string, unknown>;
  errorName?: string;
  errorMessage?: string;
  errorCode?: string;
  stack?: string;
  errorCause?: SerializedError | string;
}

export interface SerializedError {
  name?: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: SerializedError | string;
}

export interface AppLogSink {
  write(record: AppLogRecord): Promise<void>;
}

export interface LoggingConfiguration {
  sink?: AppLogSink;
  level?: AppLogLevel;
  /** 关闭后不再持久化日志，并把控制台最低级别提升为 warn。 */
  enabled?: boolean;
}

/** 将多个持久化目标组合为一个 sink；单个目标失败不会阻止其他目标写入。 */
export class CompositeLogSink implements AppLogSink {
  constructor(readonly sinks: readonly AppLogSink[]) {}

  async write(record: AppLogRecord): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map((sink) => sink.write(record)));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, `${errors.length} 个诊断日志目标写入失败。`);
  }
}

/** 允许设置页即时开关某一个日志目标，而不需要重建其底层资源。 */
export class EnabledLogSink implements AppLogSink {
  constructor(readonly sink: AppLogSink, private active = true) {}

  get enabled(): boolean { return this.active; }
  setEnabled(enabled: boolean): void { this.active = enabled; }
  async write(record: AppLogRecord): Promise<void> { if (this.active) await this.sink.write(record); }
}

export function composeLogSinks(...sinks: Array<AppLogSink | undefined | false>): AppLogSink | undefined {
  const available = sinks.filter((sink): sink is AppLogSink => Boolean(sink));
  if (!available.length) return undefined;
  return available.length === 1 ? available[0] : new CompositeLogSink(available);
}

const LEVEL_ORDER: Record<AppLogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const REDACTED_KEYS = /(?:api[-_]?key|authorization|password|passwd|secret|token|cookie)/i;
const MAX_EARLY_RECORDS = 300;
const MAX_CONTEXT_DEPTH = 5;
const MAX_STRING_LENGTH = 2_000;
const SECRET_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\b(?:api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|token|password|passwd|secret)\s*[:=]\s*["']?[^\s,"'}]{6,}/gi,
  /([?&](?:key|api[-_]?key|access[-_]?token|token|secret)=)[^&#\s]+/gi
];

let currentLevel: AppLogLevel = "info";
let currentSink: AppLogSink | undefined;
let writeQueue: Promise<void> = Promise.resolve();
const earlyRecords: AppLogRecord[] = [];
const namedLoggers = new Map<string, Logger>();

export class AppLogger {
  constructor(readonly scope: string) {}

  trace(message: string, context?: LogContext): void { emit("trace", this.scope, message, context); }
  debug(message: string, context?: LogContext): void { emit("debug", this.scope, message, context); }
  info(message: string, context?: LogContext): void { emit("info", this.scope, message, context); }
  warn(message: string, context?: LogContext, error?: unknown): void { emit("warn", this.scope, message, context, error); }
  error(message: string, context?: LogContext, error?: unknown): void { emit("error", this.scope, message, context, error); }
}

export function logger(scope: string): AppLogger { return new AppLogger(scope); }

export function configureLogging(configuration: LoggingConfiguration): void {
  if (configuration.enabled === false) {
    currentSink = undefined;
    earlyRecords.splice(0);
    setLogLevel("warn");
    return;
  }
  if (configuration.level) setLogLevel(configuration.level);
  if (!configuration.sink) return;
  currentSink = configuration.sink;
  const pending = earlyRecords.splice(0);
  for (const record of pending) enqueue(record);
}

export function setLogLevel(level: AppLogLevel): void {
  currentLevel = level;
  loglevel.setLevel(level, false);
  for (const value of namedLoggers.values()) value.setLevel(level, false);
}

export function getLogLevel(): AppLogLevel { return currentLevel; }

export async function flushLogs(): Promise<void> { await writeQueue; }

export function installGlobalErrorLogging(): void {
  if (typeof window === "undefined") return;
  const target = window as Window & { __agentCodexGlobalLoggingInstalled?: boolean };
  if (target.__agentCodexGlobalLoggingInstalled) return;
  target.__agentCodexGlobalLoggingInstalled = true;
  const globalLogger = logger("browser.global");
  window.addEventListener("error", (event) => {
    globalLogger.error("未捕获的浏览器错误", {
      filename: event.filename,
      line: event.lineno,
      column: event.colno
    }, event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    globalLogger.error("未处理的 Promise 拒绝", undefined, event.reason);
  });
}

export function sanitizeLogValue(value: unknown): unknown {
  return sanitize(value, 0, new WeakSet<object>());
}

export function sanitizeLogText(value: string): string {
  let sanitized = truncate(value);
  for (const pattern of SECRET_TEXT_PATTERNS) {
    sanitized = sanitized.replace(pattern, (_match, prefix?: unknown) => typeof prefix === "string" && (prefix.startsWith("?") || prefix.startsWith("&")) ? `${prefix}[已隐藏]` : "[已隐藏]");
  }
  return sanitized;
}

function emit(level: AppLogLevel, scope: string, message: string, context?: LogContext, error?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const details = errorDetails(error);
  const cleanContext = context ? sanitizeLogValue(context) as Record<string, unknown> : undefined;
  const record: AppLogRecord = {
    id: randomId(),
    timestamp: new Date().toISOString(),
    level,
    scope,
    message: sanitizeLogText(message)
  };
  if (cleanContext && Object.keys(cleanContext).length) record.context = cleanContext;
  if (details.name) record.errorName = details.name;
  if (details.message) record.errorMessage = details.message;
  if (details.code) record.errorCode = details.code;
  if (details.stack) record.stack = details.stack;
  if (details.cause) record.errorCause = details.cause;

  const nativeLogger = getNativeLogger(scope);
  const consoleArguments: unknown[] = [`${record.timestamp} [${level.toUpperCase()}] [${scope}] ${record.message}`];
  if (record.context) consoleArguments.push(record.context);
  if (record.stack) consoleArguments.push(record.stack);
  nativeLogger[level](...consoleArguments);

  if (currentSink) enqueue(record);
  else {
    earlyRecords.push(record);
    if (earlyRecords.length > MAX_EARLY_RECORDS) earlyRecords.shift();
  }
}

function enqueue(record: AppLogRecord): void {
  const sink = currentSink;
  if (!sink) return;
  writeQueue = writeQueue.then(() => sink.write(record)).catch((error) => {
    console.error(`${new Date().toISOString()} [ERROR] [logging] 写入诊断日志失败`, error);
  });
}

function getNativeLogger(scope: string): Logger {
  let value = namedLoggers.get(scope);
  if (!value) {
    value = loglevel.getLogger(scope);
    value.setLevel(currentLevel, false);
    namedLoggers.set(scope, value);
  }
  return value;
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeLogText(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") return String(value);
  if (value instanceof Error) return { name: value.name, message: sanitizeLogText(value.message), stack: sanitizeLogText(value.stack ?? "") };
  if (depth >= MAX_CONTEXT_DEPTH) return "[超过日志深度限制]";
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    result[key] = REDACTED_KEYS.test(key) ? "[已隐藏]" : sanitize(item, depth + 1, seen);
  }
  return result;
}

export function serializeError(error: unknown): SerializedError {
  return serializeErrorValue(error, 0, new WeakSet<object>());
}

function errorDetails(error: unknown): Partial<SerializedError> {
  if (error === undefined || error === null) return {};
  return serializeError(error);
}

function serializeErrorValue(error: unknown, depth: number, seen: WeakSet<object>): SerializedError {
  if (typeof error === "string") return { message: sanitizeLogText(error) };
  if (error === null || error === undefined || typeof error !== "object") return { message: sanitizeLogText(String(error)) };
  if (seen.has(error)) return { message: "[循环引用]" };
  seen.add(error);

  const record = error as Record<string, unknown>;
  const name = stringValue(record.name);
  const code = stringValue(record.code);
  const stack = stringValue(record.stack);
  const directMessage = stringValue(record.message);
  const fallback = safeObjectMessage(error);
  const result: SerializedError = { message: sanitizeLogText(directMessage ?? fallback) };
  if (name) result.name = sanitizeLogText(name);
  if (code) result.code = sanitizeLogText(code);
  if (stack) result.stack = sanitizeLogText(stack);
  if (record.cause !== undefined) {
    result.cause = depth >= 3
      ? "[超过错误原因深度限制]"
      : typeof record.cause === "object" && record.cause !== null
        ? serializeErrorValue(record.cause, depth + 1, seen)
        : sanitizeLogText(String(record.cause));
  }
  return result;
}

function safeObjectMessage(value: object): string {
  try {
    const sanitized = sanitizeLogValue(value);
    const json = JSON.stringify(sanitized);
    if (json && json !== "{}") return json;
  } catch {
    // 有 getter 或代理对象抛错时仍提供稳定、非 [object Object] 的诊断。
  }
  const constructorName = value.constructor?.name;
  return constructorName && constructorName !== "Object" ? `[${constructorName}]` : "未知对象异常";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

function truncate(value: string): string { return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value; }
function randomId(): string { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
