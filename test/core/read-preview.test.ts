import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { fmtReadPreview } from "../../src/read";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("fmtReadPreview", () => {
  it("returns empty file marker for empty content", async () => {
    const result = await fmtReadPreview("", {}, undefined, home.testPath);
    expect(result.text).toContain("[File is empty. Use replace to insert content.]");
  });

  it("returns empty file marker for content with only newline", async () => {
    const result = await fmtReadPreview("\n", {}, undefined, home.testPath);
    expect(result.text).toMatch(/^[A-Za-z0-9]{4}│$/);
  });

  it("returns all lines when no offset or limit given", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", {}, undefined, home.testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).toContain("│c");
  });

  it("respects offset parameter", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { offset: 2 }, undefined, home.testPath);
    expect(result.text).toContain("│b");
    expect(result.text).toContain("│c");
    expect(result.text).not.toContain("│a");
  });

  it("respects limit parameter", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { limit: 2 }, undefined, home.testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│c");
  });

  it("shows pagination hint when limit is less than total lines", async () => {
    const result = await fmtReadPreview("a\nb\nc\n", { limit: 2 }, undefined, home.testPath);
    expect(result.text).toContain("[Showing lines 1-2 of 3. Use offset=3 to continue.]");
  });

  it("shows pagination hint when offset is beyond start", async () => {
    const result = await fmtReadPreview("a\nb\nc\nd\n", { offset: 2, limit: 2 }, undefined, home.testPath);
    expect(result.text).toContain("[Showing lines 2-3 of 4. Use offset=4 to continue.]");
  });

  it("rejects non-positive offset", async () => {
    await expect(fmtReadPreview("a\nb\nc\n", { offset: 0 } as any, undefined, home.testPath)).rejects.toThrow("positive integer");
  });

  it("rejects non-positive limit", async () => {
    await expect(fmtReadPreview("a\nb\nc\n", { limit: 0 } as any, undefined, home.testPath)).rejects.toThrow("positive integer");
  });

  it("uses precomputed hashes when provided", async () => {
    const hashes = ["ATIm", "BeSR", "DAfo"];
    const result = await fmtReadPreview("a\nb\nc\n", {}, hashes, home.testPath);
    expect(result.text).toContain("ATIm│a");
    expect(result.text).toContain("BeSR│b");
    expect(result.text).toContain("DAfo│c");
  });

  it("skips an oversized first line and shows the rest with a bash fallback (auto-read budget)", async () => {
    const big = "X".repeat(60_000);
    const result = await fmtReadPreview(`${big}\na\nb\n`, {}, undefined, home.testPath, DEFAULT_MAX_BYTES);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│X");
    expect(result.text).toMatch(/\[Line 1 is .*exceeds 50\.0KB; content not shown\. Use bash: sed -n '1p' <path> \| head -c \d+\]/);
    expect(result.text).toContain("Inspect with bash: sed -n '1p' <path>");
  });

  it("marks an oversized middle line while keeping its neighbors hashable (auto-read budget)", async () => {
    const big = "Y".repeat(60_000);
    const result = await fmtReadPreview(`a\n${big}\nc\n`, {}, undefined, home.testPath, DEFAULT_MAX_BYTES);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│c");
    expect(result.text).not.toContain("│Y");
    expect(result.text).toContain("[Line 2 is");
  });

  it("returns only the marker row when every line is oversized (auto-read budget)", async () => {
    const big = "Z".repeat(60_000);
    const result = await fmtReadPreview(`${big}\n`, {}, undefined, home.testPath, DEFAULT_MAX_BYTES);
    expect(result.text).toMatch(/^[A-Za-z0-9]{4}│\[Line 1 is .*exceeds 50\.0KB/);
    expect(result.text).toContain("sed -n '1p'");
    expect(result.servedHashes).toHaveLength(1);
    expect(result.nextOffset).toBeUndefined();
  });

  it("offers continuation past a skipped oversized line", async () => {
    const big = "W".repeat(210_000);
    const content = ["a", big, "b", "c", "d", "e"].join("\n");
    const result = await fmtReadPreview(content, { limit: 3 }, undefined, home.testPath);
    expect(result.text).toContain("│a");
    expect(result.text).toContain("│b");
    expect(result.text).not.toContain("│W");
    expect(result.text).toContain("[Line 2 is");
    expect(result.nextOffset).toBe(4);
    expect(result.text).toContain("[Showing lines 1-3 of 6. Use offset=4 to continue.]");
  });

  it("marks a 60KB line with a hash-anchored marker by default", async () => {
    const big = "V".repeat(60_000);
    const result = await fmtReadPreview(`${big}\nb\n`, {}, undefined, home.testPath);
    expect(result.text).toMatch(/^[A-Za-z0-9]{4}│\[Line 1 is .*exceeds 50\.0KB/);
    expect(result.text).not.toContain("│V");
    expect(result.text).toContain("│b");
    expect(result.servedHashes).toHaveLength(2);
  });

  it("shows a line just under 50KB in full by default", async () => {
    const big = "U".repeat(50_000);
    const result = await fmtReadPreview(`${big}\n`, {}, undefined, home.testPath);
    expect(result.text).toMatch(new RegExp(`^[A-Za-z0-9]{4}│U{50000}$`));
    expect(result.text).not.toContain("content not shown");
  });

  it("marks lines over 50KB by default with a hash-anchored marker", async () => {
    const big = "T".repeat(210_000);
    const result = await fmtReadPreview(`${big}\n`, {}, undefined, home.testPath);
    expect(result.text).toMatch(/^[A-Za-z0-9]{4}│\[Line 1 is .*exceeds 50\.0KB/);
    expect(result.text).toContain("sed -n '1p'");
    expect(result.text).toContain("head -c 51200");
    expect(result.servedHashes).toHaveLength(1);
    expect(result.nextOffset).toBeUndefined();
  });
});

describe("fmtReadPreview - oversized marker truncation", () => {
  it("continues past a truncated marker list without skipping hidden rows", async () => {
    const big1 = "X".repeat(1000);
    const big2 = "Y".repeat(1000);
    const content = `a\n${big1}\n${big2}\nb\n`;
    const budget = 130;

    const first = await fmtReadPreview(content, {}, undefined, home.testPath, budget);
    expect(first.text).toContain("│a");
    expect(first.text).toContain("[Line 2 is");
    expect(first.text).not.toContain("│b");
    expect(first.text).not.toContain("Line 3");
    expect(first.text).toContain("Use offset=3 to continue");
    expect(first.nextOffset).toBe(3);

    const second = await fmtReadPreview(content, { offset: 3 }, undefined, home.testPath, budget);
    expect(second.text).toContain("[Line 3 is");
    expect(second.text).toContain("│b");
    expect(second.nextOffset).toBeUndefined();
  });
});

describe("fmtReadPreview - oversized warning cap", () => {
  it("caps the oversized-line warning enumeration at 100 entries", async () => {
    const big = "Z".repeat(60_000);
    const content = Array.from({ length: 150 }, () => big).join("\n") + "\n";
    const result = await fmtReadPreview(content, {}, undefined, home.testPath, DEFAULT_MAX_BYTES);
    expect(result.text).toContain("1, 2, 3");
    expect(result.text).toContain("(+50 more)");
    expect(result.text).toContain("sed -n '1p;2p;3p");
    expect(result.text).toContain(";100p' <path>");
    expect(result.text).not.toContain(";101p' <path>");
    expect(result.text).toContain("Use read with offset");
    expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThan(50 * 1024);
  });
});

describe("fmtReadPreview - maxTruncLines budget", () => {
  it("caps truncated output lines via maxTruncLines", async () => {
    const content = ["l1", "l2", "l3", "l4", "l5"].join("\n") + "\n";
    const result = await fmtReadPreview(content, {}, undefined, home.testPath, undefined, 3);
    expect(result.text).toContain("│l1");
    expect(result.text).toContain("│l3");
    expect(result.text).not.toContain("│l4");
    expect(result.text).toContain("[Showing lines 1-3 of 5. Use offset=4 to continue.]");
    expect(result.nextOffset).toBe(4);
  });

  it("caps oversized-marker rows via maxTruncLines with continuation", async () => {
    const big = "X".repeat(60_000);
    const content = `${big}\n${big}\n${big}\nb\n`;
    const result = await fmtReadPreview(content, {}, undefined, home.testPath, DEFAULT_MAX_BYTES, 2);
    expect(result.text).toContain("[Line 1 is");
    expect(result.text).toContain("[Line 2 is");
    expect(result.text).not.toContain("[Line 3 is");
    expect(result.text).not.toContain("│b");
    expect(result.text).toContain("[Showing lines 1-2 of 4 (50.0KB limit). Use offset=3 to continue.]");
    expect(result.nextOffset).toBe(3);
  });
});
