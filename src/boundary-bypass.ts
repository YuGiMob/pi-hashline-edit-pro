import { parseText } from "./hashline/parse";
import { ANCHOR_ROW_RE } from "./hashline/resolve";
import { stripRowPrefix } from "./hashline/hash";

function canonRef(ref: string): string {
  const trimmed = ref.trim();
  const match = trimmed.match(ANCHOR_ROW_RE);
  return match ? match[2]! : trimmed;
}

function canonLines(lines: string[]): string[] {
  return parseText(lines).map((line) => stripRowPrefix(line).text);
}

const boundaryBypassTracker = new Map<string, string>();
const BOUNDARY_BYPASS_LIMIT = 256;

export function noopPayloadKey(
  absolutePath: string,
  removeFrom: string,
  removeTo: string,
  replacementLines: string[],
): string {
  return JSON.stringify([
    absolutePath,
    canonRef(removeFrom),
    canonRef(removeTo),
    canonLines(replacementLines),
  ]);
}

export function markBoundaryNoop(absolutePath: string, payload: string): void {
  boundaryBypassTracker.delete(absolutePath);
  boundaryBypassTracker.set(absolutePath, payload);
  if (boundaryBypassTracker.size > BOUNDARY_BYPASS_LIMIT) {
    const oldest = boundaryBypassTracker.keys().next().value;
    if (oldest !== undefined) boundaryBypassTracker.delete(oldest);
  }
}

export function consumeBoundaryBypass(absolutePath: string, payload: string): boolean {
  if (boundaryBypassTracker.get(absolutePath) === payload) {
    boundaryBypassTracker.delete(absolutePath);
    return true;
  }
  return false;
}

export function clearBoundaryBypass(absolutePath: string): void {
  boundaryBypassTracker.delete(absolutePath);
}
