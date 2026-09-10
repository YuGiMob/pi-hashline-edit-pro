import { readFileSync } from "node:fs";

export function loadP(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8").trim();
}

export function loadGuide(relativePath: string): string[] {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}
