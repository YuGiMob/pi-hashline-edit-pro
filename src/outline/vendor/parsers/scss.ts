/**
 * SCSS tree-sitter symbol extractor.
 *
 * Tree-sitter grammar: tree-sitter-scss (https://github.com/tree-sitter-grammars/tree-sitter-scss)
 * The grammar extends tree-sitter-css with SCSS-specific constructs: variables,
 * mixins, functions, @use/@forward/@import, @include, @extend, interpolation,
 * and nesting.
 *
 * The npm package (tree-sitter-scss@1.0.0) does not ship a prebuilt WASM module,
 * so the repo vendors a compiled tree-sitter-scss.wasm under src/parsers/vendor/.
 *
 * Scope note: this grammar covers the SCSS bracket syntax (`.scss` files). The
 * indented `.sass` dialect uses a separate vendored grammar — see sass.ts.
 *
 * Notes on grammar behavior the extractor accounts for:
 *  - `$var: value;` parses as a `declaration` whose `property_name` starts with `$`.
 *  - `@use "x" as y;` and `@forward "x" as cfg-*;` produce ERROR subtrees, but the
 *    `string_value` with the module path is still present and recoverable.
 *  - `@extend %placeholder;` parses as an ERROR node containing a `placeholder`
 *    child; `@extend .class;` parses cleanly as `extend_statement`.
 */

import type { Node } from "web-tree-sitter";
import type { SymbolInfo, ImportInfo } from "../types.ts";

/**
 * Extract structural symbols from SCSS source code.
 */
export function extractScss(
  node: Node,
  source: string,
  depth: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const MAX_DEPTH = depth + 10;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    const symbol = extractScssChild(child, source, depth, MAX_DEPTH);
    if (symbol) results.push(symbol);
  }

  return results;
}

function extractScssChild(
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
        "identifier",
      );
    case "function_statement":
      return extractNamedBlock(
        child,
        source,
        depth,
        MAX_DEPTH,
        "function",
        "identifier",
      );
    case "media_statement":
      return extractAtBlock(
        child,
        source,
        depth,
        MAX_DEPTH,
        extractMediaName,
      );
    case "keyframes_statement":
      return extractKeyframes(child, source, depth, MAX_DEPTH);
    case "declaration": {
      // Top-level `$var: value;` parses as a declaration whose property_name
      // starts with `$`. Regular CSS declarations are structural noise and are
      // skipped here (they only matter inside rule bodies, where they are
      // filtered out of children anyway).
      const prop = childTextOfType(child, source, 0, "property_name");
      if (prop && prop.startsWith("$")) {
        return {
          name: prop,
          type: "variable",
          startLine: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Extract a named block construct (mixin / function):
 * `@mixin name(params) { ... }` or `@function name(params) { ... }`.
 */
function extractNamedBlock(
  child: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
  label: string,
  nameField: string,
): SymbolInfo | null {
  let name = "<unknown>";

  for (let i = 0; i < child.namedChildCount; i++) {
    const c = child.namedChild(i);
    if (!c) continue;
    if (c.type === nameField) {
      name = source.slice(c.startIndex, c.endIndex);
    }
  }

  const [sl, el] = [child.startPosition.row + 1, child.endPosition.row + 1];
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

/**
 * Extract a rule set: a selector group with a body. Nested rule sets, mixin
 * includes, extends, and variable declarations inside the body become child
 * symbols. Placeholder selectors (`%name`) are typed as `placeholder`.
 */
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

  const [sl, el] = [child.startPosition.row + 1, child.endPosition.row + 1];
  const symbol: SymbolInfo = {
    name,
    // `%placeholder` selectors get their own type; everything else is a plain
    // ruleset.
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

/**
 * Extract the `@media`/`@supports`-style at-rule name: the keyword plus the
 * query feature, without the trailing body.
 */
function extractMediaName(node: Node, source: string): string {
  const start = source.slice(node.startIndex, node.endIndex).trim();
  const brace = start.indexOf("{");
  return brace >= 0 ? start.slice(0, brace).trim() : start;
}

/**
 * Extract an `@media`/`@supports`-style at-block: emit a container symbol with
 * the query as its name and recurse into the body.
 */
function extractAtBlock(
  child: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
  nameOf: (node: Node, source: string) => string,
): SymbolInfo | null {
  const name = nameOf(child, source);
  const [sl, el] = [child.startPosition.row + 1, child.endPosition.row + 1];
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

/**
 * Extract `@keyframes name { from {...} to {...} }`.
 */
function extractKeyframes(
  child: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
): SymbolInfo | null {
  let name = "<unknown>";
  const nameNode = findChildByType(child, ["keyframes_name"]);
  if (nameNode) name = source.slice(nameNode.startIndex, nameNode.endIndex);

  const [sl, el] = [child.startPosition.row + 1, child.endPosition.row + 1];
  const symbol: SymbolInfo = {
    name: `@keyframes ${name}`,
    type: "keyframes",
    startLine: sl,
    endLine: el,
  };

  if (depth < MAX_DEPTH) {
    const blockList = findChildByType(child, ["keyframe_block_list"]);
    if (blockList) {
      const children: SymbolInfo[] = [];
      for (let i = 0; i < blockList.namedChildCount; i++) {
        const kb = blockList.namedChild(i);
        if (!kb) continue;
        if (kb.type === "keyframe_block") {
          const step = source
            .slice(kb.startIndex, kb.endIndex)
            .split("{")[0]
            .trim();
          children.push({
            name: step,
            type: "keyframe",
            startLine: kb.startPosition.row + 1,
            endLine: kb.endPosition.row + 1,
          });
        }
      }
      if (children.length > 0) symbol.children = children;
    }
  }

  return symbol;
}

/**
 * Extract symbols from a block body: nested rule sets, mixins, functions,
 * includes, extends, and `$var` declarations.
 */
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
      case "keyframes_statement": {
        const inner = extractScssChild(child, source, depth, MAX_DEPTH);
        if (inner) results.push(inner);
        break;
      }
      case "mixin_statement":
      case "function_statement": {
        const inner = extractScssChild(child, source, depth, MAX_DEPTH);
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
        // `$var: value;` inside a block should surface as a variable.
        const prop = childTextOfType(child, source, 0, "property_name");
        if (prop && prop.startsWith("$")) {
          results.push({
            name: prop,
            type: "variable",
            startLine: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          });
        }
        break;
      }
      case "ERROR": {
        // `@extend %placeholder;` and `@include foo;` after error recovery can
        // surface inside an ERROR node. Recover placeholder extends here.
        const ext = extractExtendFromError(child, source);
        if (ext) results.push(ext);
        break;
      }
    }
  }

  return results;
}

/**
 * Extract `@include name(...);` as a usage symbol.
 */
function extractInclude(child: Node, source: string): SymbolInfo | null {
  let name: string | undefined;

  for (let i = 0; i < child.namedChildCount; i++) {
    const c = child.namedChild(i);
    if (!c) continue;
    if (c.type === "identifier") {
      name = source.slice(c.startIndex, c.endIndex);
    }
  }
  if (!name) return null;

  return {
    name: `@include ${name}`,
    type: "include",
    startLine: child.startPosition.row + 1,
    endLine: child.endPosition.row + 1,
  };
}

/**
 * Extract `@extend selector;` as a usage symbol.
 */
function extractExtend(child: Node, source: string): SymbolInfo | null {
  let target: string | undefined;
  for (let i = 0; i < child.namedChildCount; i++) {
    const c = child.namedChild(i);
    if (!c) continue;
    if (
      c.type === "class_selector" ||
      c.type === "placeholder" ||
      c.type === "id_selector" ||
      c.type === "identifier" ||
      c.type === "type_selector"
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
    endLine: child.endPosition.row + 1,
  };
}

/**
 * Recover `@extend %placeholder;` from an ERROR node that grammar failed to
 * parse as extend_statement.
 */
function extractExtendFromError(child: Node, source: string): SymbolInfo | null {
  // Look for a placeholder / selector descendant.
  const target = findAnyText(child, source, [
    "placeholder",
    "class_selector",
    "id_selector",
  ]);
  if (!target) return null;

  return {
    name: `@extend ${target}`,
    type: "extend",
    startLine: child.startPosition.row + 1,
    endLine: child.endPosition.row + 1,
  };
}

// ---- SCSS imports ----

/**
 * Extract SCSS imports: `@use`, `@forward`, and `@import` statements.
 *
 * Grammar quirks handled:
 *  - `@use "x" as y;` / `@forward "x" as cfg-*;` produce ERROR children, but the
 *    authoritative module path survives as a `string_value` descendant.
 *  - Plain `@use "x";`, `@forward "x";`, `@import "x";` parse cleanly.
 */
export function extractScssImports(
  node: Node,
  source: string,
): ImportInfo[] {
  const results: ImportInfo[] = [];
  const visited = new Set<string>();

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    let kind: string | null = "import";
    if (child.type === "use_statement") kind = "use";
    else if (child.type === "forward_statement") kind = "forward";
    else if (child.type === "import_statement") kind = "import";
    else if (child.type === "ERROR") {
      // `@forward "x" as cfg-*;` collapses into ERROR at top level.
      const fwd = isForwardError(child, source);
      if (fwd) {
        const p = valueStringOf(child, source);
        if (p) {
          const dedupe = `forward:${p}`;
          if (!visited.has(dedupe)) {
            visited.add(dedupe);
            results.push({
              source: p,
              names: [p],
              lineNumber: child.startPosition.row + 1,
            });
          }
        }
      }
      continue;
    } else {
      continue;
    }

    const path = valueStringOf(child, source);
    if (!path) continue;

    const dedupe = `${kind}:${path}`;
    if (visited.has(dedupe)) continue;
    visited.add(dedupe);

    results.push({
      source: path,
      names: [path],
      lineNumber: child.startPosition.row + 1,
    });
  }

  return results;
}

/**
 * Detect a top-level ERROR node that is actually `@forward "path" as ...;`.
 */
function isForwardError(node: Node, source: string): boolean {
  const start = source.slice(node.startIndex, node.startIndex + 9);
  return start.trim() === "@forward";
}

/**
 * Extract the module path (string literal) from a use/forward/import statement,
 * working around ERROR subtrees.
 */
function valueStringOf(node: Node, source: string): string | undefined {
  // Prefer a string_value first (it holds the module path).
  const str = findAnyText(node, source, ["string_value"]);
  if (str) return stripQuotes(str);

  // Fallback: inside ERROR nodes the path may parse as a plain tag or
  // concatenated identifier.
  const fallback = findAnyText(node, source, ["tag_name", "_concatenated_identifier"]);
  if (fallback) return fallback;

  return undefined;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

// ---- Shared helpers ----

/** Find the first named descendant with one of the given types, returning its source text. */
function findAnyText(
  node: Node,
  source: string,
  types: string[],
): string | undefined {
  // BFS over named children so recovery works even through ERROR nodes.
  const queue: Node[] = [node];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (let i = 0; i < cur.namedChildCount; i++) {
      const c = cur.namedChild(i);
      if (!c) continue;
      if (types.includes(c.type)) {
        return source.slice(c.startIndex, c.endIndex);
      }
      queue.push(c);
    }
  }
  return undefined;
}

/** Find the first direct named child with one of the given types. */
function findChildByType(node: Node, types: string[]): Node | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && types.includes(c.type)) return c;
  }
  return null;
}

/** Return the text of the nth direct named child of a given type. */
function childTextOfType(
  node: Node,
  source: string,
  index: number,
  type: string,
): string | undefined {
  let seen = 0;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === type) {
      if (seen === index) return source.slice(c.startIndex, c.endIndex);
      seen++;
    }
  }
  return undefined;
}

function nodeTextOf(node: Node, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}
