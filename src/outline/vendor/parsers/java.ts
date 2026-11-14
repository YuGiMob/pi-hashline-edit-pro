/**
 * Java tree-sitter symbol extractor.
 *
 * Tree-sitter grammar: tree-sitter-java (https://github.com/tree-sitter/tree-sitter-java)
 * The official tree-sitter Java grammar, maintained by the tree-sitter core team.
 * Supports modern Java up to Java 21 (records, sealed types, pattern matching,
 * switch expressions, text blocks).
 */

import type { Node } from "web-tree-sitter";
import type { SymbolInfo, ImportInfo } from "../types.ts";

/**
 * Extract structural symbols from Java source code.
 */
export function extractJava(
  node: Node,
  source: string,
  depth: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const MAX_DEPTH = depth + 10;

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    const symbol = extractJavaType(child, source, depth, MAX_DEPTH);
    if (symbol) results.push(symbol);
  }

  return results;
}

const JAVA_TYPE_LABELS: Record<string, string> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation",
};

function fieldText(node: Node, field: string, source: string): string | undefined {
  const child = node.childForFieldName(field);
  return child === null ? undefined : source.slice(child.startIndex, child.endIndex);
}

function childText(node: Node, childType: string, source: string): string | undefined {
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index);
    if (child !== null && child.type === childType) return source.slice(child.startIndex, child.endIndex);
  }
  return undefined;
}

const JAVA_SKIPPED_TYPES = new Set(["annotation", "marker_annotation", "comment", "line_comment", "block_comment"]);

function firstDeclaredTokenRow(node: Node): number | undefined {
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child === null || JAVA_SKIPPED_TYPES.has(child.type)) continue;
    if (child.type === "modifiers") {
      for (let tokenIndex = 0; tokenIndex < child.childCount; tokenIndex++) {
        const token = child.child(tokenIndex);
        if (token === null || JAVA_SKIPPED_TYPES.has(token.type)) continue;
        return token.startPosition.row + 1;
      }
      continue;
    }
    return child.startPosition.row + 1;
  }
  return undefined;
}

function declarationLine(node: Node): number {
  return firstDeclaredTokenRow(node) ?? node.startPosition.row + 1;
}

function extractJavaType(
  node: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
): SymbolInfo | null {
  if (JAVA_TYPE_LABELS[node.type] === undefined) return null;
  return extractJavaTypeDeclaration(node, source, depth, MAX_DEPTH);
}

function extractJavaTypeDeclaration(
  node: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
): SymbolInfo {
  const symbol: SymbolInfo = {
    name: fieldText(node, "name", source) ?? "<unknown>",
    type: JAVA_TYPE_LABELS[node.type] ?? "class",
    startLine: declarationLine(node),
    endLine: node.endPosition.row + 1,
  };

  if (depth < MAX_DEPTH) {
    const body = findClassBody(node);
    if (body !== null) {
      const children = extractJavaClassBody(body, source, depth + 1, MAX_DEPTH);
      if (children.length > 0) symbol.children = children;
    }
  }

  return symbol;
}

function findClassBody(node: Node): Node | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child === null) continue;
    if (
      child.type === "class_body" ||
      child.type === "enum_body" ||
      child.type === "interface_body" ||
      child.type === "annotation_type_body"
    ) {
      return child;
    }
  }
  return null;
}

function extractJavaClassBody(
  body: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];

  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child === null) continue;
    results.push(...extractJavaMember(child, source, depth, MAX_DEPTH));
  }

  return results;
}

function extractJavaMember(
  node: Node,
  source: string,
  depth: number,
  MAX_DEPTH: number,
): SymbolInfo[] {
  switch (node.type) {
    case "method_declaration":
      return [extractJavaMethod(node, source)];
    case "constructor_declaration":
    case "compact_constructor_declaration":
      return [extractJavaConstructor(node, source)];
    case "field_declaration":
    case "constant_declaration":
      return extractJavaFields(node, source);
    case "class_declaration":
    case "interface_declaration":
    case "enum_declaration":
    case "record_declaration":
    case "annotation_type_declaration":
      return [extractJavaTypeDeclaration(node, source, depth, MAX_DEPTH)];
    case "enum_constant":
      return [extractJavaEnumConstant(node, source)];
    case "annotation_type_element_declaration":
      return [extractJavaAnnotationElement(node, source)];
    case "enum_body_declarations":
      return extractJavaClassBody(node, source, depth, MAX_DEPTH);
    case "static_initializer":
      return [{
        name: "static",
        type: "static_initializer",
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      }];
    default:
      return [];
  }
}

function extractJavaMethod(
  node: Node,
  source: string,
): SymbolInfo {
  return {
    name: fieldText(node, "name", source) ?? "<unknown>",
    type: "method",
    startLine: declarationLine(node),
    endLine: node.endPosition.row + 1,
  };
}

function extractJavaConstructor(
  node: Node,
  source: string,
): SymbolInfo {
  return {
    name: fieldText(node, "name", source) ?? childText(node, "identifier", source) ?? "<unknown>",
    type: "constructor",
    startLine: declarationLine(node),
    endLine: node.endPosition.row + 1,
  };
}

function extractJavaFields(
  node: Node,
  source: string,
): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const fieldStartLine = declarationLine(node);

  for (let i = 0; i < node.namedChildCount; i++) {
    const declarator = node.namedChild(i);
    if (declarator === null || declarator.type !== "variable_declarator") continue;

    const declaratorStartLine = declarationLine(declarator);
    results.push({
      name: fieldText(declarator, "name", source) ?? "<unknown>",
      type: "field",
      startLine: results.length === 0 ? Math.min(fieldStartLine, declaratorStartLine) : declaratorStartLine,
      endLine: declarator.endPosition.row + 1,
    });
  }

  return results;
}

function extractJavaEnumConstant(
  node: Node,
  source: string,
): SymbolInfo {
  return {
    name: fieldText(node, "name", source) ?? "<unknown>",
    type: "enum_constant",
    startLine: declarationLine(node),
    endLine: node.endPosition.row + 1,
  };
}

function extractJavaAnnotationElement(
  node: Node,
  source: string,
): SymbolInfo {
  return {
    name: fieldText(node, "name", source) ?? "<unknown>",
    type: "element",
    startLine: declarationLine(node),
    endLine: node.endPosition.row + 1,
  };
}

function importIsStatic(declaration: string): boolean {
  const withoutComments = declaration.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  return /^\s*import\s+static\b/.test(withoutComments);
}

/**
 * Extract Java imports.
 */

export function extractJavaImports(
  node: Node,
  source: string,
): ImportInfo[] {
  const results: ImportInfo[] = [];

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;

    if (child.type === "import_declaration") {
      let importSource = "";
      const isStatic = importIsStatic(source.slice(child.startIndex, child.endIndex));
      let isWildcard = false;

      for (let j = 0; j < child.namedChildCount; j++) {
        const c = child.namedChild(j);
        if (!c) continue;

        if (c.type === "asterisk") {
          isWildcard = true;
        } else if (c.type === "scoped_identifier" || c.type === "identifier") {
          importSource = source.slice(c.startIndex, c.endIndex);
        }
      }

      // Build the full import path
      let fullPath = importSource;
      if (isWildcard) {
        fullPath += ".*";
      }

      // Extract the last segment as the imported name
      const names: string[] = [];
      if (!isWildcard) {
        const parts = importSource.split(".");
        const lastName = parts[parts.length - 1];
        if (lastName) names.push(lastName);
      }

      results.push({
        source: isStatic ? "static " + fullPath : fullPath,
        names,
        lineNumber: child.startPosition.row + 1,
      });
    }
  }

  return results;
}
