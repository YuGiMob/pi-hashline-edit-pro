/**
 * Tree-sitter parser manager.
 *
 * Lazily initializes the WASM runtime and loads language grammars on demand.
 * All parsers share a single Parser instance, re-configured per language.
 */

import { fileURLToPath } from "node:url";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { SymbolInfo, ImportInfo } from "../types.ts";
import { extractJava, extractJavaImports } from "./java.ts";
import { extractPhp } from "./php.ts";
import { extractBlade } from "./blade.ts";
import { extractScss, extractScssImports } from "./scss.ts";
import { extractSass, extractSassImports } from "./sass.ts";

// ---- WASM path resolution ----


/** Known language grammars with their npm package + WASM file name. */
const GRAMMAR_REGISTRY: Record<
  string,
  { package: string; wasm: string; label: string }
> = {
  javascript: {
    package: "tree-sitter-javascript",
    wasm: "tree-sitter-javascript.wasm",
    label: "JavaScript",
  },
  typescript: {
    package: "tree-sitter-typescript",
    wasm: "tree-sitter-typescript.wasm",
    label: "TypeScript",
  },
  tsx: {
    package: "tree-sitter-typescript",
    wasm: "tree-sitter-tsx.wasm",
    label: "TSX",
  },
  python: {
    package: "tree-sitter-python",
    wasm: "tree-sitter-python.wasm",
    label: "Python",
  },
  go: {
    package: "tree-sitter-go",
    wasm: "tree-sitter-go.wasm",
    label: "Go",
  },
  rust: {
    package: "tree-sitter-rust",
    wasm: "tree-sitter-rust.wasm",
    label: "Rust",
  },
  solidity: {
    package: "tree-sitter-solidity",
    wasm: "tree-sitter-solidity.wasm",
    label: "Solidity",
  },
  scss: {
    package: "tree-sitter-scss",
    wasm: "tree-sitter-scss.wasm",
    label: "SCSS",
  },
  sass: {
    package: "tree-sitter-sass",
    wasm: "tree-sitter-sass.wasm",
    label: "Sass",
  },
  java: {
    package: "tree-sitter-java",
    wasm: "tree-sitter-java.wasm",
    label: "Java",
  },
  php: {
    package: "tree-sitter-php",
    wasm: "tree-sitter-php.wasm",
    label: "PHP",
  },
  blade: {
    package: "tree-sitter-blade",
    wasm: "tree-sitter-blade.wasm",
    label: "Blade",
  },
  markdown: {
    package: "markdown",
    wasm: "markdown.wasm",
    label: "Markdown",
  },
};

/** Map file extensions to grammar keys. */
const EXTENSION_MAP: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".sol": "solidity",
  ".java": "java",
  ".scss": "scss",
  ".sass": "sass",
  ".blade.php": "blade",
  ".php": "php",
  ".md": "markdown",
  ".markdown": "markdown",
};

const BASENAME_MAP: Record<string, string> = {
  artisan: "php",
};

// ---- Singleton state ----

let initialized = false;
const loadedLanguages = new Map<string, Language>();
let sharedParser: Parser | null = null;

/** Initialize the WASM runtime (once). */
async function ensureInit(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
  sharedParser = new Parser();
}

/** Load a language grammar by key (cached). */
async function loadLanguage(key: string): Promise<Language> {
  const cached = loadedLanguages.get(key);
  if (cached) return cached;

  const entry = GRAMMAR_REGISTRY[key];
  if (!entry) throw new Error(`Unknown grammar: ${key}`);

  const wasmPath = fileURLToPath(
    new URL("../wasm/" + entry.wasm, import.meta.url),
  );

  const lang = await Language.load(wasmPath);
  loadedLanguages.set(key, lang);
  return lang;
}

// ---- Public API ----

/** Detect grammar key from a file path's extension. */
export function detectLanguage(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  const base = lower.split(/[/\\]/).pop() ?? lower;
  const named = BASENAME_MAP[base];
  if (named !== undefined) return named;
  for (const [ext, key] of Object.entries(EXTENSION_MAP)) {
    if (lower.endsWith(ext)) return key;
  }
  return null;
}

/** Get a human-readable label for a grammar key. */
export function languageLabel(key: string): string {
  return GRAMMAR_REGISTRY[key]?.label ?? key;
}

/** Parse source code with a given grammar, returning SymbolInfo[]. */
export async function parseCode(
  key: string,
  source: string,
): Promise<{ symbols: SymbolInfo[]; hasError: boolean }> {
  // Markdown uses regex-based parsing, not tree-sitter
  if (key === "markdown") {
    return { symbols: extractMarkdown(source), hasError: false };
  }

  await ensureInit();

  const lang = await loadLanguage(key);
  if (!sharedParser) throw new Error("Parser not initialized");

  sharedParser.setLanguage(lang);
  const tree = sharedParser.parse(source);
  if (!tree) return { symbols: [], hasError: false };

  return { symbols: extractSymbols(key, tree.rootNode, source, 0), hasError: tree.rootNode.hasError };
}

// ---- Symbol extraction dispatch ----

function extractSymbols(
  key: string,
  node: Node,
  source: string,
  depth: number,
): SymbolInfo[] {
  switch (key) {
    case "javascript":
    case "typescript":
    case "tsx":
      return extractJavaScriptLike(node, source, depth);
    case "python":
      return extractPython(node, source, depth);
    case "go":
      return extractGo(node, source, depth);
    case "rust":
      return extractRust(node, source, depth);
    case "solidity":
      return extractSolidity(node, source, depth);
    case "scss":
      return extractScss(node, source, depth);
    case "sass":
      return extractSass(node, source, depth);
    case "java":
      return extractJava(node, source, depth);
    case "php":
      return extractPhp(node, source, depth);
    case "blade":
      return extractBlade(node, source, depth);
    case "markdown":
      return extractMarkdown(source);
    default:
      return [];
  }
}

// ---- Generic helpers ----

/** Get the text of the first named child matching a type. */
function childText(
  node: Node,
  childType: string,
  source: string,
): string | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    if (c && c.type === childType) {
      return source.slice(c.startIndex, c.endIndex);
    }
  }
  return undefined;
}

/** Get the first field child's text (field-name-based access). */
function fieldChildText(
  node: Node,
  fieldName: string,
  source: string,
): string | undefined {
  const c = node.childForFieldName(fieldName);
  return c ? source.slice(c.startIndex, c.endIndex) : undefined;
}

// ---- Node line ranges (0-indexed → 1-indexed) ----

function nodeRange(node: Node): [number, number] {
  return [node.startPosition.row + 1, node.endPosition.row + 1];
}

// ========================================================================
// JavaScript / TypeScript / TSX
// ========================================================================

function extractJavaScriptLike(
  node: Node,
  source: string,
  depth: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const MAX_DEPTH = depth + 10; // track overall depth via recursion param

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    const symbol = extractJSChild(child, source) ?? (node.type === "program" ? commonJsExportSymbol(child, source) : null);
    if (!symbol) continue;

    // Look inside the bodies of container declarations
    if (JS_CONTAINER_TYPES.has(symbol.type ?? "") && depth < MAX_DEPTH) {
      const declaration = jsDeclarationNode(child);
      const bodyNode =
        declaration.childForFieldName("body") ??
        findChildByType(declaration, ["class_body", "interface_body", "enum_body", "object_type", "statement_block"]);
      if (bodyNode) {
        symbol.children = extractJavaScriptLike(bodyNode, source, depth + 1);
      }
    }

    results.push(symbol);
  }

  return results;
}

const JS_CONTAINER_TYPES = new Set(["class", "interface", "enum", "namespace"]);

/** Unwrap `export`, `declare` and the expression statement TypeScript puts around `namespace`. */
function jsDeclarationNode(child: Node): Node {
  if (child.type === "export_statement" || child.type === "ambient_declaration" || child.type === "expression_statement") {
    const inner = child.namedChildren.find((c) => c.type !== "decorator" && c.type !== "comment");
    if (inner && inner.type !== "statement_block") return jsDeclarationNode(inner);
  }
  return child;
}

const JS_SYMBOL_TYPES: Record<string, string> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  function_signature: "function",
  function_expression: "function",
  arrow_function: "arrow_function",
  method_definition: "method",
  method_signature: "method",
  abstract_method_signature: "method",
  class_declaration: "class",
  class: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  enum_assignment: "enum_member",
  type_alias_declaration: "type",
  abstract_class_declaration: "class",
  internal_module: "namespace",
  module: "namespace",
  public_field_definition: "field",
  field_definition: "field",
  property_signature: "field",
  lexical_declaration: "variable",
  variable_declaration: "variable",
};

function isFunctionNode(node: Node): boolean {
  return node.type === "arrow_function" || node.type === "function_expression" || node.type === "function" || node.type === "generator_function";
}

const COMMONJS_TARGET = /^(module\.exports(\.[\w$]+)?|exports\.[\w$]+|[\w$]+\.prototype\.[\w$]+)$/;

/** Top-level `module.exports = ...`, `exports.x = ...` and `Foo.prototype.m = ...`. */
function commonJsExportSymbol(child: Node, source: string): SymbolInfo | null {
  if (child.type !== "expression_statement") return null;
  const expr = child.namedChild(0);
  if (!expr || expr.type !== "assignment_expression") return null;
  const left = expr.childForFieldName("left");
  const right = expr.childForFieldName("right");
  if (!left || left.type !== "member_expression") return null;
  const name = source.slice(left.startIndex, left.endIndex);
  if (!COMMONJS_TARGET.test(name)) return null;
  const [sl, el] = nodeRange(child);
  return { name, type: right && isFunctionNode(right) ? "function" : "variable", startLine: sl, endLine: el };
}

function extractJSChild(
  child: Node,
  source: string,
): SymbolInfo | null {
  const type = child.type;

  // Top-level declarations: functions, arrow functions, and variables
  if (
    type === "lexical_declaration" ||
    type === "variable_declaration"
  ) {
    const declarators: SymbolInfo[] = [];
    for (let j = 0; j < child.namedChildCount; j++) {
      const d = child.namedChild(j);
      if (!d || d.type !== "variable_declarator") continue;
      const name = fieldChildText(d, "name", source);
      if (!name) continue;
      const value = d.childForFieldName("value");
      if (value && isFunctionNode(value)) {
        const [sl, el] = nodeRange(d);
        declarators.push({
          name,
          type: value.type === "arrow_function" ? "arrow_function" : "function",
          startLine: sl,
          endLine: el,
        });
      } else {
        const [sl, el] = nodeRange(d);
        declarators.push({
          name,
          type: "variable",
          startLine: sl,
          endLine: el,
        });
      }
    }
    if (declarators.length === 1) return declarators[0];
    if (declarators.length > 1) {
      return {
        name: "",
        type: "variable",
        startLine: declarators[0].startLine,
        endLine: declarators[declarators.length - 1].endLine,
        children: declarators,
      };
    }
    return null;
  }

  // Export statement — unwrap
  if (type === "export_statement") {
    const isDefault = child.text.startsWith("export default");
    for (let j = 0; j < child.namedChildCount; j++) {
      const inner = child.namedChild(j);
      if (inner) {
        const result = extractJSChild(inner, source);
        if (result) {
          if (isDefault && result.name === "<anonymous>") result.name = "default";
          const [sl, el] = nodeRange(child);
          // Keep the row on the `export` line when the declaration starts there.
          if (inner.type === "expression_statement" && result.startLine > sl) result.startLine = sl;
          if (result.endLine < el && inner.type === "expression_statement") result.endLine = el;
          return result;
        }
      }
    }
    return null;
  }

  // `declare module "x" {}`, `declare function f(): void;`, `declare global {}`
  if (type === "ambient_declaration") {
    const inner = child.namedChildren.find((c) => c.type !== "comment");
    if (!inner) return null;
    const [sl, el] = nodeRange(child);
    if (inner.type === "statement_block") return { name: "global", type: "namespace", startLine: sl, endLine: el };
    const result = extractJSChild(inner, source);
    if (result) {
      result.startLine = sl;
      result.endLine = el;
    }
    return result;
  }

  if (type === "expression_statement") {
    const inner = child.namedChild(0);
    if (inner?.type === "internal_module") {
      const result = extractJSChild(inner, source);
      if (result) [result.startLine, result.endLine] = nodeRange(child);
      return result;
    }
    return testCallSymbol(child, source);
  }

  // Bare enum members: `enum E { Red, Green }`
  if (type === "property_identifier" && child.parent?.type === "enum_body") {
    const [sl, el] = nodeRange(child);
    return { name: source.slice(child.startIndex, child.endIndex), type: "enum_member", startLine: sl, endLine: el };
  }

  const symbolType = JS_SYMBOL_TYPES[type];
  if (!symbolType) return null;

  const name =
    fieldChildText(child, "name", source) ||
    fieldChildText(child, "property", source) ||
    childText(child, "property_identifier", source) ||
    childText(child, "type_identifier", source) ||
    "<anonymous>";

  // Decorators on their own lines are children of fields and non-exported classes; start at the declaration.
  const declarationStart = child.children.find((part) => part.type !== "decorator" && part.type !== "comment");
  const [, el] = nodeRange(child);
  const sl = (declarationStart ?? child).startPosition.row + 1;

  return { name, type: symbolType, startLine: sl, endLine: el };
}

const TEST_CALLEES = new Set(["describe", "test", "it", "suite", "context", "specify"]);

function testCallSymbol(child: Node, source: string): SymbolInfo | null {
  const expr = child.namedChildCount > 0 ? child.namedChild(0) : null;
  if (!expr || expr.type !== "call_expression") return null;
  const fn = expr.childForFieldName("function");
  const args = expr.childForFieldName("arguments");
  if (!fn || !args) return null;
  const callee = (source.slice(fn.startIndex, fn.endIndex).split(".")[0] ?? "").trim();
  if (!TEST_CALLEES.has(callee)) return null;
  const first = args.namedChildren[0];
  if (!first || first.type !== "string") return null;
  const name = source.slice(first.startIndex, first.endIndex).replace(/^["'`]|["'`]$/g, "");
  const [sl, el] = nodeRange(expr);
  const symbol: SymbolInfo = { name, type: callee, startLine: sl, endLine: el };
  const children = extractTestCalls(expr, source);
  if (children.length > 0) symbol.children = children;
  return symbol;
}

function extractTestCalls(call: Node, source: string): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const args = call.childForFieldName("arguments");
  for (const arg of args?.namedChildren ?? []) {
    if (arg.type !== "arrow_function" && arg.type !== "function_expression" && arg.type !== "function") continue;
    const body = arg.childForFieldName("body");
    if (!body || body.type !== "statement_block") continue;
    for (const stmt of body.namedChildren) {
      if (stmt.type !== "expression_statement") continue;
      const inner = testCallSymbol(stmt, source);
      if (inner) results.push(inner);
    }
  }
  return results;
}

function findChildByType(
  node: Node,
  types: string[],
): Node | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && types.includes(c.type)) return c;
  }
  return null;
}

// ========================================================================
// Python
// ========================================================================

function extractPython(
  node: Node,
  source: string,
  depth: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const MAX_DEPTH = depth + 10;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    let symbol: SymbolInfo | null = null;

    if (child.type === "decorated_definition") {
      // The row and span start at the definition line; the decorators above it are excluded.
      const def = child.childForFieldName("definition");
      symbol = def ? extractPythonDefinition(def, source, depth, MAX_DEPTH) : null;
      if (symbol) symbol.type = "decorated_" + symbol.type;
    } else if (child.type === "expression_statement" || child.type === "type_alias_statement") {
      symbol = extractPythonAssignment(child, source);
    } else {
      symbol = extractPythonDefinition(child, source, depth, MAX_DEPTH);
    }

    if (symbol) results.push(symbol);
  }

  return results;
}

function extractPythonDefinition(
  child: Node,
  source: string,
  depth: number,
  maxDepth: number,
): SymbolInfo | null {
  if (child.type === "class_definition") {
    const name = fieldChildText(child, "name", source) || "<anonymous>";
    const [sl, el] = nodeRange(child);
    const symbol: SymbolInfo = { name, type: "class", startLine: sl, endLine: el };
    const body = child.childForFieldName("body");
    if (body && depth < maxDepth) {
      symbol.children = extractPython(body, source, depth + 1);
    }
    return symbol;
  }
  if (child.type === "function_definition") {
    const name = fieldChildText(child, "name", source) || "<anonymous>";
    const [sl, el] = nodeRange(child);
    return { name, type: "function", startLine: sl, endLine: el };
  }
  return null;
}

/** `NAME = ...`, `NAME: T = ...` and `type NAME = ...` at module or class level; other targets are skipped. */
function extractPythonAssignment(child: Node, source: string): SymbolInfo | null {
  const [sl, el] = nodeRange(child);
  if (child.type === "type_alias_statement") {
    const left = child.namedChild(0);
    return left ? { name: source.slice(left.startIndex, left.endIndex), type: "type", startLine: sl, endLine: el } : null;
  }
  const assignment = child.namedChild(0);
  if (!assignment || assignment.type !== "assignment") return null;
  const left = assignment.childForFieldName("left");
  if (!left || left.type !== "identifier") return null;
  return { name: source.slice(left.startIndex, left.endIndex), type: "variable", startLine: sl, endLine: el };
}

// ========================================================================
// Go
// ========================================================================

function extractGo(
  node: Node,
  source: string,
  depth: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const MAX_DEPTH = depth + 10;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    let symbol: SymbolInfo | null = null;

    if (child.type === "function_declaration") {
      const name = fieldChildText(child, "name", source) || "<anonymous>";
      const [sl, el] = nodeRange(child);
      symbol = { name, type: "function", startLine: sl, endLine: el };
    } else if (child.type === "method_declaration") {
      const name = fieldChildText(child, "name", source) || "<anonymous>";
      const receiver = child.childForFieldName("receiver");
      const receiverText = receiver
        ? source.slice(receiver.startIndex, receiver.endIndex)
        : "";
      const [sl, el] = nodeRange(child);
      const fullName = receiverText ? `${receiverText}).${name}` : name;
      symbol = { name: fullName, type: "method", startLine: sl, endLine: el };
    } else if (child.type === "type_declaration") {
      // type_declaration wraps type_spec nodes
      const specs: SymbolInfo[] = [];
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (!spec || (spec.type !== "type_spec" && spec.type !== "type_alias")) continue;
        const name = fieldChildText(spec, "name", source) || "<anonymous>";
        const [sl, el] = nodeRange(spec);
        const typeNode = spec.childForFieldName("type");
        const kind = typeNode?.type === "struct_type"
          ? "struct"
          : typeNode?.type === "interface_type"
            ? "interface"
            : "type";
        const entry: SymbolInfo = { name, type: kind, startLine: sl, endLine: el };

        // Recurse into struct/interface body
        if (typeNode && depth < MAX_DEPTH) {
          const body = typeNode.type === "interface_type"
            ? typeNode
            : findChildByType(typeNode, ["field_declaration_list"]);
          if (body) {
            const fields = extractGoFields(body, source);
            if (fields.length > 0) entry.children = fields;
          }
        }

        specs.push(entry);
      }
      if (child.children.some((part) => part.type === "(")) {
        const [sl, el] = nodeRange(child);
        symbol = { name: "type", type: "type", startLine: sl, endLine: el, children: specs };
      } else if (specs.length === 1) {
        symbol = specs[0];
      }
      if (symbol) results.push(symbol);
      continue;
    } else if (child.type === "const_declaration") {
      const [sl, el] = nodeRange(child);
      const specs: SymbolInfo[] = [];
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (!spec || spec.type !== "const_spec") continue;
        const name = fieldChildText(spec, "name", source) || "<anonymous>";
        const [specStart, specEnd] = nodeRange(spec);
        specs.push({ name, type: "const", startLine: specStart, endLine: specEnd });
      }
      const grouped = child.children.some((part) => part.type === "(");
      symbol = {
        name: grouped ? "const" : specs.map((spec) => spec.name).join(", ") || "const",
        type: "const",
        startLine: sl,
        endLine: el,
        ...(grouped ? { children: specs } : {}),
      };
    } else if (child.type === "var_declaration") {
      const [sl, el] = nodeRange(child);
      const specs: SymbolInfo[] = [];
      const list = findChildByType(child, ["var_spec_list"]);
      const container = list ?? child;
      for (let j = 0; j < container.namedChildCount; j++) {
        const spec = container.namedChild(j);
        if (!spec || spec.type !== "var_spec") continue;
        const name = fieldChildText(spec, "name", source) || "<anonymous>";
        const [specStart, specEnd] = nodeRange(spec);
        specs.push({ name, type: "var", startLine: specStart, endLine: specEnd });
      }
      const grouped = list !== null;
      symbol = {
        name: grouped ? "var" : specs.map((spec) => spec.name).join(", ") || "var",
        type: "var",
        startLine: sl,
        endLine: el,
        ...(grouped ? { children: specs } : {}),
      };
    }

    if (symbol) results.push(symbol);
  }

  return results;
}

function extractGoFields(
  node: Node,
  source: string,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || !["field_declaration", "method_elem", "type_elem"].includes(child.type)) continue;

    const first = child.namedChild(0);
    const name = fieldChildText(child, "name", source) ||
      (first ? source.slice(first.startIndex, first.endIndex) : "");
    if (!name) continue;
    const [sl, el] = nodeRange(child);
    results.push({
      name,
      type: child.type === "method_elem" ? "method" : "field",
      startLine: sl,
      endLine: el,
    });
  }

  return results;
}

// ========================================================================
// Rust
// ========================================================================

function extractRust(
  node: Node,
  source: string,
  depth: number,
  inImplOrTrait = false,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const MAX_DEPTH = depth + 10;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    const [sl, el] = nodeRange(child);
    const name = fieldChildText(child, "name", source) || "<anonymous>";
    let symbol: SymbolInfo | null = null;
    // Body whose items become children, and whether its functions are methods.
    let body: Node | null = null;
    let bodyIsImplOrTrait = false;

    switch (child.type) {
      case "function_item":
      case "function_signature_item":
        symbol = { name, type: inImplOrTrait ? "method" : "function", startLine: sl, endLine: el };
        break;
      case "struct_item":
      case "union_item":
        symbol = { name, type: child.type === "struct_item" ? "struct" : "union", startLine: sl, endLine: el };
        body = child.childForFieldName("body");
        break;
      case "enum_item":
        symbol = { name, type: "enum", startLine: sl, endLine: el };
        body = child.childForFieldName("body");
        break;
      case "field_declaration":
        symbol = { name, type: "field", startLine: sl, endLine: el };
        break;
      case "enum_variant":
        symbol = { name, type: "enum_variant", startLine: sl, endLine: el };
        break;
      case "trait_item":
        symbol = { name, type: "trait", startLine: sl, endLine: el };
        body = child.childForFieldName("body");
        bodyIsImplOrTrait = true;
        break;
      case "impl_item": {
        const trait = child.childForFieldName("trait");
        const implType = child.childForFieldName("type");
        const traitStr = trait ? source.slice(trait.startIndex, trait.endIndex) + " for " : "";
        const typeStr = implType ? source.slice(implType.startIndex, implType.endIndex) : "";
        symbol = { name: `impl ${traitStr}${typeStr}`, type: "impl", startLine: sl, endLine: el };
        body = child.childForFieldName("body");
        bodyIsImplOrTrait = true;
        break;
      }
      case "mod_item":
        symbol = { name, type: "module", startLine: sl, endLine: el };
        body = child.childForFieldName("body");
        break;
      case "foreign_mod_item": {
        const modifier = findChildByType(child, ["extern_modifier"]);
        symbol = { name: modifier ? source.slice(modifier.startIndex, modifier.endIndex) : "extern", type: "extern", startLine: sl, endLine: el };
        body = child.childForFieldName("body") ?? findChildByType(child, ["declaration_list"]);
        break;
      }
      case "type_item":
      case "associated_type":
        symbol = { name, type: "type", startLine: sl, endLine: el };
        break;
      case "const_item":
        symbol = { name, type: "const", startLine: sl, endLine: el };
        break;
      case "static_item":
        symbol = { name, type: "static", startLine: sl, endLine: el };
        break;
      case "macro_definition":
        symbol = { name: `${name}!`, type: "macro", startLine: sl, endLine: el };
        break;
    }

    if (symbol && body && depth < MAX_DEPTH) {
      const children = extractRust(body, source, depth + 1, bodyIsImplOrTrait);
      if (children.length > 0) symbol.children = children;
    }
    if (symbol) results.push(symbol);
  }

  return results;
}

// ========================================================================
// Solidity
// ========================================================================

function extractSolidity(
  node: Node,
  source: string,
  depth: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const MAX_DEPTH = depth + 10;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    let symbol: SymbolInfo | null = null;

    if (child.type === "contract_declaration") {
      const name = fieldChildText(child, "name", source) || "<anonymous>";
      const [sl, el] = nodeRange(child);

      symbol = { name, type: "contract", startLine: sl, endLine: el };

      // Recurse into contract body
      const body = child.childForFieldName("body");
      if (body && depth < MAX_DEPTH) {
        symbol.children = extractSolidityBody(body, source, depth + 1);
      }
    } else if (child.type === "interface_declaration") {
      const name = fieldChildText(child, "name", source) || "<anonymous>";
      const [sl, el] = nodeRange(child);

      symbol = { name, type: "interface", startLine: sl, endLine: el };

      const body = child.childForFieldName("body");
      if (body && depth < MAX_DEPTH) {
        symbol.children = extractSolidityBody(body, source, depth + 1);
      }
    } else if (child.type === "library_declaration") {
      const name = fieldChildText(child, "name", source) || "<anonymous>";
      const [sl, el] = nodeRange(child);
      symbol = { name, type: "library", startLine: sl, endLine: el };

      const body = child.childForFieldName("body");
      if (body && depth < MAX_DEPTH) {
        symbol.children = extractSolidityBody(body, source, depth + 1);
      }
    } else {
      // File-level item
      symbol = extractSolidityItem(child, source);
    }

    if (symbol) results.push(symbol);
  }

  return results;
}

function extractSolidityBody(
  node: Node,
  source: string,
  depth: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const MAX_DEPTH = depth + 10;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    const symbol = extractSolidityItem(child, source);
    if (!symbol) continue;

    // Recurse into struct and enum bodies for nested members
    if (symbol.type === "struct" && depth < MAX_DEPTH) {
      const bodyNode = child.childForFieldName("body");
      if (bodyNode) {
        symbol.children = [];
        for (let j = 0; j < bodyNode.namedChildCount; j++) {
          const m = bodyNode.namedChild(j);
          if (!m) continue;
          if (m.type === "struct_member") {
            const memberName = fieldChildText(m, "name", source) || "";
            const [msl, mel] = nodeRange(m);
            symbol.children.push({
              name: memberName,
              type: "field",
              startLine: msl,
              endLine: mel,
            });
          }
        }
      }
    } else if (symbol.type === "enum" && depth < MAX_DEPTH) {
      const bodyNode = child.childForFieldName("body");
      if (bodyNode) {
        symbol.children = [];
        for (let j = 0; j < bodyNode.namedChildCount; j++) {
          const m = bodyNode.namedChild(j);
          if (!m || m.type !== "enum_value") continue;
          const [msl, mel] = nodeRange(m);
          symbol.children.push({
            name: source.slice(m.startIndex, m.endIndex).trim(),
            type: "enum_value",
            startLine: msl,
            endLine: mel,
          });
        }
      }
    }

    results.push(symbol);
  }

  return results;
}

function extractSolidityItem(
  child: Node,
  source: string,
): SymbolInfo | null {
  const type = child.type;

  if (type === "function_definition") {
    const name = fieldChildText(child, "name", source) || "<anonymous>";
    const [sl, el] = nodeRange(child);
    return { name, type: "function", startLine: sl, endLine: el };
  }

  if (type === "constructor_definition") {
    const [sl, el] = nodeRange(child);
    return { name: "constructor", type: "constructor", startLine: sl, endLine: el };
  }

  if (type === "modifier_definition") {
    const name = fieldChildText(child, "name", source) || "<anonymous>";
    const [sl, el] = nodeRange(child);
    return { name, type: "modifier", startLine: sl, endLine: el };
  }

  if (type === "event_definition") {
    const name = fieldChildText(child, "name", source) || "<anonymous>";
    const [sl, el] = nodeRange(child);
    return { name, type: "event", startLine: sl, endLine: el };
  }

  if (type === "error_declaration") {
    const name = childText(child, "identifier", source) || "<anonymous>";
    const [sl, el] = nodeRange(child);
    return { name, type: "error", startLine: sl, endLine: el };
  }

  if (type === "struct_declaration") {
    const name = childText(child, "identifier", source) || fieldChildText(child, "name", source) || "<anonymous>";
    const [sl, el] = nodeRange(child);
    return { name, type: "struct", startLine: sl, endLine: el };
  }

  if (type === "enum_declaration") {
    const name = fieldChildText(child, "name", source) || childText(child, "identifier", source) || "<anonymous>";
    const [sl, el] = nodeRange(child);
    return { name, type: "enum", startLine: sl, endLine: el };
  }

  if (type === "fallback_receive_definition") {
    const [sl, el] = nodeRange(child);

    // Distinguish fallback vs receive by checking first keyword child
    let symbolType = "fallback";
    for (let j = 0; j < child.childCount; j++) {
      const c = child.child(j);
      if (c && c.type === "receive") {
        symbolType = "receive";
        break;
      }
    }


    return {
      name: symbolType,
      type: symbolType,
      startLine: sl,
      endLine: el,
    };
  }

  if (type === "state_variable_declaration") {
    const name = fieldChildText(child, "name", source) || "<anonymous>";
    const [sl, el] = nodeRange(child);
    return { name, type: "variable", startLine: sl, endLine: el };
  }

  return null;
}

// ========================================================================
// Import extraction
// ========================================================================

/**
 * Extract import statements from parsed source code.
 * Returns a list of ImportInfo for each import in the file.
 */
export async function parseFileImports(
  key: string,
  source: string,
): Promise<ImportInfo[]> {
  // Markdown uses regex-based parsing, not tree-sitter
  if (key === "markdown") {
    return extractMarkdownLinks(source);
  }

  await ensureInit();

  const lang = await loadLanguage(key);
  if (!sharedParser) throw new Error("Parser not initialized");

  sharedParser.setLanguage(lang);
  const tree = sharedParser.parse(source);
  if (!tree) return [];

  return extractImports(key, tree.rootNode, source);
}

function extractImports(
  key: string,
  node: Node,
  source: string,
): ImportInfo[] {
  switch (key) {
    case "javascript":
    case "typescript":
    case "tsx":
      return extractJSImports(node, source);
    case "python":
      return extractPythonImports(node, source);
    case "go":
      return extractGoImports(node, source);
    case "rust":
      return extractRustImports(node, source);
    case "solidity":
      return extractSolidityImports(node, source);
    case "scss":
      return extractScssImports(node, source);
    case "sass":
      return extractSassImports(node, source);
    case "java":
      return extractJavaImports(node, source);
    case "markdown":
      return extractMarkdownLinks(source);
    default:
      return [];
  }
}

// ---- JavaScript / TypeScript / TSX imports ----

function extractJSImports(node: Node, source: string): ImportInfo[] {
  const results: ImportInfo[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    // import { foo } from 'bar';  or  import foo from 'bar';
    if (child.type === "import_statement") {
      const sourceNode = child.childForFieldName("source");
      if (!sourceNode) continue;
      const sourceText = extractStringLiteral(sourceNode, source);
      if (!sourceText) continue;

      const names = extractImportNames(child, source);
      results.push({
        source: sourceText,
        names,
        lineNumber: child.startPosition.row + 1,
      });
    }

    // export { foo } from 'bar';
    if (child.type === "export_statement") {
      const sourceNode = child.childForFieldName("source");
      if (!sourceNode) continue;
      const sourceText = extractStringLiteral(sourceNode, source);
      if (!sourceText) continue;

      const names = extractImportNames(child, source);

      results.push({
        source: sourceText,
        names,
        lineNumber: child.startPosition.row + 1,
      });
    }

    // const x = require('bar');
    if (
      child.type === "lexical_declaration" ||
      child.type === "variable_declaration"
    ) {
      for (let j = 0; j < child.namedChildCount; j++) {
        const decl = child.namedChild(j);
        if (!decl || decl.type !== "variable_declarator") continue;
        const value = decl.childForFieldName("value");
        if (!value || value.type !== "call_expression") continue;
        const func = value.childForFieldName("function");
        if (!func) continue;
        const funcText = source.slice(func.startIndex, func.endIndex);
        if (funcText !== "require") continue;

        const args = value.childForFieldName("arguments");
        if (!args || args.namedChildCount === 0) continue;
        const firstArg = args.namedChild(0);
        if (!firstArg) continue;
        const sourceText = extractStringLiteral(firstArg, source);
        if (!sourceText) continue;

        const name = fieldChildText(decl, "name", source);
        results.push({
          source: sourceText,
          names: name ? [name] : [],
          lineNumber: child.startPosition.row + 1,
        });
      }
    }
  }

  return results;
}

function extractImportNames(node: Node, source: string): string[] {
  const names: string[] = [];

  // import_clause is a named child, NOT a field in tree-sitter grammar
  for (let j = 0; j < node.namedChildCount; j++) {
    const c = node.namedChild(j);
    if (!c) continue;

    if (c.type === "import_clause") {
      extractNamesFromClause(c, source, names);
    }

    // export_statement may have export_clause with export_specifiers
    if (c.type === "export_clause") {
      for (let k = 0; k < c.namedChildCount; k++) {
        const spec = c.namedChild(k);
        if (spec && spec.type === "export_specifier") {
          const name = fieldChildText(spec, "name", source);
          if (name) names.push(name);
        }
      }
    }
  }

  return names;
}

/** Extract imported symbol names from an import_clause node. */
function extractNamesFromClause(clause: Node, source: string, names: string[]): void {
  for (let j = 0; j < clause.namedChildCount; j++) {
    const c = clause.namedChild(j);
    if (!c) continue;

    if (c.type === "namespace_import") {
      const alias = c.childForFieldName("alias");
      if (alias) names.push("* as " + source.slice(alias.startIndex, alias.endIndex));
    } else if (c.type === "named_imports") {
      for (let k = 0; k < c.namedChildCount; k++) {
        const spec = c.namedChild(k);
        if (spec && spec.type === "import_specifier") {
          const name = fieldChildText(spec, "name", source);
          if (name) names.push(name);
        }
      }
    } else {
      // default import (identifier)
      names.push(source.slice(c.startIndex, c.endIndex));
    }
  }
}

// ---- Python imports ----

function extractPythonImports(node: Node, source: string): ImportInfo[] {
  const results: ImportInfo[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    // import foo
    if (child.type === "import_statement") {
      for (let j = 0; j < child.namedChildCount; j++) {
        const c = child.namedChild(j);
        if (!c) continue;
        if (c.type === "dotted_name") {
          const mod = source.slice(c.startIndex, c.endIndex);
          results.push({
            source: mod,
            names: [],
            lineNumber: child.startPosition.row + 1,
          });
        } else if (c.type === "aliased_import") {
          const name = fieldChildText(c, "name", source);
          const alias = fieldChildText(c, "alias", source);
          if (name) {
            results.push({
              source: name,
              names: alias ? [alias] : [],
              lineNumber: child.startPosition.row + 1,
            });
          }
        }
      }
    }

    // from foo import bar
    if (child.type === "import_from_statement") {
      const moduleNode = child.childForFieldName("module_name");
      const sourceText = moduleNode
        ? source.slice(moduleNode.startIndex, moduleNode.endIndex)
        : "";
      if (!sourceText) continue;

      const names: string[] = [];
      for (let j = 0; j < child.namedChildCount; j++) {
        const c = child.namedChild(j);
        if (!c) continue;
        if (c.type === "dotted_name") {
          names.push(source.slice(c.startIndex, c.endIndex));
        } else if (c.type === "aliased_import") {
          const name = fieldChildText(c, "name", source);
          if (name) names.push(name);
        } else if (c.type === "wildcard_import") {
          names.push("*");
        }
      }

      results.push({
        source: sourceText,
        names,
        lineNumber: child.startPosition.row + 1,
      });
    }
  }

  return results;
}

// ---- Go imports ----

function extractGoImports(node: Node, source: string): ImportInfo[] {
  const results: ImportInfo[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== "import_declaration") continue;

    // Go's import_declaration wraps: single import_spec, or import_spec_list (grouped)
    for (let j = 0; j < child.namedChildCount; j++) {
      const spec = child.namedChild(j);
      if (!spec) continue;

      // Grouped imports: import_spec_list contains import_spec children
      if (spec.type === "import_spec_list") {
        for (let k = 0; k < spec.namedChildCount; k++) {
          const innerSpec = spec.namedChild(k);
          if (!innerSpec || innerSpec.type !== "import_spec") continue;
          const result = extractGoImportSpec(innerSpec, source);
          if (result) results.push(result);
        }
      } else if (spec.type === "import_spec") {
        const result = extractGoImportSpec(spec, source);
        if (result) results.push(result);
      }
    }
  }

  return results;
}

function extractGoImportSpec(spec: Node, source: string): ImportInfo | null {
  const pathNode = spec.childForFieldName("path");
  if (!pathNode) return null;
  const sourceText = extractStringLiteral(pathNode, source);
  if (!sourceText) return null;

  const name = fieldChildText(spec, "name", source);
  return {
    source: sourceText,
    names: name ? [name] : [],
    lineNumber: spec.startPosition.row + 1,
  };
}

// ---- Rust imports ----

function extractRustImports(node: Node, source: string): ImportInfo[] {
  const results: ImportInfo[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    // use foo::bar;
    if (child.type === "use_declaration") {
      const arg = child.childForFieldName("argument");
      if (!arg) continue;

      const sourceText = source
        .slice(arg.startIndex, arg.endIndex)
        .replace(/\s+/g, " ");
      results.push({
        source: sourceText,
        names: [],
        lineNumber: child.startPosition.row + 1,
      });
    }

    // extern crate foo;
    if (child.type === "extern_crate_declaration") {
      const name = fieldChildText(child, "name", source);
      if (name) {
        results.push({
          source: name,
          names: [],
          lineNumber: child.startPosition.row + 1,
        });
      }
    }
  }

  return results;
}

// ---- Solidity imports ----

function extractSolidityImports(node: Node, source: string): ImportInfo[] {
  const results: ImportInfo[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== "import_directive") continue;

    const sourceNode = child.childForFieldName("source");
    if (!sourceNode) continue;
    const sourceText = extractStringLiteral(sourceNode, source);
    if (!sourceText) continue;

    const names: string[] = [];
    // Check for named imports: import {A, B} from "foo.sol";
    for (let j = 0; j < child.namedChildCount; j++) {
      const c = child.namedChild(j);
      if (!c) continue;
      if (c.type === "import_clause") {
        for (let k = 0; k < c.namedChildCount; k++) {
          const sym = c.namedChild(k);
          if (sym && sym.type === "symbol_alias") {
            const name = fieldChildText(sym, "name", source);
            if (name) names.push(name);
          }
        }
      }
    }

    results.push({
      source: sourceText,
      names,
      lineNumber: child.startPosition.row + 1,
    });
  }

  return results;
}

// ---- Markdown extraction ----

/**
 * Extract structural symbols from Markdown content.
 * Since Markdown doesn't use tree-sitter, we use regex-based parsing.
 * Extracts headings as symbols, with nested structure based on heading levels.
 * Code blocks are nested under their parent heading.
 */
function extractMarkdown(source: string): SymbolInfo[] {
  const lines = source.split("\n");
  // A trailing newline does not start another line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const results: SymbolInfo[] = [];

  // Track heading hierarchy for nesting
  const stack: SymbolInfo[] = [];
  const addHeading = (level: number, title: string, startLine: number): void => {
    const symbol: SymbolInfo = { name: title, type: `heading${level}`, startLine, endLine: lines.length, children: [] };
    while (stack.length > 0 && parseInt(stack[stack.length - 1].type?.replace("heading", "") || "0", 10) >= level) {
      stack.pop();
    }
    if (stack.length > 0) stack[stack.length - 1].children!.push(symbol);
    else results.push(symbol);
    stack.push(symbol);
  };

  let fence: { char: string; length: number } | null = null;
  // Whether the previous line is paragraph text that a setext underline can turn into a heading.
  let paragraph = false;
  let i = 0;

  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."));
    const first = close === -1 ? undefined : lines.slice(1, close).find((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
    if (first !== undefined && /^[A-Za-z0-9_.-]+\s*:/.test(first.trim())) i = close + 1;
  }

  for (; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      paragraph = false;
      continue;
    }

    const atx = line.match(/^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/);
    if (atx && atx[2].length > 0) {
      addHeading(atx[1].length, atx[2].trim(), i + 1);
      paragraph = false;
      continue;
    }

    const setext = paragraph ? line.match(/^ {0,3}(=+|-+)[ \t]*$/) : null;
    if (setext) {
      addHeading(setext[1][0] === "=" ? 1 : 2, lines[i - 1].trim(), i);
      paragraph = false;
      continue;
    }

    // Blank lines, indented code, quotes, list items and thematic breaks are not setext paragraph text.
    paragraph = line.trim() !== "" && !/^( {4}|\t| {0,3}(>|[-*+][ \t]|\d+[.)][ \t]|[-*_]{3,}\s*$))/.test(line);
  }

  // Update endLine for each heading: it ends just before the next sibling or parent's next sibling
  updateEndLines(results, lines.length);

  return results;
}

/** Update endLine for each heading based on next sibling or parent's next sibling. */
function updateEndLines(symbols: SymbolInfo[], totalLines: number): void {
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    
    // Default: ends at file end
    symbol.endLine = totalLines;
    
    // If there's a next sibling, this heading ends just before it
    if (i + 1 < symbols.length) {
      symbol.endLine = symbols[i + 1].startLine - 1;
    }
    
    // Recurse into children
    if (symbol.children && symbol.children.length > 0) {
      updateEndLines(symbol.children, symbol.endLine);
    }
  }
}

/**
 * Extract links from Markdown content as "imports".
 * Links to local files are considered imports.
 */
function extractMarkdownLinks(source: string): ImportInfo[] {
  const results: ImportInfo[] = [];
  const lines = source.split("\n");
  
  // Match markdown links: [text](url)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    
    while ((match = linkRegex.exec(line)) !== null) {
      const linkText = match[1];
      const url = match[2];
      
      // Skip external URLs
      if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
        continue;
      }
      
      results.push({
        source: url,
        names: [linkText],
        lineNumber: i + 1,
      });
    }
  }
  
  // Also extract import-like references: ![alt](image)
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    
    while ((match = imageRegex.exec(line)) !== null) {
      const altText = match[1] || "image";
      const url = match[2];
      
      // Skip external URLs
      if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
        continue;
      }
      
      results.push({
        source: url,
        names: [altText],
        lineNumber: i + 1,
      });
    }
  }
  
  return results;
}

// ---- Shared helpers ----

/** Extract a string literal's value (strip surrounding quotes). */
function extractStringLiteral(node: Node, source: string): string | null {
  const text = source.slice(node.startIndex, node.endIndex);
  // Handle single, double, and backtick quotes
  const match = text.match(/^['"`](.*)['"`]$/s);
  return match ? match[1] : text;
}

// ---- Re-export ImportInfo for backward compatibility ----

export type { ImportInfo };

