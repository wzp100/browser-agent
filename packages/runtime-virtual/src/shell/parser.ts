import { ShellSyntaxError, type ShellCommandNode, type ShellConditionalNode, type ShellPipelineNode, type ShellProgram, type ShellRedirectOperator, type ShellToken } from "./ast";
import { lexShell } from "./lexer";

const REDIRECTS = new Set<ShellRedirectOperator>(["<", ">", ">>", "2>", "2>>", "2>&1"]);

export function parseShell(source: string): ShellProgram {
  const parser = new ShellParser(lexShell(source));
  return parser.parseProgram();
}

class ShellParser {
  private index = 0;
  constructor(private readonly tokens: ShellToken[]) {}

  parseProgram(): ShellProgram {
    const chains: ShellConditionalNode[] = [];
    this.skipSeparators();
    while (!this.done) {
      chains.push(this.parseConditional());
      if (this.done) break;
      if (!this.matchOperator(";")) throw this.error("命令之间缺少分隔符");
      this.skipSeparators();
    }
    return { chains };
  }

  private parseConditional(): ShellConditionalNode {
    const pipelines = [this.parsePipeline()];
    const operators: Array<"&&" | "||"> = [];
    while (this.peekOperator("&&") || this.peekOperator("||")) {
      const operator = this.take() as Extract<ShellToken, { kind: "operator" }>;
      operators.push(operator.value as "&&" | "||");
      pipelines.push(this.parsePipeline());
    }
    return { pipelines, operators };
  }

  private parsePipeline(): ShellPipelineNode {
    const commands = [this.parseCommand()];
    while (this.matchOperator("|")) commands.push(this.parseCommand());
    return { commands };
  }

  private parseCommand(): ShellCommandNode {
    const words = [];
    const redirects: ShellCommandNode["redirects"] = [];
    while (!this.done) {
      const token = this.peek();
      if (token.kind === "word") { words.push(token.word); this.index += 1; continue; }
      if (!REDIRECTS.has(token.value as ShellRedirectOperator)) break;
      this.index += 1;
      const operator = token.value as ShellRedirectOperator;
      if (operator === "2>&1") { redirects.push({ operator }); continue; }
      const target = this.take();
      if (!target || target.kind !== "word") throw new ShellSyntaxError(`重定向 ${operator} 缺少目标文件`, token.offset);
      redirects.push({ operator, target: target.word });
    }
    if (!words.length && !redirects.length) throw this.error("缺少命令");
    return { words, redirects };
  }

  private skipSeparators(): void { while (this.matchOperator(";")) { /* skip */ } }
  private matchOperator(value: string): boolean { if (!this.peekOperator(value)) return false; this.index += 1; return true; }
  private peekOperator(value: string): boolean { const token = this.peekOptional(); return token?.kind === "operator" && token.value === value; }
  private peek(): ShellToken { const token = this.peekOptional(); if (!token) throw this.error("命令意外结束"); return token; }
  private peekOptional(): ShellToken | undefined { return this.tokens[this.index]; }
  private take(): ShellToken { const token = this.peek(); this.index += 1; return token; }
  private get done(): boolean { return this.index >= this.tokens.length; }
  private error(message: string): ShellSyntaxError { return new ShellSyntaxError(message, this.peekOptional()?.offset ?? this.tokens.at(-1)?.offset ?? 0); }
}
