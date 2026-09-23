import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { readConfig, type Config } from "./config";

export type ConfigToggleKey = "autoRead" | "autoReadAll" | "autoReadAllIgnore" | "anchorGrepEnabled" | "requirePath" | "strictInput" | "diffContextLines";

export interface ConfigRow {
  key: ConfigToggleKey;
  label: string;
  hint: string;
  enabled: boolean;
  mode?: string;
  cycle?: string[];
  value?: number;
  folders?: string[];
  disabled?: boolean;
}

export function configRows(config: Config): ConfigRow[] {
  return [
    { key: "autoRead", label: "Auto-read", hint: "Anchors after write + post-edit diffs", enabled: config.autoRead !== false },
    { key: "autoReadAll", label: "Auto-read all", hint: "Attach files on the first turn: off, on, git (git repos only)", enabled: (config.autoReadAll ?? "off") !== "off", mode: config.autoReadAll ?? "off", cycle: ["off", "on", "git"] },
    { key: "autoReadAllIgnore", label: "Ignore folders/files", hint: "Extra folders, files, or globs skipped by auto-read all (comma-separated)", enabled: (config.autoReadAllIgnore ?? []).length > 0, folders: config.autoReadAllIgnore ?? [] },
    { key: "diffContextLines", label: "Diff context", hint: "Surrounding lines in post-edit diffs (needs Auto-read)", enabled: config.autoRead !== false, value: config.diffContextLines ?? 1, disabled: config.autoRead === false },
    { key: "anchorGrepEnabled", label: "Anchor grep", hint: "anchor_grep tool (builtin grep off while on)", enabled: config.anchorGrepEnabled === true },
    { key: "requirePath", label: "Require path", hint: "replace + insert need path (RPC visibility)", enabled: config.requirePath === true },
    { key: "strictInput", label: "Strict input", hint: "Reject auto-fixable slips instead of warnings", enabled: config.strictInput === true },
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
function ignoreBox(theme: Theme, folders: string[]): string {
  return theme.fg("accent", `[${folders.length}]`);
}
function formatIgnoreFolders(folders: string[]): string {
  if (folders.length === 0) return "(empty)";
  const joined = folders.join(", ");
  return joined.length > 40 ? `${joined.slice(0, 37)}...` : joined;
}

export class HashlineConfigOverlay {
  private rows: ConfigRow[];
  private selected = 0;
  private editingIgnore = false;
  private editBuffer = "";

  constructor(private readonly opts: { tui: { requestRender(force?: boolean): void }; theme: Theme; done: () => void; onToggle: (key: ConfigToggleKey, delta?: number, value?: string) => Promise<void> }) {
    this.rows = [];
  }

  async load(): Promise<void> {
    this.rows = configRows(await readConfig());
  }

  private runToggle(row: ConfigRow, delta?: number, value?: string): void {
    this.opts.tui.requestRender(true);
    void this.opts.onToggle(row.key, delta, value).then(async () => {
      this.rows = configRows(await readConfig());
      this.editingIgnore = false;
      this.opts.tui.requestRender(true);
    }).catch((error: unknown) => {
      console.error("Failed to toggle hashline setting:", error);
    });
  }
  private startIgnoreEdit(row: ConfigRow): void {
    this.editingIgnore = true;
    this.editBuffer = (row.folders ?? []).join(", ");
    this.opts.tui.requestRender(true);
  }
  private commitIgnoreEdit(): void {
    const row = this.rows[this.selected];
    if (!row || row.key !== "autoReadAllIgnore") {
      this.editingIgnore = false;
      return;
    }
    const value = this.editBuffer;
    this.editingIgnore = false;
    this.runToggle(row, undefined, value);
  }
  private cancelIgnoreEdit(): void {
    this.editingIgnore = false;
    this.opts.tui.requestRender(true);
  }

  private toggleSelected(): void {
    const row = this.rows[this.selected];
    if (!row || row.disabled) return;
    if (row.key === "autoReadAllIgnore") {
      this.startIgnoreEdit(row);
      return;
    }
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
    if (this.editingIgnore) {
      if (matchesKey(data, Key.escape) || data === "\x1b") {
        this.cancelIgnoreEdit();
        return;
      }
      if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
        this.commitIgnoreEdit();
        return;
      }
      if (data === "\x7f" || data === "\b" || data === "\x08") {
        this.editBuffer = this.editBuffer.slice(0, -1);
        this.opts.tui.requestRender(true);
        return;
      }
      if (data === "\x15") {
        this.editBuffer = "";
        this.opts.tui.requestRender(true);
        return;
      }
      if (data.length >= 1 && [...data].every((ch) => ch.charCodeAt(0) >= 32 && ch !== "\x7f")) {
        this.editBuffer += data;
        this.opts.tui.requestRender(true);
        return;
      }
      return;
    }
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
    const row = this.rows[this.selected];
    if ((data === "e" || data === "E") && row && row.key === "autoReadAllIgnore" && !row.disabled) {
      this.startIgnoreEdit(row);
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
      const box = row.folders !== undefined ? ignoreBox(theme, row.folders) : row.value !== undefined ? numberBox(theme, row.value, row.disabled) : row.mode !== undefined ? modeBox(theme, row.mode) : row.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
      const label = row.disabled ? theme.fg("dim", row.label) : index === this.selected ? theme.fg("accent", theme.bold(row.label)) : row.label;
      const suffix = row.folders !== undefined ? ` — ${row.hint}: ${formatIgnoreFolders(row.folders)}` : ` — ${row.hint}`;
      lines.push(padRow(theme, innerWidth, `${cursor}${box} ${label} ${theme.fg("dim", suffix)}`));
      if (row.key === "autoReadAllIgnore" && index === this.selected && this.editingIgnore) {
        lines.push(padRow(theme, innerWidth, `  ${theme.fg("accent", "edit:")} ${this.editBuffer}█ ${theme.fg("dim", "(Enter save · Esc cancel · Ctrl-U clear)")}`));
      }
    });
    lines.push(theme.fg("border", `├${"─".repeat(innerWidth)}┤`));
    const footer = this.editingIgnore ? " type to edit · Enter save · Esc cancel" : " ↑↓ navigate · space toggle · ←/→ or -/+ adjust · e edit list · q close";
    lines.push(padRow(theme, innerWidth, theme.fg("dim", footer)));
    lines.push(theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }
}
