import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { readConfig, type Config } from "./config";

export type ConfigToggleKey = "autoRead" | "anchorGrepEnabled" | "requirePath" | "strictInput" | "boundaryDedupMode" | "diffContextLines";

export interface ConfigRow {
  key: ConfigToggleKey;
  label: string;
  hint: string;
  enabled: boolean;
  mode?: string;
  cycle?: string[];
  value?: number;
  disabled?: boolean;
}

export function configRows(config: Config): ConfigRow[] {
  return [
    { key: "autoRead", label: "Auto-read", hint: "Anchors after write + post-edit diffs", enabled: config.autoRead !== false },
    { key: "diffContextLines", label: "Diff context", hint: "Surrounding lines in post-edit diffs (needs Auto-read)", enabled: config.autoRead !== false, value: config.diffContextLines ?? 1, disabled: config.autoRead === false },
    { key: "anchorGrepEnabled", label: "Anchor grep", hint: "anchor_grep tool (builtin grep off while on)", enabled: config.anchorGrepEnabled === true },
    { key: "requirePath", label: "Require path", hint: "replace + insert need path (RPC visibility)", enabled: config.requirePath === true },
    { key: "strictInput", label: "Strict input", hint: "Reject auto-fixable slips instead of warnings", enabled: config.strictInput === true },
    { key: "boundaryDedupMode", label: "Boundary dedup", hint: "Strip edge lines: on, strict (reject), off (literal)", enabled: (config.boundaryDedupMode ?? "on") !== "off", mode: config.boundaryDedupMode ?? "on", cycle: ["on", "strict", "off"] },
  ];
}

function padRow(theme: Theme, innerWidth: number, content: string): string {
  const padded = content + " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
  return theme.fg("border", "│") + padded + theme.fg("border", "│");
}

function modeBox(theme: Theme, mode: string): string {
  if (mode === "off") return theme.fg("dim", `[${mode}]`);
  if (mode === "strict") return theme.fg("accent", `[${mode}]`);
  return theme.fg("success", `[${mode}]`);
}

function numberBox(theme: Theme, value: number, disabled?: boolean): string {
  if (disabled) return theme.fg("dim", `[${value}]`);
  return theme.fg("accent", `[${value}]`);
}

export class HashlineConfigOverlay {
  private rows: ConfigRow[];
  private selected = 0;

  constructor(private readonly opts: { tui: { requestRender(force?: boolean): void }; theme: Theme; done: () => void; onToggle: (key: ConfigToggleKey, delta?: number) => Promise<void> }) {
    this.rows = [];
  }

  async load(): Promise<void> {
    this.rows = configRows(await readConfig());
  }

  private runToggle(row: ConfigRow, delta?: number): void {
    this.opts.tui.requestRender(true);
    void this.opts.onToggle(row.key, delta).then(async () => {
      this.rows = configRows(await readConfig());
      this.opts.tui.requestRender(true);
    }).catch((error: unknown) => {
      console.error("Failed to toggle hashline setting:", error);
    });
  }

  private toggleSelected(): void {
    const row = this.rows[this.selected];
    if (!row || row.disabled) return;
    if (row.value !== undefined) {
      row.value += 1;
      this.runToggle(row, 1);
      return;
    }
    if (row.cycle && row.mode !== undefined) {
      const next = row.cycle[(row.cycle.indexOf(row.mode) + 1) % row.cycle.length] ?? row.cycle[0];
      if (next === undefined) return;
      row.mode = next;
      row.enabled = next !== "off";
    } else {
      row.enabled = !row.enabled;
    }
    this.runToggle(row);
  }

  private adjustSelected(delta: number): void {
    const row = this.rows[this.selected];
    if (!row || row.disabled || row.value === undefined) return;
    row.value += delta;
    this.runToggle(row, delta);
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
    if (matchesKey(data, Key.right) || data === "+" || data === "=") {
      this.adjustSelected(1);
      return;
    }
    if (matchesKey(data, Key.left) || data === "-" || data === "_") {
      this.adjustSelected(-1);
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
      const box = row.value !== undefined ? numberBox(theme, row.value, row.disabled) : row.mode !== undefined ? modeBox(theme, row.mode) : row.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
      const label = row.disabled ? theme.fg("dim", row.label) : index === this.selected ? theme.fg("accent", theme.bold(row.label)) : row.label;
      lines.push(padRow(theme, innerWidth, `${cursor}${box} ${label} ${theme.fg("dim", `— ${row.hint}`)}`));
    });
    lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
    lines.push(padRow(theme, innerWidth, theme.fg("dim", " ↑↓ navigate · space toggle · ←/→ or -/+ adjust · q close")));
    lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }
}
