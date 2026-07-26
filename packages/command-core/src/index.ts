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
  inputSchema: JsonSchema;
  execute(argumentsValue: Record<string, unknown>, context?: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  signal?: AbortSignal;
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

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();
  constructor(private readonly options: AgentToolRegistryOptions = {}) {}
  register(tool: AgentToolDefinition): void {
    if (this.tools.has(tool.id)) throw new Error(`工具已注册：${tool.id}`);
    this.tools.set(tool.id, tool);
  }
  list(): AgentToolDefinition[] { return [...this.tools.values()].filter((tool) => this.options.visible?.(tool) ?? true); }
  async execute(id: string, argumentsValue: Record<string, unknown>, context: ToolExecutionContext = {}): Promise<unknown> {
    context.signal?.throwIfAborted();
    const tool = this.tools.get(id);
    if (!tool) throw new Error(`Agent 请求了不存在的工具：${id}`);
    if (!(this.options.visible?.(tool) ?? true)) throw new Error(`当前权限模式不允许使用工具：${id}`);
    await this.options.authorize?.({ tool, argumentsValue });
    context.signal?.throwIfAborted();
    return tool.execute(argumentsValue, context);
  }
}
