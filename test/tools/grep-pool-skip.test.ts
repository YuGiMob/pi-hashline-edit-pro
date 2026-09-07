import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ANCHOR_POOL_EXHAUSTED_PREFIX } from "../../src/constants";
import { initRegistry, resetRegistryForTests } from "../../src/anchor-registry";
import { withTempFile, setupIntegrationTest, getText } from "../support/fixtures";

vi.mock("../../src/file-reader", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  tryReadNormFile: vi.fn(async () => {
    throw new Error(
      `${ANCHOR_POOL_EXHAUSTED_PREFIX}; free anchors with /clear-anchors or use write for very large files.`,
    );
  }),
}));

beforeEach(async () => {
  await initRegistry(undefined);
});

afterEach(() => {
  resetRegistryForTests();
});

describe("anchor_grep - anchor pool exhausted", () => {
  it("reports skipped files when every match is unreadable", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, getTool } = setupIntegrationTest(cwd);
      const grepTool = getTool("anchor_grep");

      const result = await grepTool.execute(
        "g1",
        { pattern: "beta", path: "sample.ts" },
        undefined,
        undefined,
        ctx,
      );
      const text = getText(result);
      expect(text).toContain("anchor pool is exhausted");
    });
  });
});
