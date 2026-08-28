export type LineEnding = "\r\n" | "\n" | "\r";

export function detectEnding(content: string): LineEnding {
  const crIdx = content.indexOf("\r");
  const lfIdx = content.indexOf("\n");
  if (crIdx === -1 && lfIdx === -1) return "\n";
  if (crIdx === -1) return "\n";
  if (lfIdx === -1) return "\r";
  if (crIdx < lfIdx) return content[crIdx + 1] === "\n" ? "\r\n" : "\r";
  return "\n";
}

export function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreEndings(text: string, ending: LineEnding): string {
  if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
  if (ending === "\r") return text.replace(/\n/g, "\r");
  return text;
}

export function stripBOM(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}
