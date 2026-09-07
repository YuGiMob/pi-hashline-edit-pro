import { join } from "path";
import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome } from "../support/fixtures";

useTestHome();

describe("details.metrics surface (Phase 2 C - host-only observability)", () => {
  it("changed-mode edit reports applied classification + edits_attempted", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BETA"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.classification).toBe("applied");
      expect(result.details.metrics.edits_attempted).toBe(1);
    });
  });

  it("noop edit reports classification noop and edits_noop count", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["beta"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.classification).toBe("noop");
      expect(result.details.metrics.edits_noop).toBe(1);
    });
  });

  it("hash-anchored replace records a single edit in metrics", async () => {
    await withTempFile("sample.ts", "one\ntwo\nthree\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("one\ntwo\nthree\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["TWO"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.edits_attempted).toBe(1);
    });
  });

  it("noop edit reports warnings count in metrics", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\n", join(cwd, "sample.ts"));

      const result = await editTool.execute(
        "e1",
        {
          remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["beta"],
        },
        undefined,
        undefined,
        ctx,
      );
      expect(result.details.metrics.warnings).toBe(0);
    });
  });
});
