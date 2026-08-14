export type ShellOperator = ";" | "&&" | "||" | "|";
export type ShellRedirectOperator = "<" | ">" | ">>" | "2>" | "2>>" | "2>&1";

export interface ShellWordPart {
  kind: "literal" | "variable" | "status";
  value: string;
  quoted: boolean;
}

export interface ShellWord {
  parts: ShellWordPart[];
}

export interface ShellRedirection {
  operator: ShellRedirectOperator;
  target?: ShellWord;
}

export interface ShellCommandNode {
  words: ShellWord[];
  redirects: ShellRedirection[];
}

export interface ShellPipelineNode { commands: ShellCommandNode[]; }

export interface ShellConditionalNode {
  pipelines: ShellPipelineNode[];
  operators: Array<"&&" | "||">;
}

export interface ShellProgram { chains: ShellConditionalNode[]; }

export type ShellToken =
  | { kind: "word"; word: ShellWord; offset: number }
  | { kind: "operator"; value: ShellOperator | ShellRedirectOperator; offset: number };

export class ShellSyntaxError extends Error {
  readonly code = "SHELL_PARSE";
  constructor(message: string, readonly offset: number) {
    super(`${message}（位置 ${offset}）`);
    this.name = "ShellSyntaxError";
  }
}
