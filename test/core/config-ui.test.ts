import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { configRows } from "../../src/config-ui";
import { configRowNavigator, makeConfigOverlay, withTempDir } from "../support/fixtures";

const right = "\x1b[C";
const left = "\x1b[D";

interface ToggleCall {
  key: string;
  delta?: number;
  value?: string;
}

function collectToggles(): { calls: ToggleCall[]; onToggle: (key: string, delta?: number, value?: string) => Promise<void> } {
  const calls: ToggleCall[] = [];
  return {
    calls,
    onToggle: async (key, delta, value) => {
      calls.push({ key, delta, value });
    },
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

describe("configRows ordering and gating", () => {
  it("orders rows by group with children after their parents", () => {
    const rows = configRows({ autoRead: true, anchorGrepEnabled: true });
    expect(rows.map((row) => row.key)).toEqual([
      "autoRead",
      "diffContextLines",
      "autoReadWrite",
      "autoReadAll",
      "autoReadAllRequireGit",
      "autoReadAllIgnore",
      "anchorGrepEnabled",
      "copyMoveEnabled",
      "replaceMatchEnabled",
      "outlineEnabled",
      "requirePath",
      "strictInput",
      "disableOnModels",
      "readOnDisabledModels",
      "undoRetentionDays",
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("diffContextLines")?.depth).toBe(1);
    expect(byKey.get("diffContextLines")?.dependsOn).toBe("autoRead");
    expect(byKey.get("autoReadWrite")?.depth).toBe(0);
    expect(byKey.get("autoReadWrite")?.dependsOn).toBeUndefined();
    expect(byKey.get("autoReadWrite")?.mode).toBe("full");
    expect(byKey.get("autoReadWrite")?.cycle).toEqual(["full", "summary", "off"]);
    expect(byKey.get("autoReadAllRequireGit")?.dependsOn).toBe("autoReadAll");
    expect(byKey.get("autoReadAllIgnore")?.dependsOn).toBe("autoReadAll");
    expect(byKey.get("readOnDisabledModels")?.dependsOn).toBe("disableOnModels");
    expect(rows.every((row) => row.group.length > 0)).toBe(true);
  });

  it("gates a child on its parent state", () => {
    const off = configRows({ autoRead: true, anchorGrepEnabled: true });
    const offByKey = new Map(off.map((row) => [row.key, row]));
    expect(offByKey.get("diffContextLines")?.disabled).toBe(false);
    expect(offByKey.get("autoReadWrite")?.disabled).toBeUndefined();
    expect(offByKey.get("autoReadAllRequireGit")?.disabled).toBe(true);
    expect(offByKey.get("autoReadAllIgnore")?.disabled).toBeUndefined();
    expect(offByKey.get("readOnDisabledModels")?.disabled).toBe(true);

    const on = configRows({ autoRead: false, anchorGrepEnabled: true, autoReadAll: "outline", disableOnModels: ["openai/*"] });
    const onByKey = new Map(on.map((row) => [row.key, row]));
    expect(onByKey.get("diffContextLines")?.disabled).toBe(true);
    expect(onByKey.get("autoReadWrite")?.disabled).toBeUndefined();
    expect(onByKey.get("autoReadAllRequireGit")?.disabled).toBe(false);
    expect(onByKey.get("readOnDisabledModels")?.disabled).toBe(false);
  });
});

describe("HashlineConfigOverlay arrow keys", () => {
  it("adjusts numbers, cycles modes, and sets booleans", async () => {
    await withTempDir("config-ui-arrows-", async () => {
      const { calls, onToggle } = collectToggles();
      const overlay = makeConfigOverlay({ onToggle });
      await overlay.load();
      const select = configRowNavigator(overlay);
      select("diffContextLines");
      overlay.handleInput(right);
      overlay.handleInput(left);
      select("autoReadWrite");
      overlay.handleInput(right);
      overlay.handleInput(left);
      select("autoReadAll");
      overlay.handleInput(right);
      overlay.handleInput(left);
      select("autoReadAllRequireGit");
      overlay.handleInput(right);
      overlay.handleInput(left);
      select("autoReadAllIgnore");
      overlay.handleInput(right);
      select("anchorGrepEnabled");
      overlay.handleInput(left);
      select("requirePath");
      overlay.handleInput(right);
      await settle();
      expect(calls).toEqual([
        { key: "diffContextLines", delta: 1, value: undefined },
        { key: "diffContextLines", delta: -1, value: undefined },
        { key: "autoReadWrite", delta: 1, value: undefined },
        { key: "autoReadWrite", delta: -1, value: undefined },
        { key: "autoReadAll", delta: 1, value: undefined },
        { key: "autoReadAll", delta: -1, value: undefined },
        { key: "anchorGrepEnabled", delta: undefined, value: undefined },
        { key: "requirePath", delta: undefined, value: undefined },
      ]);
    });
  });
});

describe("HashlineConfigOverlay viewport", () => {
  it("windows the body so the selected row stays visible", async () => {
    await withTempDir("config-ui-viewport-", async () => {
      const { onToggle } = collectToggles();
      const overlay = makeConfigOverlay({ onToggle, maxHeight: () => 20 });
      await overlay.load();
      for (let step = 0; step < 12; step++) {
        const lines = overlay.render(70);
        expect(lines.length).toBeLessThanOrEqual(20);
        expect(lines.some((line) => line.includes("> "))).toBe(true);
        for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(70);
        overlay.handleInput("k");
      }
    });
  });

  it("renders row details on an indented line under the label", async () => {
    await withTempDir("config-ui-detail-", async () => {
      const { onToggle } = collectToggles();
      const overlay = makeConfigOverlay({ onToggle });
      await overlay.load();
      const lines = overlay.render(60);
      const labelIndex = lines.findIndex((line) => line.includes("[x] Post-edit diffs"));
      expect(labelIndex).toBeGreaterThanOrEqual(0);
      expect(lines[labelIndex + 1]).toContain("Show the post-edit diff and auto-read guidance");
      expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
    });
  });
});
