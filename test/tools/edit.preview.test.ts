import { describe, expect, it, vi } from "vitest";
import { lineHashes } from "../../src/hashline";
import { compPreview, buildToolDef } from "../../src/replace";
import register from "../../index";
import type { RRState } from "../../src/replace-render";
import { mkMdTheme, reuseText, reuseMarkdown } from "../../src/replace-render";
import { Text, Markdown } from "@earendil-works/pi-tui";
import { makeFakePiRegistry, withTempFile, useTestHome } from "../support/fixtures";

const home = useTestHome();

describe("compPreview", () => {
  it("returns a diff for strict hashline edits before execution", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
      expect((preview as any).diff).toContain("BBB");
    });
  });

  it("returns a diff for a hash-anchored replace before execution", async () => {
    await withTempFile("sample.ts", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
      const hashes = await lineHashes("alpha\nbeta\ngamma\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BETA"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
      expect((preview as any).diff).toContain("BETA");
    });
  });

  it("still computes a preview diff for read-only files", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("uses the shared text loader for preview instead of classifying then re-reading text", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("does not let a delayed preview resurrect after a settled result", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const preview = await compPreview(
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
    });
  });

  it("preview rejects a bulk changes array", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const preview = await compPreview(
        { path: "sample.ts", changes: [{ remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] }] },
        cwd,
      );
      expect(preview).toHaveProperty("error");
      expect((preview as { error: string }).error).toMatch(/^\[E_BAD_SHAPE\]/);
    });
  });

  it("preview still accepts flat-format requests", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const preview = await compPreview(
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        cwd,
      );
      expect(preview).toHaveProperty("diff");
      expect((preview as { diff: string }).diff).toContain("BBB");
    });
  });
});

describe("renderCall preview", () => {
  function makeHarness(cwd: string) {
    const theme = {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    };
    const state: RRState = {};
    let notifyInvalidate: (() => void) | undefined;
    const invalidated = new Promise<void>((resolve) => {
      notifyInvalidate = resolve;
    });
    const context = {
      executionStarted: false,
      argsComplete: true,
      expanded: false,
      cwd,
      lastComponent: undefined,
      invalidate: () => notifyInvalidate?.(),
      state,
    };
    return { theme, state, context, invalidated };
  }

  async function awaitPreview(harness: ReturnType<typeof makeHarness>): Promise<void> {
    await Promise.race([
      harness.invalidated,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("renderCall never produced a preview")), 2000),
      ),
    ]);
  }

  it("computes a diff preview for a flat replace request", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const harness = makeHarness(cwd);
      tool.renderCall(
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
        harness.theme,
        harness.context,
      );

      await awaitPreview(harness);
      expect(harness.state.preview).toHaveProperty("diff");
      expect((harness.state.preview as { diff: string }).diff).toContain("BBB");
    });
  });

  it("shows no preview when the model sends a changes array", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      const harness = makeHarness(cwd);
      tool.renderCall(
        { path: "sample.ts", changes: [{ remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] }] },
        harness.theme,
        harness.context,
      );

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(harness.state.preview).toBeUndefined();
    });
  });

  it("debounces preview computation until args settle", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const { pi, getTool } = makeFakePiRegistry();
      register(pi);
      const tool = getTool("replace");
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);

      vi.useFakeTimers();
      try {
        const harness = makeHarness(cwd);
        tool.renderCall(
          { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["BBB"] },
          harness.theme,
          harness.context,
        );
        expect(harness.state.preview).toBeUndefined();
        tool.renderCall(
          { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["CCC"] },
          harness.theme,
          harness.context,
        );
        await vi.advanceTimersByTimeAsync(149);
        expect(harness.state.preview).toBeUndefined();
        const previewP = harness.invalidated;
        await vi.advanceTimersByTimeAsync(1);
        await previewP;
        expect(harness.state.preview).toHaveProperty("diff");
        expect((harness.state.preview as { diff: string }).diff).toContain("CCC");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("compPreview - noop", () => {
  it("returns a noop error when the edit produces identical content", async () => {
    await withTempFile("sample.ts", "aaa\nbbb\nccc\n", async ({ cwd }) => {
      const hashes = await lineHashes("aaa\nbbb\nccc\n", home.testPath);
      const preview = await compPreview(
        { path: "sample.ts", remove_from: hashes[1]!, remove_to: hashes[1]!, replacement_lines: ["bbb"] },
        cwd,
      );
      expect(preview).toEqual({
        error: "No changes made to sample.ts. The edit produced identical content.",
      });
    });
  });
});

describe("renderCall state transitions", () => {
  function makeHarness(cwd: string) {
    const theme = {
      fg: (_name: string, text: string) => text,
      bold: (text: string) => text,
    };
    const state: RRState = {};
    const context = {
      executionStarted: false,
      argsComplete: true,
      expanded: false,
      cwd,
      lastComponent: undefined,
      invalidate: () => undefined,
      state,
    };
    return { theme, state, context };
  }

  it("clears pending preview state once execution has started", () => {
    const tool = buildToolDef();
    const { theme, state, context } = makeHarness("/tmp");
    context.executionStarted = true;
    state.argsKey = "stale";
    state.preview = { diff: "stale diff" };
    state.previewGeneration = 7;
    const component = tool.renderCall!(
      { path: "x.ts", remove_from: "AAA", remove_to: "BBB", replacement_lines: ["x"] },
      theme as any,
      context as any,
    ) as Text;
    expect(state.argsKey).toBeUndefined();
    expect(state.preview).toBeUndefined();
    expect(state.previewGeneration).toBe(8);
    expect(component).toBeInstanceOf(Text);
  });

  it("clears pending preview state while args are incomplete", () => {
    const tool = buildToolDef();
    const { theme, state, context } = makeHarness("/tmp");
    context.argsComplete = false;
    state.argsKey = "stale";
    state.preview = { diff: "stale diff" };
    state.previewGeneration = 2;
    tool.renderCall!(
      { path: "x.ts", remove_from: "AAA", remove_to: "BBB", replacement_lines: ["x"] },
      theme as any,
      context as any,
    );
    expect(state.argsKey).toBeUndefined();
    expect(state.preview).toBeUndefined();
    expect(state.previewGeneration).toBe(3);
  });
});

describe("renderResult", () => {
  const theme = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  } as any;

  function makeContext(overrides: Partial<{ state: RRState; isError: boolean }> = {}) {
    return { state: {}, lastComponent: undefined, isError: false, ...overrides } as any;
  }

  it("shows an editing notice while the result is partial", () => {
    const tool = buildToolDef();
    const component = tool.renderResult!(
      undefined as any,
      { isPartial: true, expanded: false },
      theme,
      makeContext(),
    ) as Text;
    expect(component).toBeInstanceOf(Text);
    expect((component as any).text).toBe("Editing...");
  });

  it("renders the error text with an error style", () => {
    const tool = buildToolDef();
    const component = tool.renderResult!(
      { content: [{ type: "text", text: "boom" }], details: { diff: "" } },
      { expanded: false, isPartial: false },
      theme,
      makeContext({ isError: true }),
    ) as Text;
    expect((component as any).text).toBe("\nboom");
  });

  it("returns an empty component for an error without text", () => {
    const tool = buildToolDef();
    const component = tool.renderResult!(
      { content: [], details: { diff: "" } },
      { expanded: false, isPartial: false },
      theme,
      makeContext({ isError: true }),
    ) as Text;
    expect(component).toBeInstanceOf(Text);
    expect((component as any).text).toBe("");
  });

  it("renders the post-edit diff for an applied result", () => {
    const tool = buildToolDef();
    const result = {
      content: [{ type: "text", text: "Successfully replaced in sample.ts. Added 1 line(s), removed 1 line(s)." }],
      details: {
        diff: "+aB3│BBB\n-aB3│bbb",
        metrics: { classification: "applied", added_lines: 1, removed_lines: 1 },
      },
    };
    const component = tool.renderResult!(
      result as any,
      { expanded: false, isPartial: false },
      theme,
      makeContext(),
    ) as Text;
    expect(component).toBeInstanceOf(Text);
    expect((component as any).text).toContain("+aB3│BBB");
    expect((component as any).text).toContain("-aB3│bbb");
  });

  it("keeps warnings alongside the applied diff", () => {
    const tool = buildToolDef();
    const result = {
      content: [
        {
          type: "text",
          text: "Successfully replaced in sample.ts.\n\nWarnings:\n[E_BAD_OP] Swapped reversed remove_from/remove_to.",
        },
      ],
      details: {
        diff: "+aB3│BBB",
        metrics: { classification: "applied", added_lines: 1, removed_lines: 1 },
      },
    };
    const component = tool.renderResult!(
      result as any,
      { expanded: false, isPartial: false },
      theme,
      makeContext(),
    ) as Text;
    const text = (component as any).text as string;
    expect(text).toContain("+aB3│BBB");
    expect(text).toContain("[E_BAD_OP] Swapped reversed remove_from/remove_to.");
  });

  it("returns an empty component when there is nothing to render", () => {
    const tool = buildToolDef();
    const component = tool.renderResult!(
      { content: [], details: { diff: "" } },
      { expanded: false, isPartial: false },
      theme,
      makeContext(),
    ) as Text;
    expect(component).toBeInstanceOf(Text);
    expect((component as any).text).toBe("");
  });

  it("renders plain summaries as markdown", () => {
    const tool = buildToolDef();
    const component = tool.renderResult!(
      { content: [{ type: "text", text: "No changes made to sample.ts\nClassification: noop" }], details: { diff: "" } },
      { expanded: false, isPartial: false },
      theme,
      makeContext(),
    ) as Markdown;
    expect(component).toBeInstanceOf(Markdown);
    expect((component as any).text).toBe(
      "No changes made to sample.ts\nClassification: noop",
    );
  });
});

describe("reuseText / reuseMarkdown", () => {
  const theme = {
    fg: (_name: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
  };

  it("reuseText reuses an existing Text component", () => {
    const t = new Text("old", 0, 0);
    const reused = reuseText({ lastComponent: t }, "new");
    expect(reused).toBe(t);
    expect((reused as any).text).toBe("new");
  });

  it("reuseText creates a Text component when none exists", () => {
    const t = reuseText({ lastComponent: undefined }, "new") as Text;
    expect(t).toBeInstanceOf(Text);
    expect((t as any).text).toBe("new");
  });

  it("reuseMarkdown reuses an existing Markdown component", () => {
    const m = new Markdown("old", 0, 0, mkMdTheme(theme));
    const reused = reuseMarkdown({ lastComponent: m }, "new", theme);
    expect(reused).toBe(m);
    expect((reused as any).text).toBe("new");
  });

  it("reuseMarkdown creates a Markdown component when none exists", () => {
    const m = reuseMarkdown({ lastComponent: undefined }, "new", theme) as Markdown;
    expect(m).toBeInstanceOf(Markdown);
    expect((m as any).text).toBe("new");
  });
});
