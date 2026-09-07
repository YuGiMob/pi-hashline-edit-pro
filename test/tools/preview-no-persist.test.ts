import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { lineHashes } from "../../src/hashline";
import { compPreview } from "../../src/replace";
import { loadHashStore, getSnapshot } from "../../src/hash-store";
import { hashStorePath } from "../../src/paths";
import { withTempFile } from "../support/fixtures";

describe("compPreview no-persist guarantee", () => {

  it("does not persist hypothetical result to hash store", async () => {
    const content = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../src/fs-write")).resolveTarget(
        await (await import("../../src/paths")).toCwd("sample.txt", cwd)
      );

      const hashes = await lineHashes(content, absolutePath);

      const storeBefore = await loadHashStore();
      const beforeHashes = getSnapshot(storeBefore, absolutePath, content);
      expect(beforeHashes).toBeDefined();
      expect(beforeHashes).toEqual(hashes);
      const bHash = hashes[1]!;
      const cHash = hashes[2]!;

      const preview = await compPreview(
        {
          remove_from: bHash, remove_to: cHash,
          replacement_lines: ["B"],
        },
        cwd,
      );
      expect(preview).toHaveProperty("diff");

      const storeAfter = await loadHashStore();
      const afterHashes = getSnapshot(storeAfter, absolutePath, content);
      expect(afterHashes).toBeDefined();
      expect(afterHashes).toEqual(hashes);
    });
  });

  it("does not leave hypothetical snapshot behind after abandoned preview", async () => {
    const content = "a\nb\nc\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../src/fs-write")).resolveTarget(
        await (await import("../../src/paths")).toCwd("sample.txt", cwd)
      );

      const hashes = await lineHashes(content, absolutePath);

      await compPreview(
        {
          remove_from: hashes[1]!, remove_to: hashes[2]!,
          replacement_lines: ["X", "Y"],
        },
        cwd,
      );

      const store = await loadHashStore();
      expect(getSnapshot(store, absolutePath, content)).toEqual(hashes);
    });
  });

  it("does not invalidate anchors that were valid before preview", async () => {
    const content = "a\nb\nc\nb\nd\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../src/fs-write")).resolveTarget(
        await (await import("../../src/paths")).toCwd("sample.txt", cwd)
      );

      const hashes = await lineHashes(content, absolutePath);

      const preview = await compPreview(
        {
          remove_from: hashes[0]!, remove_to: hashes[2]!,
          replacement_lines: ["x"],
        },
        cwd,
      );
      expect(preview).toHaveProperty("diff");

      const freshHashes = await lineHashes(content, absolutePath);
      expect(freshHashes).toEqual(hashes);
    });
  });

  it("does not delete a corrupt snapshot row during preview", async () => {
    const content = "a\nb\nc\n";
    await withTempFile("sample.txt", content, async ({ cwd }) => {
      const absolutePath = await (await import("../../src/fs-write")).resolveTarget(
        await (await import("../../src/paths")).toCwd("sample.txt", cwd)
      );
      const hashes = await lineHashes(content, absolutePath);
      const db = new DatabaseSync(hashStorePath(), { defensive: false } as any);
      db.prepare("UPDATE snapshots SET hashes = ? WHERE path = ?").run('["ZZ", "ZZZZ"]', absolutePath);
      db.close();

      const preview = await compPreview(
        {
          remove_from: hashes[0]!, remove_to: hashes[1]!,
          replacement_lines: ["X"],
        },
        cwd,
      );
      expect(preview).toHaveProperty("diff");

      const check = new DatabaseSync(hashStorePath(), { defensive: false } as any);
      const remaining = check.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE path = ?").get(absolutePath) as { n: number };
      check.close();
      expect(remaining.n).toBe(1);
    });
  });
});
