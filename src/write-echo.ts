import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { WriteEchoMode } from "./config";
import { fmtReadPreview } from "./read";
import { splitLines } from "./utils";

export interface WriteEchoInput {
  normalized: string;
  fileHashes: string[];
  absolutePath: string;
  mode: WriteEchoMode;
}

export interface WriteEcho {
  text: string;
  servedHashes: string[];
}

function summaryText(lineCount: number): string {
  const lines = lineCount === 1 ? "1 line" : `${lineCount} lines`;
  return `${lines} written. No anchors are served after a write: read the range you want to edit.`;
}

export async function renderWriteEcho(input: WriteEchoInput): Promise<WriteEcho> {
  if (input.mode === "summary") {
    return { text: summaryText(splitLines(input.normalized).length), servedHashes: [] };
  }
  const full = await fmtReadPreview(
    input.normalized,
    {},
    input.fileHashes,
    input.absolutePath,
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
  );
  return { text: full.text, servedHashes: full.servedHashes };
}
