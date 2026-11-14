import type { Node } from "web-tree-sitter";
import type { SymbolInfo } from "../types.ts";

const BLOCK_LABELS: Record<string, string> = {
  section: "section",
  stack: "stack",
  once: "once",
  php_statement: "php",
};

const SKIPPED_TYPES = new Set([
  "attribute",
  "quoted_attribute_value",
  "attribute_value",
  "start_tag",
  "end_tag",
  "self_closing_tag",
  "erroneous_end_tag",
  "parameter",
]);

function textOf(node: Node, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

function rangeOf(node: Node): [number, number] {
  return [node.startPosition.row + 1, node.endPosition.row + 1];
}

function findChild(node: Node, type: string): Node | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === type) return child;
  }
  return undefined;
}

function unquote(text: string): string | undefined {
  const trimmed = text.trim();
  const quoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')));
  return quoted ? trimmed.slice(1, -1) : undefined;
}

function parameterName(node: Node, source: string): string {
  const parameter = findChild(node, "parameter");
  if (parameter === undefined) return "";
  const raw = textOf(parameter, source);
  return unquote(raw) ?? raw.trim();
}

function bodyStart(node: Node): number {
  const children = node.namedChildren;
  let index = 0;
  const first = children[index];
  if (first !== null && first !== undefined && (first.type === "directive" || first.type === "directive_start")) {
    index += 1;
  }
  while (index < children.length && children[index]?.type === "parameter") index += 1;
  return index;
}

function blockSymbol(node: Node, source: string): SymbolInfo | null {
  const directive = node.namedChildren[0];
  if (directive?.type === "directive_start" && (node.type === "conditional" || node.type === "loop")) {
    const [startLine, endLine] = rangeOf(node);
    return { name: parameterName(node, source), type: textOf(directive, source).slice(1), startLine, endLine };
  }
  const label = BLOCK_LABELS[node.type];
  if (label === undefined || (node.type === "php_statement" && directive?.type !== "directive_start")) return null;
  const [startLine, endLine] = rangeOf(node);
  return { name: parameterName(node, source), type: label, startLine, endLine };
}

function directiveSymbol(node: Node, parameter: Node | null, source: string): SymbolInfo | null {
  if (parameter === null || parameter.type !== "parameter") return null;
  const label = textOf(node, source).replace(/^@/, "");
  if (label.length === 0) return null;
  const [startLine, endLine] = rangeOf(node);
  const raw = textOf(parameter, source);
  const quoted = unquote(raw);
  return quoted === undefined
    ? { name: "", type: label, startLine, endLine }
    : { name: quoted, type: label, startLine, endLine };
}

function componentSymbol(node: Node, source: string): SymbolInfo | null {
  const tag = findChild(node, "start_tag") ?? findChild(node, "self_closing_tag");
  if (tag === undefined) return null;
  const tagName = findChild(tag, "tag_name");
  if (tagName === undefined) return null;
  const name = textOf(tagName, source);
  const [startLine, endLine] = rangeOf(node);
  if (name.startsWith("x-")) return { name, type: "component", startLine, endLine };
  if (name.startsWith("livewire:")) {
    return { name: name.slice("livewire:".length), type: "livewire", startLine, endLine };
  }
  return null;
}

function collect(node: Node, source: string, depth: number, maxDepth: number, sink: SymbolInfo[], start = 0): void {
  if (SKIPPED_TYPES.has(node.type)) return;
  const children = node.namedChildren;
  for (let i = start; i < children.length; i++) {
    const child = children[i];
    if (child === null || child === undefined) continue;
    const block = blockSymbol(child, source);
    if (block !== null) {
      sink.push(block);
      if (depth < maxDepth) {
        const nested: SymbolInfo[] = [];
        collect(child, source, depth + 1, maxDepth, nested, bodyStart(child));
        if (nested.length > 0) block.children = nested;
      }
      continue;
    }
    if (child.type === "directive") {
      const symbol = directiveSymbol(child, children[i + 1] ?? null, source);
      if (symbol !== null) sink.push(symbol);
      continue;
    }
    if (child.type === "element") {
      const symbol = componentSymbol(child, source);
      if (symbol !== null) {
        sink.push(symbol);
        if (depth < maxDepth) {
          const nested: SymbolInfo[] = [];
          collect(child, source, depth + 1, maxDepth, nested);
          if (nested.length > 0) symbol.children = nested;
        }
        continue;
      }
    }
    collect(child, source, depth, maxDepth, sink);
  }
}

export function extractBlade(node: Node, source: string, depth: number): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  collect(node, source, depth, depth + 10, results);
  return results;
}
