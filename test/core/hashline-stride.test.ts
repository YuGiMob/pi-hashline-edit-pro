import { describe, expect, it } from "vitest";
import {
  HASH_PROBE_STRIDE,
  HASH_SPACE,
  _lineHashesPure,
  lineHashes,
} from "../../src/hashline";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

function firstPiece(a: string): string {
  return a.slice(0, 2);
}

function piecesDiffer(a: string, b: string): boolean {
  return firstPiece(a) !== firstPiece(b);
}

describe("hash probe stride", () => {
  it("is coprime with the hash space so probing visits every index", () => {
    expect(gcd(HASH_PROBE_STRIDE, HASH_SPACE)).toBe(1);
  });

  it("keeps consecutive allocations on different piece heads", () => {
    for (const line of ["", "}"]) {
      const hashes = _lineHashesPure(Array.from({ length: 20 }, () => line).join("\n"));
      for (let i = 1; i < hashes.length; i++) {
        expect(piecesDiffer(hashes[i - 1]!, hashes[i]!)).toBe(true);
      }
    }
  });

  it("spreads blank lines through the store path", async () => {
    const content = Array.from({ length: 20 }, () => "").join("\n");
    const hashes = await lineHashes(content, home.testPath);
    for (let i = 1; i < hashes.length; i++) {
      expect(piecesDiffer(hashes[i - 1]!, hashes[i]!)).toBe(true);
    }
  });

  it("keeps blank-line hashes distinct from neighboring content lines", async () => {
    const content = [
      "const a = 1;",
      "",
      "const b = 2;",
      "",
      "const c = 3;",
    ].join("\n");
    const hashes = await lineHashes(content, home.testPath);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("continues the stride sequence for appended identical lines via stable mapping", async () => {
    const oldContent = Array.from({ length: 10 }, () => "").join("\n");
    const oldHashes = await lineHashes(oldContent, home.testPath);
    const newContent = Array.from({ length: 11 }, () => "").join("\n");
    const newHashes = await lineHashes(newContent, home.testPath, {
      content: oldContent,
      hashes: oldHashes,
    });
    for (let i = 1; i < newHashes.length; i++) {
      expect(piecesDiffer(newHashes[i - 1]!, newHashes[i]!)).toBe(true);
    }
  });
});
