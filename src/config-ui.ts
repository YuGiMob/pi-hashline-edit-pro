import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { readConfig, type Config } from "./config";

export type ConfigToggleKey = "autoRead" | "anchorGrepEnabled" | "requirePath" | "strictInput" | "boundaryDedupEnabled";

export interface ConfigRow {
  key: ConfigToggleKey;
  label: string;
  hint: string;
  enabled: boolean;
}

export function configRows(config: Config): ConfigRow[] {
  return [
    { key: "autoRead", label: "Auto-read", hint: "Anchors after write + post-edit diffs", enabled: config.autoRead !== false },
    { key: "anchorGrepEnabled", label: "Anchor grep", hint: "anchor_grep tool (builtin grep off while on)", enabled: config.anchorGrepEnabled === true },
    { key: "requirePath", label: "Require path", hint: "replace + insert need path (RPC visibility)", enabled: config.requirePath === true },
    { key: "strictInput", label: "Strict input", hint: "Reject auto-fixable slips instead of warnings", enabled: config.strictInput === true },
    { key: "boundaryDedupEnabled", label: "Boundary dedup", hint: "Strip re-included edge lines (off = literal)", enabled: config.boundaryDedupEnabled !== false },
  ];
}

function padRow(theme: Theme, innerWidth: number, content: string): string {
  const padded = content + " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
  return theme.fg("border", "│") + padded + theme.fg("border", "│");
}

export class HashlineConfigOverlay {
  private rows: ConfigRow[];
  private selected = 0;

  constructor(private readonly opts: { tui: { requestRender(force?: boolean): void }; theme: Theme; done: () => void; onToggle: (key: ConfigToggleKey) => Promise<void> }) {
    this.rows = [];
  }

  async load(): Promise<void> {
    this.rows = configRows(await readConfig());
  }

  private toggleSelected(): void {
    const row = this.rows[this.selected];
    if (!row) return;
    row.enabled = !row.enabled;
    this.opts.tui.requestRender(true);
    void this.opts.onToggle(row.key).then(async () => {
      this.rows = configRows(await readConfig());
      this.opts.tui.requestRender(true);
    }).catch((error: unknown) => {
      console.error("Failed to toggle hashline setting:", error);
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = (this.selected + this.rows.length - 1) % this.rows.length;
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.selected = (this.selected + 1) % this.rows.length;
      return;
    }
    if (matchesKey(data, Key.space) || matchesKey(data, Key.enter) || data === " " || data === "\r" || data === "\n") {
      this.toggleSelected();
      return;
    }
    if (matchesKey(data, Key.escape) || data === "q") {
      this.opts.done();
    }
  }

  invalidate(): void {
  }

  render(width: number): string[] {
    const theme = this.opts.theme;
    const innerWidth = width - 2;
    const lines: string[] = [];
    lines.push(theme.fg("border", `╭${"─".repeat(innerWidth)}╮`));
    lines.push(padRow(theme, innerWidth, ` ${theme.fg("accent", theme.bold("Hashline Config"))}`));
    lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
    this.rows.forEach((row, index) => {
      const cursor = index === this.selected ? theme.fg("accent", "> ") : "  ";
      const box = row.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
      const label = index === this.selected ? theme.fg("accent", theme.bold(row.label)) : row.label;
      lines.push(padRow(theme, innerWidth, `${cursor}${box} ${label} ${theme.fg("dim", `— ${row.hint}`)}`));
    });
    lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
    lines.push(padRow(theme, innerWidth, theme.fg("dim", " ↑↓ navigate · space toggle · q close")));
    lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }
}
