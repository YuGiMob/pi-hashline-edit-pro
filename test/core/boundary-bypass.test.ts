import { describe, expect, it, beforeEach } from "vitest";
import {
  noopPayloadKey,
  markBoundaryNoop,
  consumeBoundaryBypass,
  clearBoundaryBypass,
} from "../../src/boundary-bypass";

const P = "/tmp/boundary-bypass-test/a.ts";
const OTHER = "/tmp/boundary-bypass-test/b.ts";

describe("noopPayloadKey", () => {
  it("distinguishes paths, anchors, and replacement lines", () => {
    const base = { removeFrom: "BeSR", removeTo: "BeSR", replacementLines: ["b"] };
    expect(noopPayloadKey("/a.ts", "BeSR", "BeSR", ["b"])).toBe(
      JSON.stringify(["/a.ts", "BeSR", "BeSR", ["b"]]),
    );
    expect(noopPayloadKey("/b.ts", base.removeFrom, base.removeTo, base.replacementLines)).not.toBe(
      noopPayloadKey("/a.ts", base.removeFrom, base.removeTo, base.replacementLines),
    );
    expect(noopPayloadKey("/a.ts", "DAfo", base.removeTo, base.replacementLines)).not.toBe(
      noopPayloadKey("/a.ts", base.removeFrom, base.removeTo, base.replacementLines),
    );
    expect(noopPayloadKey("/a.ts", base.removeFrom, base.removeTo, ["x"])).not.toBe(
      noopPayloadKey("/a.ts", base.removeFrom, base.removeTo, base.replacementLines),
    );
  });
});

describe("boundary noop bypass", () => {
  beforeEach(() => clearBoundaryBypass(P));

  it("consumes the bypass once for the matching payload", () => {
    const payload = noopPayloadKey(P, "BeSR", "BeSR", ["b"]);
    markBoundaryNoop(P, payload);
    expect(consumeBoundaryBypass(P, payload)).toBe(true);
    expect(consumeBoundaryBypass(P, payload)).toBe(false);
  });

  it("does not consume the bypass for another payload", () => {
    const payload = noopPayloadKey(P, "BeSR", "BeSR", ["b"]);
    const other = noopPayloadKey(P, "DAfo", "DAfo", ["c"]);
    markBoundaryNoop(P, payload);
    expect(consumeBoundaryBypass(P, other)).toBe(false);
    expect(consumeBoundaryBypass(P, payload)).toBe(true);
  });

  it("keeps the bypass per path", () => {
    const payload = noopPayloadKey(P, "BeSR", "BeSR", ["b"]);
    markBoundaryNoop(P, payload);
    expect(consumeBoundaryBypass(OTHER, payload)).toBe(false);
    expect(consumeBoundaryBypass(P, payload)).toBe(true);
  });

  it("overwrites a pending bypass when a newer boundary noop arms it", () => {
    const first = noopPayloadKey(P, "BeSR", "BeSR", ["b"]);
    const second = noopPayloadKey(P, "DAfo", "DAfo", ["c"]);
    markBoundaryNoop(P, first);
    markBoundaryNoop(P, second);
    expect(consumeBoundaryBypass(P, first)).toBe(false);
    expect(consumeBoundaryBypass(P, second)).toBe(true);
  });

  it("clears the bypass with clearBoundaryBypass", () => {
    const payload = noopPayloadKey(P, "BeSR", "BeSR", ["b"]);
    markBoundaryNoop(P, payload);
    clearBoundaryBypass(P);
    expect(consumeBoundaryBypass(P, payload)).toBe(false);
  });
});

describe("noopPayloadKey canonicalization", () => {
  it("normalizes anchor whitespace and copied prefixes", () => {
    const bare = noopPayloadKey(P, "ATIm", "cD4", ["x"]);
    expect(noopPayloadKey(P, " ATIm ", "cD4", ["x"])).toBe(bare);
    expect(noopPayloadKey(P, "ATIm│alpha", "cD4", ["x"])).toBe(bare);
    expect(noopPayloadKey(P, "+ATIm│alpha", "cD4", ["x"])).toBe(bare);
    expect(noopPayloadKey(P, "-ATIm│alpha", "cD4", ["x"])).toBe(bare);
  });

  it("normalizes replacement line boundaries and copied prefixes", () => {
    const base = noopPayloadKey(P, "ATIm", "cD4", ["  x", "y"]);
    expect(noopPayloadKey(P, "ATIm", "cD4", ["  x\ny"])).toBe(base);
    expect(noopPayloadKey(P, "ATIm", "cD4", ["  x\r\ny"])).toBe(base);
    expect(noopPayloadKey(P, "ATIm", "cD4", ["ATIm│  x", "y"])).toBe(base);
    expect(noopPayloadKey(P, "ATIm", "cD4", ["+ATIm│  x", "y"])).toBe(base);
    expect(noopPayloadKey(P, "ATIm", "cD4", ["-ATIm│  x", "y"])).toBe(base);
    expect(noopPayloadKey(P, "ATIm", "cD4", ["-    │  x", "y"])).toBe(base);
  });

  it("keeps meaningful blank lines distinct", () => {
    expect(noopPayloadKey(P, "ATIm", "cD4", ["a", ""])).not.toBe(
      noopPayloadKey(P, "ATIm", "cD4", ["a"]),
    );
  });

  it("keeps genuinely different edits distinct", () => {
    expect(noopPayloadKey(P, "ATIm", "cD4", ["x"])).not.toBe(
      noopPayloadKey(P, "ATIm", "cD4", ["y"]),
    );
    expect(noopPayloadKey(P, "ATIm", "cD4", ["x"])).not.toBe(
      noopPayloadKey(P, "cC4", "cD4", ["x"]),
    );
  });
});
