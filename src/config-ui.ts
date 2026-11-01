import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_UNDO_RETENTION_DAYS, readConfig, type Config } from "./config";

export type ConfigToggleKey = "autoRead" | "autoReadWrite" | "autoReadAll" | "autoReadAllRequireGit" | "autoReadAllIgnore" | "anchorGrepEnabled" | "copyMoveEnabled" | "replaceMatchEnabled" | "outlineEnabled" | "requirePath" | "strictInput" | "diffContextLines" | "disableOnModels" | "readOnDisabledModels" | "undoRetentionDays";

export interface ConfigRow {
  key: ConfigToggleKey;
  label: string;
  hint: string;
  group: string;
  depth: number;
  enabled: boolean;
  dependsOn?: ConfigToggleKey;
  gated?: boolean;
  mode?: string;
  cycle?: string[];
  value?: number;
  entries?: string[];
  disabled?: boolean;
}

function rowActive(row: ConfigRow): boolean {
  if (row.entries !== undefined) return row.entries.length > 0;
  if (row.mode !== undefined) return row.mode !== "off";
  return row.enabled;
}

export function configRows(config: Config): ConfigRow[] {
  const rows: ConfigRow[] = [
    { key: "autoRead", group: "Auto-read", depth: 0, label: "Auto-read", hint: "Show fresh anchors after write and post-edit diffs", enabled: config.autoRead !== false },
    { key: "diffContextLines", group: "Auto-read", depth: 1, dependsOn: "autoRead", gated: true, label: "Diff context", hint: "Context lines around each change in post-edit diffs", enabled: config.autoRead !== false, value: config.diffContextLines ?? 1 },
    { key: "autoReadWrite", group: "Auto-read", depth: 1, dependsOn: "autoRead", gated: true, label: "Write echo", hint: "Full contents, or a one-line confirmation, after write", enabled: config.autoRead !== false, mode: config.autoReadWrite ?? "full", cycle: ["full", "summary"] },
    { key: "autoReadAll", group: "Auto-read all", depth: 0, label: "Auto-read all", hint: "Attach project files when a session starts", enabled: (config.autoReadAll ?? "off") !== "off", mode: config.autoReadAll ?? "off", cycle: ["off", "outline", "full"] },
    { key: "autoReadAllRequireGit", group: "Auto-read all", depth: 1, dependsOn: "autoReadAll", gated: true, label: "Git repos only", hint: "Attach only inside a git repository", enabled: config.autoReadAllRequireGit !== false },
    { key: "autoReadAllIgnore", group: "Auto-read all", depth: 1, dependsOn: "autoReadAll", label: "Ignore folders/files", hint: "Folders, files, or globs that auto-read all skips (comma-separated)", enabled: (config.autoReadAllIgnore ?? []).length > 0, entries: config.autoReadAllIgnore ?? [] },
    { key: "anchorGrepEnabled", group: "Tools", depth: 0, label: "Anchor grep", hint: "Use the anchored grep in place of pi's own grep", enabled: config.anchorGrepEnabled === true },
    { key: "copyMoveEnabled", group: "Tools", depth: 0, label: "Copy/move", hint: "Enable the copy and move tools", enabled: config.copyMoveEnabled !== false },
    { key: "replaceMatchEnabled", group: "Tools", depth: 0, label: "Replace match", hint: "Enable the replace_match tool", enabled: config.replaceMatchEnabled !== false },
    { key: "outlineEnabled", group: "Tools", depth: 0, label: "Outline tool", hint: "Offer the outline tool for one file's structure on demand", enabled: config.outlineEnabled === true },
    { key: "requirePath", group: "Edit behavior", depth: 0, label: "Require path", hint: "Edit tools must also send a matching path", enabled: config.requirePath === true },
    { key: "strictInput", group: "Edit behavior", depth: 0, label: "Strict input", hint: "Reject auto-fixable slips instead of warnings", enabled: config.strictInput === true },
    { key: "disableOnModels", group: "Model gating", depth: 0, label: "Disable on models", hint: "Model globs that turn off anchored tools (comma-separated)", enabled: (config.disableOnModels ?? []).length > 0, entries: config.disableOnModels ?? [] },
    { key: "readOnDisabledModels", group: "Model gating", depth: 1, dependsOn: "disableOnModels", gated: true, label: "Read on disabled models", hint: "Keep read available for models disabled above", enabled: (config.readOnDisabledModels ?? "vanilla") !== "remove", mode: config.readOnDisabledModels ?? "vanilla", cycle: ["remove", "vanilla"] },
    { key: "undoRetentionDays", group: "State", depth: 0, label: "Undo retention", hint: "Days to keep undo history; 0 keeps it forever", enabled: (config.undoRetentionDays ?? DEFAULT_UNDO_RETENTION_DAYS) > 0, value: config.undoRetentionDays ?? DEFAULT_UNDO_RETENTION_DAYS },
  ];
  for (const row of rows) {
    if (row.gated !== true || row.dependsOn === undefined) continue;
    const parent = rows.find((candidate) => candidate.key === row.dependsOn);
    row.disabled = parent !== undefined && !rowActive(parent);
  }
  return rows;
}

function padRow(theme: Theme, innerWidth: number, content: string): string {
  const clipped = visibleWidth(content) > innerWidth ? truncateToWidth(content, innerWidth) : content;
  const padded = clipped + " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
  return theme.fg("border", "│") + padded + theme.fg("border", "│");
}

function modeBox(theme: Theme, mode: string, disabled?: boolean): string {
  if (disabled === true || mode === "off") return theme.fg("dim", `[${mode}]`);
  if (mode === "strict") return theme.fg("accent", `[${mode}]`);
  return theme.fg("success", `[${mode}]`);
}

function numberBox(theme: Theme, value: number, disabled?: boolean): string {
  if (disabled === true) return theme.fg("dim", `[${value}]`);
  return theme.fg("accent", `[${value}]`);
}

function listBox(theme: Theme, entries: string[], disabled?: boolean): string {
  if (disabled === true) return theme.fg("dim", `[${entries.length}]`);
  return theme.fg("accent", `[${entries.length}]`);
}

function rowBox(theme: Theme, row: ConfigRow): string {
  if (row.entries !== undefined) return listBox(theme, row.entries, row.disabled);
  if (row.value !== undefined) return numberBox(theme, row.value, row.disabled);
  if (row.mode !== undefined) return modeBox(theme, row.mode, row.disabled);
  if (row.disabled === true) return theme.fg("dim", row.enabled ? "[x]" : "[ ]");
  return row.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
}

function rowDetail(row: ConfigRow): string {
  if (row.entries === undefined) return row.hint;
  const joined = row.entries.length > 0 ? row.entries.join(", ") : "(empty)";
  return `${row.hint}: ${joined}`;
}

export class HashlineConfigOverlay {
  private rows: ConfigRow[];
  private selected = 0;
  private scrollTop = 0;
  private editingList = false;
  private editBuffer = "";

  constructor(private readonly opts: { tui: { requestRender(force?: boolean): void }; theme: Theme; done: () => void; maxHeight?: () => number | undefined; onToggle: (key: ConfigToggleKey, delta?: number, value?: string) => Promise<void> }) {
    this.rows = [];
  }

  async load(): Promise<void> {
    this.rows = configRows(await readConfig());
  }

  rowKeys(): ConfigToggleKey[] {
    return this.rows.map((row) => row.key);
  }

  private runToggle(row: ConfigRow, delta?: number, value?: string): void {
    this.opts.tui.requestRender(true);
    void this.opts.onToggle(row.key, delta, value).then(async () => {
      this.rows = configRows(await readConfig());
      this.editingList = false;
      this.opts.tui.requestRender(true);
    }).catch((error: unknown) => {
      console.error("Failed to toggle hashline setting:", error);
    });
  }
  private startListEdit(row: ConfigRow): void {
    this.editingList = true;
    this.editBuffer = (row.entries ?? []).join(", ");
    this.opts.tui.requestRender(true);
  }
  private commitListEdit(): void {
    const row = this.rows[this.selected];
    if (!row || row.entries === undefined) {
      this.editingList = false;
      return;
    }
    const value = this.editBuffer;
    this.editingList = false;
    this.runToggle(row, undefined, value);
  }
  private cancelListEdit(): void {
    this.editingList = false;
    this.opts.tui.requestRender(true);
  }

  private applyCycle(row: ConfigRow, step: number): void {
    if (row.cycle === undefined || row.mode === undefined) return;
    const index = row.cycle.indexOf(row.mode);
    const next = row.cycle[(index + step + row.cycle.length) % row.cycle.length];
    if (next === undefined) return;
    row.mode = next;
    row.enabled = next !== "off";
    this.runToggle(row, step);
  }

  private toggleSelected(): void {
    const row = this.rows[this.selected];
    if (!row || row.disabled) return;
    if (row.entries !== undefined) {
      this.startListEdit(row);
      return;
    }
    if (row.value !== undefined) {
      row.value += 1;
      this.runToggle(row, 1);
      return;
    }
    if (row.cycle !== undefined && row.mode !== undefined) {
      this.applyCycle(row, 1);
      return;
    }
    row.enabled = !row.enabled;
    this.runToggle(row);
  }

  private adjustSelected(delta: number): void {
    const row = this.rows[this.selected];
    if (!row || row.disabled) return;
    if (row.value !== undefined) {
      row.value += delta;
      this.runToggle(row, delta);
      return;
    }
    if (row.cycle !== undefined && row.mode !== undefined) {
      this.applyCycle(row, delta > 0 ? 1 : -1);
      return;
    }
    if (row.entries !== undefined) return;
    const wanted = delta > 0;
    if (row.enabled === wanted) return;
    row.enabled = wanted;
    this.runToggle(row);
  }

  handleInput(data: string): void {
    if (this.editingList) {
      if (matchesKey(data, Key.escape) || data === "\x1b") {
        this.cancelListEdit();
        return;
      }
      if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
        this.commitListEdit();
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
    if (matchesKey(data, Key.escape) || data === "q") {
      this.opts.done();
    }
  }

  invalidate(): void {
  }

  render(width: number): string[] {
    const theme = this.opts.theme;
    const innerWidth = width - 2;
    const body: string[] = [];
    const spans: Array<{ start: number; end: number }> = [];
    let group = "";
    this.rows.forEach((row, index) => {
      if (row.group !== group) {
        group = row.group;
        body.push(padRow(theme, innerWidth, theme.fg("dim", theme.bold(` ${group}`))));
      }
      const start = body.length;
      const selected = index === this.selected;
      const indent = "  ".repeat(row.depth);
      const cursor = selected ? theme.fg("accent", "> ") : "  ";
      const box = rowBox(theme, row);
      const label = row.disabled === true ? theme.fg("dim", row.label) : selected ? theme.fg("accent", theme.bold(row.label)) : row.label;
      const headWidth = 2 + indent.length + visibleWidth(box) + 1;
      const contentWidth = Math.max(1, innerWidth - headWidth);
      wrapTextWithAnsi(label, contentWidth).forEach((segment, part) => {
        body.push(padRow(theme, innerWidth, (part === 0 ? `${cursor}${indent}${box} ` : " ".repeat(headWidth)) + segment));
      });
      for (const segment of wrapTextWithAnsi(theme.fg("dim", rowDetail(row)), contentWidth)) {
        body.push(padRow(theme, innerWidth, " ".repeat(headWidth) + segment));
      }
      if (row.entries !== undefined && selected && this.editingList) {
        const edit = `${theme.fg("accent", "edit:")} ${this.editBuffer}█ ${theme.fg("dim", "(Enter save · Esc cancel · Ctrl-U clear)")}`;
        for (const segment of wrapTextWithAnsi(edit, Math.max(1, innerWidth - 2))) {
          body.push(padRow(theme, innerWidth, `  ${segment}`));
        }
      }
      spans.push({ start, end: body.length - 1 });
    });
    const head = [
      theme.fg("border", `╭${"─".repeat(innerWidth)}╮`),
      padRow(theme, innerWidth, ` ${theme.fg("accent", theme.bold("Hashline Config"))}`),
      theme.fg("border", `├${"─".repeat(innerWidth)}┤`),
    ];
    const footer = this.editingList ? " type to edit · Enter save · Esc cancel" : " ↑↓ navigate · space toggle/edit · ←/→ or -/+ adjust · q close";
    const tail = [
      theme.fg("border", `├${"─".repeat(innerWidth)}┤`),
      padRow(theme, innerWidth, theme.fg("dim", footer)),
      theme.fg("border", `╰${"─".repeat(innerWidth)}╯`),
    ];
    const limit = this.opts.maxHeight?.();
    if (limit === undefined || body.length + head.length + tail.length <= limit) {
      this.scrollTop = 0;
      return [...head, ...body, ...tail];
    }
    const viewport = Math.max(1, limit - head.length - tail.length);
    const span = spans[this.selected] ?? { start: 0, end: 0 };
    let top = this.scrollTop;
    if (span.end - span.start + 1 > viewport) top = span.start;
    else if (span.start < top) top = span.start;
    else if (span.end >= top + viewport) top = span.end - viewport + 1;
    top = Math.max(0, Math.min(top, Math.max(0, body.length - viewport)));
    this.scrollTop = top;
    return [...head, ...body.slice(top, top + viewport), ...tail];
  }
}
