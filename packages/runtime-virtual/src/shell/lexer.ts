import { ShellSyntaxError, type ShellToken, type ShellWordPart } from "./ast";

const OPERATORS = ["2>&1", "2>>", "&&", "||", ">>", "2>", ";", "|", "<", ">"] as const;

export function lexShell(source: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let index = 0;
  let parts: ShellWordPart[] = [];
  let wordOffset = 0;
  let wordStarted = false;

  const beginWord = () => { if (!wordStarted) { wordStarted = true; wordOffset = index; } };
  const literal = (value: string, quoted: boolean) => {
    beginWord();
    const previous = parts.at(-1);
    if (previous?.kind === "literal" && previous.quoted === quoted) previous.value += value;
    else parts.push({ kind: "literal", value, quoted });
  };
  const flush = () => {
    if (!wordStarted) return;
    tokens.push({ kind: "word", word: { parts }, offset: wordOffset });
    parts = [];
    wordStarted = false;
  };

  while (index < source.length) {
    const character = source[index]!;
    if (character === " " || character === "\t" || character === "\r") { flush(); index += 1; continue; }
    if (character === "\n") { flush(); tokens.push({ kind: "operator", value: ";", offset: index }); index += 1; continue; }
    if (character === "#" && !wordStarted) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      flush();
      tokens.push({ kind: "operator", value: operator, offset: index });
      index += operator.length;
      continue;
    }
    if (character === "'") {
      beginWord();
      const start = index++;
      let value = "";
      while (index < source.length && source[index] !== "'") value += source[index++]!;
      if (source[index] !== "'") throw new ShellSyntaxError("单引号没有闭合", start);
      index += 1;
      literal(value, true);
      continue;
    }
    if (character === '"') {
      beginWord();
      const start = index++;
      let buffer = "";
      const flushBuffer = () => { if (buffer) { literal(buffer, true); buffer = ""; } };
      while (index < source.length && source[index] !== '"') {
        const current = source[index]!;
        if (current === "\\") {
          const next = source[index + 1];
          if (next === undefined) throw new ShellSyntaxError("反斜杠后缺少字符", index);
          if ('"\\$'.includes(next)) { buffer += next; index += 2; continue; }
          buffer += current; index += 1; continue;
        }
        if (current === "$") {
          flushBuffer();
          index = readVariable(source, index, parts, true);
          continue;
        }
        buffer += current;
        index += 1;
      }
      if (source[index] !== '"') throw new ShellSyntaxError("双引号没有闭合", start);
      flushBuffer();
      index += 1;
      continue;
    }
    if (character === "\\") {
      const next = source[index + 1];
      if (next === undefined) throw new ShellSyntaxError("反斜杠后缺少字符", index);
      literal(next, true);
      index += 2;
      continue;
    }
    if (character === "$") {
      beginWord();
      index = readVariable(source, index, parts, false);
      continue;
    }
    literal(character, false);
    index += 1;
  }
  flush();
  return collapseSeparators(tokens);
}

function readVariable(source: string, offset: number, parts: ShellWordPart[], quoted: boolean): number {
  const next = source[offset + 1];
  if (next === "?") { parts.push({ kind: "status", value: "?", quoted }); return offset + 2; }
  if (next === "{") {
    const end = source.indexOf("}", offset + 2);
    if (end < 0) throw new ShellSyntaxError("变量表达式没有闭合", offset);
    const name = source.slice(offset + 2, end);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ShellSyntaxError("变量名称无效", offset);
    parts.push({ kind: "variable", value: name, quoted });
    return end + 1;
  }
  const match = source.slice(offset + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (!match) {
    const previous = parts.at(-1);
    if (previous?.kind === "literal" && previous.quoted === quoted) previous.value += "$";
    else parts.push({ kind: "literal", value: "$", quoted });
    return offset + 1;
  }
  parts.push({ kind: "variable", value: match[0], quoted });
  return offset + 1 + match[0].length;
}

function collapseSeparators(tokens: ShellToken[]): ShellToken[] {
  const collapsed: ShellToken[] = [];
  for (const token of tokens) {
    if (token.kind === "operator" && token.value === ";" && collapsed.at(-1)?.kind === "operator" && (collapsed.at(-1) as { value?: string }).value === ";") continue;
    collapsed.push(token);
  }
  return collapsed;
}
