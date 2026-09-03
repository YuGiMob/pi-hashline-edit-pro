import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { saveUndo, getUndo, clearUndo } from "../../src/replace-undo";
import { shutdownHashStore } from "../../src/hash-store";
import * as hashStoreModule from "../../src/hash-store";
import { hashStorePath } from "../../src/paths";
import { useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("undo-store", () => {
  it("round-trips a single entry", async () => {
    await saveUndo(home.testPath, {
      content: "hello\nworld",
      bom: "",
      originalEnding: "\n",
      hashes: ["ATIm", "BeSR"],
      resultContent: "hello\nworld!",
    });
    const entry = await getUndo(home.testPath);
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("hello\nworld");
    expect(entry!.bom).toBe("");
    expect(entry!.originalEnding).toBe("\n");
    expect(entry!.hashes).toEqual(["ATIm", "BeSR"]);
    expect(entry!.resultContent).toBe("hello\nworld!");
  });

  it("returns undefined for a path with no undo history", async () => {
    expect(await getUndo("/nonexistent.ts")).toBeUndefined();
  });

  it("overwrites previous entry for the same path", async () => {
    await saveUndo(home.testPath, {
      content: "first",
      bom: "",
      originalEnding: "\n",
      hashes: ["ATIm"],
      resultContent: "first!",
    });
    await saveUndo(home.testPath, {
      content: "second",
      bom: "\uFEFF",
      originalEnding: "\r\n",
      hashes: ["DAfo"],
      resultContent: "second!",
    });
    const entry = await getUndo(home.testPath);
    expect(entry!.content).toBe("second");
    expect(entry!.bom).toBe("\uFEFF");
    expect(entry!.originalEnding).toBe("\r\n");
    expect(entry!.hashes).toEqual(["DAfo"]);
  });

  it("clearUndo removes the entry", async () => {
    await saveUndo(home.testPath, {
      content: "data",
      bom: "",
      originalEnding: "\n",
      hashes: ["DAfo"],
      resultContent: "data!",
    });
    expect(await getUndo(home.testPath)).toBeDefined();
    await clearUndo(home.testPath);
    expect(await getUndo(home.testPath)).toBeUndefined();
  });

  it("handles multiple independent paths", async () => {
    await saveUndo(home.testPath, {
      content: "aaa",
      bom: "",
      originalEnding: "\n",
      hashes: ["HDtm"],
      resultContent: "aaa!",
    });
    await saveUndo("/b.ts", {
      content: "bbb",
      bom: "",
      originalEnding: "\n",
      hashes: ["Ifms"],
      resultContent: "bbb!",
    });
    expect((await getUndo(home.testPath))!.content).toBe("aaa");
    expect((await getUndo("/b.ts"))!.content).toBe("bbb");
    await clearUndo(home.testPath);
    expect(await getUndo(home.testPath)).toBeUndefined();
    expect((await getUndo("/b.ts"))!.content).toBe("bbb");
  });

  it("survives a hash-store shutdown and reopen", async () => {
    await saveUndo(home.testPath, {
      content: "old",
      bom: "\uFEFF",
      originalEnding: "\r",
      hashes: ["ATIm", "BeSR"],
      resultContent: "new",
    });
    shutdownHashStore();
    const entry = await getUndo(home.testPath);
    expect(entry).toBeDefined();
    expect(entry!.content).toBe("old");
    expect(entry!.bom).toBe("\uFEFF");
    expect(entry!.originalEnding).toBe("\r");
    expect(entry!.hashes).toEqual(["ATIm", "BeSR"]);
    expect(entry!.resultContent).toBe("new");
  });

  it("saveUndo reports failure when the hash store cannot be opened", async () => {
    const spy = vi
      .spyOn(hashStoreModule, "loadHashStore")
      .mockRejectedValue(new Error("store down"));
    try {
      const ok = await saveUndo(home.testPath, {
        content: "old",
        bom: "",
        originalEnding: "\n",
        hashes: ["ATIm"],
        resultContent: "new",
      });
      expect(ok.persisted).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("treats a row with an invalid ending as a miss", async () => {
    await saveUndo(home.testPath, {
      content: "old",
      bom: "",
      originalEnding: "\r\n",
      hashes: ["ATIm"],
      resultContent: "new",
    });
    const db = new DatabaseSync(hashStorePath(), { defensive: false } as any);
    db.prepare("UPDATE undo SET ending = ? WHERE path = ?").run("bogus", home.testPath);
    db.close();
    expect(await getUndo(home.testPath)).toBeUndefined();
    const check = new DatabaseSync(hashStorePath(), { defensive: false } as any);
    const remaining = check.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?").get(home.testPath) as { n: number };
    check.close();
    expect(remaining.n).toBe(0);
  });
});
