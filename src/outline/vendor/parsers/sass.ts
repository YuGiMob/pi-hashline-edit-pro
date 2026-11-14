/**
 * Sass (indented syntax) tree-sitter symbol extractor.
 *
 * Tree-sitter grammar: bajrangCoder/tree-sitter-sass
 * (https://github.com/bajrangCoder/tree-sitter-sass), MIT license.
 * This is the tree-sitter grammar for the indented `.sass` dialect (whitespace-
 * significant, no braces/semicolons). The grammar is not published on npm and
 * ships no prebuilt WASM, so the repo vendors a compiled tree-sitter-sass.wasm
 * under src/parsers/vendor/.
 *
 * Grammar node shapes:
 *  - `$var: value` parses as a `declaration` with a `variable_name` child;
 *    regular CSS properties parse as `declaration` with `property_name`.
 *  - `@mixin name(params)` / `@function name(params)` use a `name` child.
 *  - `@include name(...)` uses a `mixin_name` child.
 *  - `@use`/`@forward`/`@import` hold the module path in a `string_value`.
 */

import type { Node } from "web-tree-sitter";
import type { SymbolInfo, ImportInfo } from "../types.ts";

/**
 * Extract structural symbols from Sass (indented syntax) source code.
 */
export function extractSass(
  node: Node,
  source: string,
  depth: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const MAX_DEPTH = depth + 10;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    const symbol = extractSassChild(child, source, depth, MAX_DEPTH);
    if (symbol) results.push(symbol);
  }

  return results;
}

function extractSassChild(
  child: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
): SymbolInfo | null {
  switch (child.type) {
    case "rule_set":
      return extractRuleSet(child, source, depth, MAX_DEPTH);
    case "mixin_statement":
      return extractNamedBlock(
        child,
        source,
        depth,
        MAX_DEPTH,
        "mixin",
      );
    case "function_statement":
      return extractNamedBlock(
        child,
        source,
        depth,
        MAX_DEPTH,
        "function",
      );
    case "media_statement":
      return extractAtBlock(child, source, depth, MAX_DEPTH, extractMediaName);
    case "keyframes_statement":
      return extractKeyframes(child, source, depth, MAX_DEPTH);
    case "declaration": {
      // `$var: value` at top level parses as a declaration with variable_name.
      const varName = childTextOfType(child, source, "variable_name");
      if (varName && varName.startsWith("$")) {
        return {
          name: varName,
          type: "variable",
          startLine: child.startPosition.row + 1,
          endLine: endLineOf(child, source),
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function extractNamedBlock(
  child: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
  label: string,
): SymbolInfo | null {
  let name = "<unknown>";

  for (let i = 0; i < child.namedChildCount; i++) {
    const c = child.namedChild(i);
    if (!c) continue;
    if (c.type === "name") {
      name = source.slice(c.startIndex, c.endIndex);
    }
  }

  const [sl, el] = [child.startPosition.row + 1, endLineOf(child, source)];
  const symbol: SymbolInfo = {
    name,
    type: label,
    startLine: sl,
    endLine: el,
  };

  if (depth < MAX_DEPTH) {
    const block = findChildByType(child, ["block"]);
    if (block) {
      const children = extractBlockChildren(block, source, depth + 1, MAX_DEPTH);
      if (children.length > 0) symbol.children = children;
    }
  }

  return symbol;
}

function extractRuleSet(
  child: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
): SymbolInfo | null {
  const selectors = findChildByType(child, ["selectors"]);
  const name = selectors
    ? source.slice(selectors.startIndex, selectors.endIndex).trim()
    : "<unknown>";

  const [sl, el] = [child.startPosition.row + 1, endLineOf(child, source)];
  const symbol: SymbolInfo = {
    name,
    // `%placeholder` selectors get their own type.
    type: name.startsWith("%") ? "placeholder" : "ruleset",
    startLine: sl,
    endLine: el,
  };

  if (depth < MAX_DEPTH) {
    const block = findChildByType(child, ["block"]);
    if (block) {
      const children = extractBlockChildren(block, source, depth + 1, MAX_DEPTH);
      if (children.length > 0) symbol.children = children;
    }
  }

  return symbol;
}

function extractAtBlock(
  child: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
  nameOf: (node: Node, source: string) => string,
): SymbolInfo | null {
  const name = nameOf(child, source);
  const [sl, el] = [child.startPosition.row + 1, endLineOf(child, source)];
  const symbol: SymbolInfo = {
    name,
    type: "at-rule",
    startLine: sl,
    endLine: el,
  };

  if (depth < MAX_DEPTH) {
    const block = findChildByType(child, ["block"]);
    if (block) {
      const children = extractBlockChildren(block, source, depth + 1, MAX_DEPTH);
      if (children.length > 0) symbol.children = children;
    }
  }

  return symbol;
}

function extractMediaName(node: Node, source: string): string {
  const start = source.slice(node.startIndex, node.endIndex).trim();
  const newline = start.indexOf("\n");
  return newline >= 0 ? start.slice(0, newline).trim() : start;
}

function extractKeyframes(
  child: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
): SymbolInfo | null {
  let name = "<unknown>";
  const nameNode = findChildByType(child, ["keyframes_name"]);
  if (nameNode) name = source.slice(nameNode.startIndex, nameNode.endIndex);

  const [sl, el] = [child.startPosition.row + 1, endLineOf(child, source)];
  const symbol: SymbolInfo = {
    name: `@keyframes ${name}`,
    type: "keyframes",
    startLine: sl,
    endLine: el,
  };

  if (depth < MAX_DEPTH) {
    const block = findChildByType(child, ["block"]);
    if (block) {
      const children: SymbolInfo[] = [];
      for (let i = 0; i < block.namedChildCount; i++) {
        const kb = block.namedChild(i);
        if (!kb) continue;
        if (kb.type === "keyframe_block") {
          const stepText = source
            .slice(kb.startIndex, kb.endIndex)
            .split("\n")[0]
            .trim();
          children.push({
            name: stepText,
            type: "keyframe",
            startLine: kb.startPosition.row + 1,
            endLine: endLineOf(kb, source),
          });
        }
      }
      if (children.length > 0) symbol.children = children;
    }
  }

  return symbol;
}

function extractBlockChildren(
  block: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];

  for (let i = 0; i < block.namedChildCount; i++) {
    const child = block.namedChild(i);
    if (!child) continue;

    switch (child.type) {
      case "rule_set":
      case "media_statement":
      case "keyframes_statement":
      case "mixin_statement":
      case "function_statement": {
        const inner = extractSassChild(child, source, depth, MAX_DEPTH);
        if (inner) results.push(inner);
        break;
      }
      case "include_statement": {
        const inc = extractInclude(child, source);
        if (inc) results.push(inc);
        break;
      }
      case "extend_statement": {
        const ext = extractExtend(child, source);
        if (ext) results.push(ext);
        break;
      }
      case "declaration": {
        // `$var: value` inside a block surfaces as a variable.
        const varName = childTextOfType(child, source, "variable_name");
        if (varName && varName.startsWith("$")) {
          results.push({
            name: varName,
            type: "variable",
            startLine: child.startPosition.row + 1,
            endLine: endLineOf(child, source),
          });
        }
        break;
      }
    }
  }

  return results;
}

function extractInclude(child: Node, source: string): SymbolInfo | null {
  let name: string | undefined;

  for (let i = 0; i < child.namedChildCount; i++) {
    const c = child.namedChild(i);
    if (!c) continue;
    if (c.type === "mixin_name") {
      name = source.slice(c.startIndex, c.endIndex);
    }
  }
  if (!name) return null;

  return {
    name: `@include ${name}`,
    type: "include",
    startLine: child.startPosition.row + 1,
    endLine: endLineOf(child, source),
  };
}

function extractExtend(child: Node, source: string): SymbolInfo | null {
  let target: string | undefined;
  for (let i = 0; i < child.namedChildCount; i++) {
    const c = child.namedChild(i);
    if (!c) continue;
    if (
      c.type === "placeholder_selector" ||
      c.type === "class_selector" ||
      c.type === "id_selector" ||
      c.type === "identifier"
    ) {
      target = source.slice(c.startIndex, c.endIndex);
      break;
    }
  }
  if (!target) return null;

  return {
    name: `@extend ${target}`,
    type: "extend",
    startLine: child.startPosition.row + 1,
    endLine: endLineOf(child, source),
  };
}

// ---- Sass imports ----

/**
 * Extract Sass imports: `@use`, `@forward`, and `@import` statements
 * (indented syntax, but the directives use the same module-path strings).
 */
export function extractSassImports(
  node: Node,
  source: string,
): ImportInfo[] {
  const results: ImportInfo[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    let kind: string | null = null;
    if (child.type === "use_statement") kind = "use";
    else if (child.type === "forward_statement") kind = "forward";
    else if (child.type === "import_statement") kind = "import";
    else continue;

    const path = valueStringOf(child, source);
    if (!path) continue;

    results.push({
      source: path,
      names: [path],
      lineNumber: child.startPosition.row + 1,
    });
  }

  return results;
}

function valueStringOf(node: Node, source: string): string | undefined {
  // Direct string_value child first.
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === "string_value") {
      return stripQuotes(source.slice(c.startIndex, c.endIndex));
    }
  }
  return undefined;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

// ---- Shared helpers ----

/** The indented grammar includes trailing whitespace and sometimes the next line's indent. */
function endLineOf(node: Node, source: string): number {
  const text = source.slice(node.startIndex, node.endIndex).trimEnd();
  return node.startPosition.row + 1 + (text.match(/\n/g)?.length ?? 0);
}

function findChildByType(node: Node, types: string[]): Node | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && types.includes(c.type)) return c;
  }
  return null;
}

/** Return the text of the first named child of a given type. */
function childTextOfType(
  node: Node,
  source: string,
  type: string,
): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) {
      return source.slice(c.startIndex, c.endIndex);
    }
  }
  return undefined;
}
