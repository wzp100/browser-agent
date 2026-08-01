export interface JsonSchemaValue {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaValue>;
  required?: string[];
  items?: JsonSchemaValue;
  enum?: unknown[];
  oneOf?: JsonSchemaValue[];
  additionalProperties?: boolean;
}

export interface JsonSchema {
  type: "object";
  properties?: Record<string, JsonSchemaValue>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface AgentToolDefinition {
  id: string;
  description: string;
  effect: "context" | "read" | "write" | "execute";
  scope: "conversation" | "workspace" | "runtime" | "skill" | "network";
  concurrency?: "parallel" | "sequential";
  inputSchema: JsonSchema;
  execute(argumentsValue: Record<string, unknown>, context?: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
}

export class ToolAuthorizationError extends Error {
  readonly origin = "permission" as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolAuthorizationError";
  }
}

export interface ToolAuthorizationRequest {
  tool: AgentToolDefinition;
  argumentsValue: Record<string, unknown>;
}

export type ToolAuthorizationHook = (request: ToolAuthorizationRequest) => Promise<void>;

export interface AgentToolRegistryOptions {
  authorize?: ToolAuthorizationHook;
  visible?: (tool: AgentToolDefinition) => boolean;
}

export interface PreparedToolCall {
  tool: AgentToolDefinition;
  argumentsValue: Record<string, unknown>;
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();
  constructor(private readonly options: AgentToolRegistryOptions = {}) {}
  register(tool: AgentToolDefinition): void {
    if (this.tools.has(tool.id)) throw new Error(`工具已注册：${tool.id}`);
    this.tools.set(tool.id, {
      ...tool,
      concurrency: tool.concurrency ?? (tool.scope !== "network" && (tool.effect === "read" || tool.effect === "context") ? "parallel" : "sequential")
    });
  }
  list(): AgentToolDefinition[] { return [...this.tools.values()].filter((tool) => this.options.visible?.(tool) ?? true); }
  async prepare(id: string, argumentsValue: Record<string, unknown>, context: ToolExecutionContext = {}): Promise<PreparedToolCall> {
    context.signal?.throwIfAborted();
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`Agent 请求了不存在的工具：${id}`);
    if (!(this.options.visible?.(tool) ?? true)) throw new Error(`当前权限模式不允许使用工具：${id}`);
    validateToolArguments(tool.inputSchema, argumentsValue);
    try {
      await this.options.authorize?.({ tool, argumentsValue });
    } catch (error) {
      if (error instanceof ToolAuthorizationError) throw error;
      throw new ToolAuthorizationError(error instanceof Error ? error.message : String(error), { cause: error });
    }
    context.signal?.throwIfAborted();
    return { tool, argumentsValue };
  }
  async executePrepared(prepared: PreparedToolCall, context: ToolExecutionContext = {}): Promise<unknown> {
    context.signal?.throwIfAborted();
    return prepared.tool.execute(prepared.argumentsValue, context);
  }
  async execute(id: string, argumentsValue: Record<string, unknown>, context: ToolExecutionContext = {}): Promise<unknown> {
    return this.executePrepared(await this.prepare(id, argumentsValue, context), context);
  }
}

export function validateToolArguments(schema: JsonSchema, argumentsValue: Record<string, unknown>): void {
  validateSchemaValue(schema, argumentsValue, "参数");
}

function validateSchemaValue(schema: JsonSchemaValue, value: unknown, path: string): void {
  if (schema.oneOf?.length) {
    const matches = schema.oneOf.filter((candidate) => {
      try { validateSchemaValue(candidate, value, path); return true; } catch { return false; }
    });
    if (matches.length !== 1) throw new Error(`${path} 必须且只能匹配 oneOf 中的一种结构。`);
  }
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) throw new Error(`${path} 不在允许的枚举值中。`);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some((type) => matchesJsonType(type, value))) throw new Error(`${path} 类型无效，预期 ${types.join(" 或 ")}。`);
  if (value && typeof value === "object" && !Array.isArray(value) && (schema.properties || schema.required || schema.additionalProperties === false)) {
    const record = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!(required in record)) throw new Error(`缺少工具参数：${required}`);
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      const unknown = Object.keys(record).find((key) => !known.has(key));
      if (unknown) throw new Error(`工具参数不允许额外字段：${unknown}`);
    }
    for (const [key, child] of Object.entries(record)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) validateSchemaValue(childSchema, child, `${path}.${key}`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => validateSchemaValue(schema.items!, item, `${path}[${index}]`));
}

function matchesJsonType(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}
