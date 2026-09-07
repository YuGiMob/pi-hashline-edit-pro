import { describe, expect, it } from "vitest";
import { servedHashesFromDiff } from "../../src/served";

describe("servedHashesFromDiff", () => {
  it("extracts anchors from context and added rows", () => {
    const diff = [" aaaa│kept", "-bbbb│removed", "+cccc│added", "not a row", " dddd│kept2"].join("\n");
    expect(servedHashesFromDiff(diff)).toEqual(["aaaa", "cccc", "dddd"]);
  });

  it("ignores removed rows and non-row lines", () => {
    expect(servedHashesFromDiff("-bbbb│removed\nplain\n+++header")).toEqual([]);
  });

  it("returns empty for a diff without rows", () => {
    expect(servedHashesFromDiff("no rows here")).toEqual([]);
    expect(servedHashesFromDiff("")).toEqual([]);
  });
});
