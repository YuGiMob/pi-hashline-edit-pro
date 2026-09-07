import { join } from "path";
import { describe, expect, it } from "vitest";
import { lineHashes } from "../../src/hashline";
import { withTempFile, setupIntegrationTest, useTestHome, getWritableTempRoot } from "../support/fixtures";

useTestHome();

describe("edit tool file mutation queue", () => {
  it("uses the same queue key for repeated edits to the same path", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", join(cwd, "sample.ts"));

      const r1 = await editTool.execute(
        "e1",
        { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["ALPHA"] },
        undefined, undefined, ctx,
      );
      expect(r1.content[0].text).toContain("Successfully replaced");
      expect(r1.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      const r2 = await editTool.execute(
        "e2",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BETA"] },
        undefined, undefined, ctx,
      );
      expect(r2.content[0].text).toContain("Successfully replaced");
      expect(r2.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it.skipIf(process.platform === "win32")("canonicalizes the queue key when a symlink points at the same file", async () => {
    await withTempFile("target.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const { ctx, editTool } = setupIntegrationTest(cwd);
      const { symlink } = await import("fs/promises");
      await symlink(cwd + "/target.ts", cwd + "/link.ts");
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", join(cwd, "target.ts"));

      const r1 = await editTool.execute(
        "e1",
        { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["ALPHA"] },
        undefined, undefined, ctx,
      );
      expect(r1.content[0].text).toContain("Successfully replaced");
      expect(r1.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
      const r2 = await editTool.execute(
        "e2",
        { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BETA"] },
        undefined, undefined, ctx,
      );
      expect(r2.content[0].text).toContain("Successfully replaced");
      expect(r2.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    });
  });

  it.skipIf(process.platform === "win32")("canonicalizes the queue key when a parent directory is a symlink", async () => {
    const { mkdtemp, mkdir, symlink, writeFile } = await import("fs/promises");
    const { join } = await import("path");
    const tmpDir = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-test-"));
    const subDir = join(tmpDir, "sub");
    await mkdir(subDir, { recursive: true });
    const filePath = join(subDir, "target.ts");
    await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf-8");
    const linkDir = join(tmpDir, "linkdir");
    await mkdir(linkDir, { recursive: true });
    await symlink(subDir, join(linkDir, "sub"));

    const { ctx, editTool } = setupIntegrationTest(tmpDir);
    const hashes = await lineHashes("alpha\nbeta\ngamma\n", filePath);

    const r1 = await editTool.execute(
      "e1",
      { remove_from: hashes[0]!, remove_to: hashes[0]!, replacement_lines: ["ALPHA"] },
      undefined, undefined, ctx,
    );
    expect(r1.content[0].text).toContain("Successfully replaced");
    expect(r1.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    const r2 = await editTool.execute(
      "e2",
      { remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BETA"] },
      undefined, undefined, ctx,
    );
    expect(r2.content[0].text).toContain("Successfully replaced");
    expect(r2.content[0].text).toContain("Added 1 line(s), removed 1 line(s).");
    const { rm } = await import("fs/promises");
    await rm(tmpDir, { recursive: true, force: true });
  });
});
