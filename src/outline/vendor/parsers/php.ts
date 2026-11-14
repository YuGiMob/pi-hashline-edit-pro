import type { Node } from "web-tree-sitter";
import type { SymbolInfo } from "../types.ts";

const PHP_TYPE_LABELS: Record<string, string> = {
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
  enum_declaration: "enum",
};

function textOf(node: Node, source: string): string {
  return source.slice(node.startIndex, node.endIndex);
}

const PHP_SKIPPED_TYPES = new Set(["attribute_list", "comment"]);

function firstDeclaredTokenRow(node: Node): number | undefined {
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index);
    if (child === null || PHP_SKIPPED_TYPES.has(child.type)) continue;
    return child.startPosition.row + 1;
  }
  return undefined;
}

function rangeOf(node: Node): [number, number] {
  return [firstDeclaredTokenRow(node) ?? node.startPosition.row + 1, node.endPosition.row + 1];
}

function findChild(node: Node, type: string): Node | undefined {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child !== null && child.type === type) return child;
  }
  return undefined;
}

function nameOf(node: Node, source: string): string {
  const name = findChild(node, "name");
  return name === undefined ? "<unknown>" : textOf(name, source);
}

function extractMethod(node: Node, source: string): SymbolInfo {
  const [startLine, endLine] = rangeOf(node);
  return {
    name: node.childForFieldName("name")?.text ?? "<unknown>",
    type: "method",
    startLine,
    endLine,
  };
}

function extractFunction(node: Node, source: string): SymbolInfo {
  const [startLine, endLine] = rangeOf(node);
  return {
    name: node.childForFieldName("name")?.text ?? "<unknown>",
    type: "function",
    startLine,
    endLine,
  };
}

function extractProperties(node: Node, source: string): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const declarationStart = firstDeclaredTokenRow(node) ?? node.startPosition.row + 1;
  for (let i = 0; i < node.namedChildCount; i++) {
    const element = node.namedChild(i);
    if (element === null || element.type !== "property_element") continue;
    const [elementStart, endLine] = rangeOf(element);
    const startLine = results.length === 0 ? Math.min(declarationStart, elementStart) : elementStart;
    results.push({
      name: element.childForFieldName("name")?.text ?? "<unknown>",
      type: "property",
      startLine,
      endLine,
    });
  }
  return results;
}

function extractConstants(node: Node, source: string): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const declarationStart = firstDeclaredTokenRow(node) ?? node.startPosition.row + 1;
  for (let i = 0; i < node.namedChildCount; i++) {
    const element = node.namedChild(i);
    if (element === null || element.type !== "const_element") continue;
    const [elementStart, endLine] = rangeOf(element);
    const startLine = results.length === 0 ? Math.min(declarationStart, elementStart) : elementStart;
    results.push({
      name: nameOf(element, source),
      type: "const",
      startLine,
      endLine,
    });
  }
  return results;
}

function extractEnumCase(node: Node, source: string): SymbolInfo {
  const [startLine, endLine] = rangeOf(node);
  return {
    name: node.childForFieldName("name")?.text ?? "<unknown>",
    type: "case",
    startLine,
    endLine,
  };
}

function extractMembers(body: Node, source: string): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (child === null) continue;
    switch (child.type) {
      case "method_declaration":
        results.push(extractMethod(child, source));
        break;
      case "property_declaration":
        results.push(...extractProperties(child, source));
        break;
      case "const_declaration":
        results.push(...extractConstants(child, source));
        break;
      case "enum_case":
        results.push(extractEnumCase(child, source));
        break;
      default:
        break;
    }
  }
  return results;
}

function extractTypeDeclaration(node: Node, source: string, depth: number, maxDepth: number): SymbolInfo {
  const [startLine, endLine] = rangeOf(node);
  const symbol: SymbolInfo = {
    name: node.childForFieldName("name")?.text ?? "<unknown>",
    type: PHP_TYPE_LABELS[node.type] ?? "class",
    startLine,
    endLine,
  };
  if (depth < maxDepth) {
    const body = findChild(node, "declaration_list") ?? findChild(node, "enum_declaration_list");
    if (body !== undefined) {
      const children = extractMembers(body, source);
      if (children.length > 0) symbol.children = children;
    }
  }
  return symbol;
}

function extractAssignedFunction(statement: Node, source: string): SymbolInfo | null {
  for (let i = 0; i < statement.namedChildCount; i++) {
    const expression = statement.namedChild(i);
    if (expression === null || expression.type !== "assignment_expression") continue;
    const target = expression.namedChild(0);
    const value = expression.namedChild(expression.namedChildCount - 1);
    if (target === null || value === null) continue;
    if (value.type !== "anonymous_function" && value.type !== "arrow_function") continue;
    const [startLine, endLine] = rangeOf(expression);
    return {
      name: textOf(target, source),
      type: value.type === "arrow_function" ? "arrow_function" : "function",
      startLine,
      endLine,
    };
  }
  return null;
}

const TEST_CALLEES = new Set(["describe", "test", "it"]);

function unquote(text: string): string | undefined {
  const trimmed = text.trim();
  const quoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')));
  return quoted ? trimmed.slice(1, -1) : undefined;
}

function unwrapTestCall(node: Node): Node | undefined {
  if (node.type === "function_call_expression") return node;
  if (node.type === "member_call_expression" || node.type === "nullsafe_member_call_expression") {
    const object = node.childForFieldName("object");
    return object === null ? undefined : unwrapTestCall(object);
  }
  return undefined;
}

function firstStringArgument(args: Node, source: string): string | undefined {
  const argument = args.namedChild(0);
  if (argument === null) return undefined;
  const value = argument.namedChild(0);
  if (value === null || value.type !== "string") return undefined;
  return unquote(textOf(value, source));
}

function testCallSymbol(statement: Node, source: string): SymbolInfo | null {
  const expression = statement.namedChild(0);
  if (expression === null) return null;
  const call = unwrapTestCall(expression);
  if (call === undefined) return null;
  const callee = call.childForFieldName("function");
  const args = call.childForFieldName("arguments");
  if (callee === null || args === null) return null;
  const label = textOf(callee, source);
  if (!TEST_CALLEES.has(label)) return null;
  const name = firstStringArgument(args, source);
  if (name === undefined) return null;
  const [startLine, endLine] = rangeOf(statement);
  const symbol: SymbolInfo = { name, type: label, startLine, endLine };
  const children = extractNestedTestCalls(call, source);
  if (children.length > 0) symbol.children = children;
  return symbol;
}

function extractNestedTestCalls(call: Node, source: string): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const args = call.childForFieldName("arguments");
  if (args === null) return results;
  for (let i = 0; i < args.namedChildCount; i++) {
    const argument = args.namedChild(i);
    if (argument === null) continue;
    const value = argument.namedChild(0);
    if (value === null || value.type !== "anonymous_function") continue;
    const body = value.childForFieldName("body");
    if (body === null) continue;
    for (let j = 0; j < body.namedChildCount; j++) {
      const statement = body.namedChild(j);
      if (statement === null || statement.type !== "expression_statement") continue;
      const nested = testCallSymbol(statement, source);
      if (nested !== null) results.push(nested);
    }
  }
  return results;
}

export function extractPhp(node: Node, source: string, depth: number): SymbolInfo[] {
  const results: SymbolInfo[] = [];
  const maxDepth = depth + 10;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child === null) continue;
    switch (child.type) {
      case "class_declaration":
      case "interface_declaration":
      case "trait_declaration":
      case "enum_declaration":
        results.push(extractTypeDeclaration(child, source, depth, maxDepth));
        break;
      case "function_definition":
        results.push(extractFunction(child, source));
        break;
      case "const_declaration":
        results.push(...extractConstants(child, source));
        break;
      case "expression_statement": {
        const nested = extractAssignedFunction(child, source) ?? testCallSymbol(child, source);
        if (nested !== null) results.push(nested);
        break;
      }
      default:
        break;
    }
  }
  return results;
}
