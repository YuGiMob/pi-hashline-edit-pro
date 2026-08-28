# pi-hashline-edit-pro

[![npm version](https://img.shields.io/npm/v/pi-hashline-edit-pro.svg)](https://www.npmjs.com/package/pi-hashline-edit-pro) [![npm downloads](https://img.shields.io/npm/dm/pi-hashline-edit-pro.svg)](https://www.npmjs.com/package/pi-hashline-edit-pro)

Anchor-based `read`, `replace`, `insert`, and `grep` tools for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent). Every line of a file gets a unique 3-character anchor, and you edit by anchor. There are no line numbers and no fuzzy matching, so edits land on the lines you meant.

Fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW, extended with 3-character anchors and collision resolution.

## Features

- `read` returns every line as `anchor│content`. The anchor is the line's address.
- `replace` targets a range of anchors, so edits land on the lines you meant.
- `insert` adds lines after or before a line by anchor: the anchor line is preserved and the new lines are applied literally, never deduplicated.
- `grep` returns matching lines (and requested context) with `anchor│content` rows that are served like read output, so search results are immediately editable.
- Editing one part of a file leaves the anchors of the rest unchanged, so anchors from an earlier read stay valid across edits.
- After a `write` you get the new anchors. After a `replace` or `insert` you get the diff with the new anchors.
- The most recent replace or insert on a file can be reverted, even after a restart.
- Permissions, line endings, BOMs, symlinks, and hard links survive every edit.

## Quick start

1. Read a file:

```text
ve7│function hello() {
szJ│  console.log("world");
kQm│}
```

2. Replace a line by its anchor:

```json
{
  "path": "src/main.ts",
  "remove_from": "szJ",
  "remove_to": "szJ",
  "replacement_lines": ["  console.log('hi');"]
}
```

3. Keep editing. Anchors for lines you didn't touch stay valid, and auto-read returns fresh anchors after each change.

## Installation

```bash
pi install npm:pi-hashline-edit-pro
```

From a local checkout:

```bash
pi install /path/to/pi-hashline-edit-pro
```

## The read tool

`read` returns a text file with every line prefixed by `anchor│content`. The anchor is 3 characters from `A-Za-z0-9` (for example `aB3`).

| Parameter | Description |
| --- | --- |
| `offset` | Start reading from this line number (1-indexed). |
| `limit` | Maximum number of lines to return. |

Paged output ends with a continuation hint, for example `[Showing lines 1-50 of 120. Use offset=51 to continue.]`.

Lines up to 50KB are shown in full. A larger line is replaced by a marker that keeps the line's anchor: `anchor│[Line N is 2.2MB, exceeds 50KB; content not shown. Use bash: sed -n 'Np' <path> | head -c 51200]`. The marker is served like a normal row, so the whole line can still be replaced via that anchor; `grep` shows an anchored fragment around a match on such a line instead.

Edge cases:

- Images (JPEG, PNG, GIF, WebP, BMP) come back as visual attachments. Other image formats (for example AVIF, HEIC/HEIF, TIFF, ICO, JPEG 2000, JPEG XL, PSD, APNG) are rejected as binary, since the built-in renderer cannot attach them.
- Binary files and directories are rejected with a descriptive error. A magic-signature match is ignored when the sampled bytes contain no NUL bytes and decode as UTF-8, so a text file whose first bytes happen to match a binary or image signature (for example starting with `BM` or `8BPS`) is still read as text. The NUL-byte check covers the whole file, not just the sampled bytes: a file with a NUL byte anywhere is rejected as binary.
- UTF-16 and UTF-32 text (detected via BOM) is rejected, since editing it would corrupt the file.
- Empty files come back as a single empty-line anchor (`anchor│`); use `replace` on that anchor to insert content.
- BOMs are stripped for display. Non-UTF-8 bytes are shown as `U+FFFD`; editing such a file rewrites it as UTF-8, with a warning.
- Files over 238,328 lines or 100MB are rejected with `[E_FILE_TOO_LARGE]`.

## The replace tool

The built-in `edit` tool is disabled. `replace` and `insert` are the only edit paths, and both take the anchors from `read` output.

One edit per call, with `remove_from`, `remove_to`, and `replacement_lines` at the top level:

```json
{
  "path": "src/main.ts",
  "remove_from": "szJ",
  "remove_to": "kQm",
  "replacement_lines": ["  console.log('hi');", "}"]
}
```

| Field | Description |
| --- | --- |
| `remove_from` | 3-char anchor from `read` output marking the FIRST line to remove (inclusive). |
| `remove_to` | 3-char anchor from `read` output marking the LAST line to remove (inclusive). |
| `replacement_lines` | Replacement lines as an array of strings, one element per line. Mirror the removed lines exactly, blank lines included: use `[]` to delete the range, `[""]` for a single blank line, `["a", ""]` for a line followed by a blank line, and `["", ""]` for two blank lines. Do not embed `\n` inside an element: each element is exactly one line. |

Notes:

- The request is checked before any file I/O, so a bad request never touches the file.
- Common copy-paste slips are fixed automatically and reported: a leftover `anchor│` prefix (including a truncated or expanded prefix of up to 6 characters, e.g. `L3│` or `ab12│`) in `replacement_lines` or `remove_from`/`remove_to`, diff-preview rows pasted into the replacement, a reversed range, or a boundary line pasted twice. New lines that re-include a block adjacent to the range are stripped automatically when that block is unique in the file. The whole run is stripped as one unit (including repeated structural lines like `}`), so re-including an unchanged block next to the range never duplicates it. A missing `path` is resolved from the anchors when they uniquely identify a file in the hash store (reported as a warning); when the anchors match multiple known files the request is rejected with the candidate paths named. `file_path` works as an alias for `path` in all five tools.
- An edit that produces identical content reports `No changes made` and leaves the anchors alone. When such a noop happened because a boundary anti-duplication cut removed lines from the replacement (the cut blocked a line that duplicates the block next to the range from being added), the same replacement sent once more runs with the edge anti-duplication turned off for that single call and is applied literally. The duplicated lines are kept, and the result carries a `[E_BOUNDARY_BYPASS]` notice. The pending bypass is per file and keyed to that payload; copied `anchor│` prefixes, diff markers, and stray whitespace in the resend are normalized before matching, so a copy-paste resend still hits it. Any applied edit clears it, and a successful `write` also clears it.
- Every line in the removed range must match what was last shown to you. The extension records the `anchor│content` rows it serves (`read` output, the auto-read block after `write`, the `+anchor│`/` anchor│` rows of post-edit diffs (replace, insert, and undo), the current-range rows of `[E_RANGE_STALE]` feedback, and the context rows of stale/ambiguous-anchor feedback) and verifies the whole range against that record before writing. If an interior line changed on disk since it was shown (external editor, formatter-on-save, code generation) or was never shown, the edit is refused with `[E_RANGE_STALE]` and the current range is returned with fresh anchors, so the retry needs no `read`. Edits outside the served record are only possible for files that were never read (for example right after a `write` with auto-read disabled); once the file has been served, every replaced line must have been shown.
- After a successful edit you get the post-edit diff with fresh anchors, so you can keep editing without re-reading. The diff is capped at 50KB: a row longer than 50KB is shown as a marker that keeps the row's anchor (so the line stays editable via the diff), and when the total cap is hit the diff ends with a truncation note. Only the rows shown in the capped diff are recorded as served. The same caps apply to the `insert` and `undo_last_change` diffs, to the interactive previews, and to `details.patch` (which is flagged with `details.patchTruncated` when it was cut and can no longer be applied as-is).
- Do not issue multiple replace or insert calls on the same file in one message; parallel edits split attention across the post-edit diffs and removed lines are easy to miss. Verify each diff before the next edit on that file.

## The insert tool

`insert` adds lines after or before an existing line without removing anything. The anchor line is preserved, and the new lines go after it (`direction: "after"`) or before it (`direction: "before"`):

```json
{
  "path": "src/main.ts",
  "anchor": "szJ",
  "direction": "after",
  "lines": ["  console.log('hi');"]
}
```

| Field | Description |
| --- | --- |
| `anchor` | 3-char anchor from `read` output marking the line next to which the lines go (inclusive; the line is preserved). A pasted diff row like `+aB3│x` or an `anchor│` prefix is stripped automatically with a warning. |
| `direction` | `"after"` to insert below the anchor line, `"before"` to insert above it. |
| `lines` | Lines to insert as an array of strings, one element per line. Mirror `replacement_lines` semantics: use `[""]` for a blank line and do not embed `\n` inside an element. The anchor line is never part of `lines`. |

Notes:

- The anchor line must have been shown to you (read output, a post-edit diff row, grep output, or stale-range feedback). The same verification as `replace` applies: a stale or unshown anchor is rejected with `[E_STALE_ANCHOR]`, `[E_AMBIGUOUS_ANCHOR]`, or `[E_RANGE_STALE]` and the retry needs no `read`.
- Lines are applied literally: nothing is removed, and a line that duplicates its neighbor is kept. `replace`'s boundary anti-duplication never runs for `insert`.
- To seed an empty file, read it and insert after the `anchor│` empty-line row.
- The same safety machinery as `replace` applies: undo is saved before the write (a failed write restores the previous undo record), line endings and BOMs survive, and an applied insert clears a pending boundary bypass.
- Inserting nothing (`lines: []`) reports a noop and leaves the file unchanged; inserted lines are never deduplicated.

## The grep tool

`grep` replaces the built-in grep with an anchored search. Every matching line (and each requested context line) is returned as an `anchor│content` row, and those rows are recorded in the served state exactly like `read` output, so you can target them with `replace` or `insert` immediately without a separate `read`.

| Field | Description |
| --- | --- |
| `pattern` | Search pattern (regex, or literal text when `literal` is true). |
| `path` | File or directory to search (default: the current working directory). |
| `glob` | Filter files by glob pattern; `*` matches across directories, e.g. `*.ts` or `**/*.spec.ts`. A leading `/` is ignored, and the pattern may be relative to the search root or to the current directory. |
| `ignoreCase` | Case-insensitive search (default: false). |
| `literal` | Treat the pattern as literal text instead of a regex (default: false). |
| `context` | Lines of context before and after each match; context rows carry anchors too (default: 0). |
| `limit` | Maximum number of matched lines to return (default: 100). |

Notes:
- Results are grouped per file under a `=== path ===` header; every shown row carries the anchor it would have in `read` output.
- Directory searches skip `node_modules`, `.git`, `.tmp`, and `coverage`. Binary, image, and oversized files are skipped silently.
- Output is capped at `limit` matched lines, 2000 rows, and 50KB of text (whichever comes first), with a hint naming the cap that cut results. A matched line longer than 500 bytes is shown as a fragment around the match with `...` marking the truncated sides, so the relevant part of the hit stays visible; a context line over 500 bytes is shown as its head with a trailing `...`. Fragments keep the line's anchor (long lines are hashed from their first 500 bytes) and are served like full rows, so a fragmented match is still editable with `replace` (which always replaces the whole line). Directory scans stop after 4000 files with a hint; results may be incomplete.
- `file_path` works as an alias for `path`.
- Line endings and BOMs survive every edit. The file's line ending is detected from its first newline and restored on write; a file that mixes LF and CRLF (for example a WSL-edited file) is normalized to the first-seen ending.
- Files with multiple hard links (`nlink > 1`) are rewritten in place rather than via a temp-file rename, so every link keeps seeing the same content; that write is direct rather than atomic.

## Undo

`undo_last_change` reverts the most recent successful `replace` or `insert` on a file, restoring the exact previous content, BOM and line endings included, plus the previous anchors.

- History is per-file and single-level: only the most recent replace or insert can be reverted.
- History is persisted and survives session restarts. A failed `write` does not clear it.
- Every applied replace or insert is undoable: the undo record is saved before the edit is written.
- A successful `write` clears the history for that file.
- If the file was modified since the last replace or insert, the undo is refused rather than overwriting those changes. The undo record is kept: once the file matches the edited state again (for example you revert the external change), `undo_last_change` succeeds.
- If the file was deleted since the last replace or insert, `undo_last_change` restores it from the recorded pre-edit content. Nothing is overwritten, since the file no longer exists.
- Missing-file cleanup never touches the undo record: the per-session prune of the hash store removes the snapshots and served records of files that no longer exist (both are recomputed on the next read), but the undo history survives — even when the file is temporarily absent, for example during a branch switch.

## Auto-read

Enabled by default. After a successful `write`, the extension reads the file and appends an `--- Auto-read (hashline anchors) ---` block to the result, so you get fresh `anchor│content` anchors without a separate `read` call.

- After `replace`, `insert`, and `undo_last_change`, the result shows the post-edit diff. The `+anchor│` and ` anchor│` rows carry the current anchors, so follow-up edits can anchor on the diff directly. The `-anchor│` rows show removed lines with their old anchors, so you can see exactly which anchors were deleted (those anchors are stale after the edit). When the context line touching a change is blank or whitespace-only, one more context line is shown in that direction, so the change stays anchored to visible content. Call `read` when you want the full file's anchors.
- Auto-read keeps the same 50KB / 2000-line budget as `read`. Lines over 50KB are shown as markers that keep the line's anchor (use `grep` for a fragment around a match).
- Toggle at runtime with `/toggle-auto-read`; the setting persists across sessions.

## Tool result details

All five tools return machine-readable metadata in `details` alongside the model-visible text:

- `read`: `details.truncation` (set when the output was truncated), `details.snapshotId` (a `v2|path|ino|mtime|ctime|size` fingerprint of the file), `details.nextOffset` (use as the next `offset`), and `details.metrics` with `truncated` and `next_offset`.
- `replace` and `insert`: `details.diff` (the post-edit diff, capped at 50KB with markers for oversized rows; `+HASH│` and ` HASH│` rows carry the current anchors), `details.patch` (a standard unified patch of the changes, for external tools, capped at 50KB like the diff), `details.patchTruncated` (true when the patch was cut to fit the cap and cannot be applied as-is), `details.firstChangedLine`, `details.snapshotId`, `details.classification` (`"noop"` when nothing changed), and `details.metrics`: `edits_attempted`, `edits_noop`, `warnings`, `classification` (`"applied"` or `"noop"`), `changed_lines` (`{ first, last }`), `added_lines`, `removed_lines`.
- `undo_last_change`: `details.diff` (the undo diff with the restored anchors), `details.patch` (a standard unified patch of the restored changes, capped at 50KB like `replace`), `details.patchTruncated` (true when the patch was cut), and `details.metrics` (same shape as `replace`).
- `grep`: `details.metrics` with `matches` (matched lines found, capped at `limit`), `files`, and `truncated` (true when the row, byte, file-scan, or `limit` cap cut the results), plus `details.truncation` (the standard pi truncation report — `truncatedBy`, `totalLines`, `outputLines`, `maxLines`, `maxBytes`, … — when the output was cut) and `details.linesTruncated` (true when long lines were shown as fragments).

## Settings

| Command | Description |
| --- | --- |
| `/toggle-auto-read` | Toggle auto-read anchors after write and post-edit diffs after replace, insert, and undo_last_change. Persists across sessions. |

Settings live in `~/.config/pi-hashline-edit-pro/config.json`, created automatically when a setting is toggled. On non-Windows platforms, the config directory honors `XDG_CONFIG_HOME` when set (falling back to `~/.config`); on Windows it always uses `~/.config`:

```json
{
  "autoRead": true
}
```

## How anchors work

Each line is canonicalized (carriage returns stripped, trailing whitespace trimmed) and hashed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm) (xxHash32), then mapped to a 3-character string over `A-Za-z0-9`, which gives 62³ = 238,328 possible anchors. The canonicalization keeps anchors stable across editor-save cycles that add or remove trailing whitespace. A line longer than 500 bytes is hashed from its first 500 bytes; uniqueness is still guaranteed by the collision-resolution below.

The alphabet is sized for an LLM consumer: the model reads the hashes as tokens rather than inspecting glyph shapes, so letters and digits are all included. The URL-safe specials `-` and `_` are deliberately excluded. A hash starting with `-` looks like a diff-preview deletion row, and `-`/`_` at the start of a line are markdown-active, which invites mis-copying and false autocorrections.

Anchors are unique by construction. If a line's base hash collides with an already-assigned hash, the next free hash is allocated from a bitset by probing with a stride coprime to the hash space (O(1) amortized). The stride is `62² + 62 + 1`, so consecutive collisions, runs of blank lines, repeated `}`, land on anchors that differ in all three characters instead of sharing a prefix. Every line in a file therefore gets a unique anchor; two byte-identical lines (repeated `}`, repeated `import` statements) never share one. The same guarantee sets the file size cap: at most 238,328 lines per file, beyond which `read`, `replace`, and `insert` reject with `[E_FILE_TOO_LARGE]` (use `write` for very large files).

Hashes live in a persistent per-file store (`~/.config/pi-hashline-edit-pro/hash-store.sqlite`) that keeps the hashes of unchanged lines across edits. When a range is replaced, the runtime maps the old content onto the new content and copies hashes for lines that survived; only genuinely new lines get fresh hashes.

The store also keeps a per-file record of the hashes the model was last served (`read` rows, auto-read blocks, post-edit diff rows), pruned to the file's current hashes on every update so removed lines' hashes do not accumulate. `replace` verifies every line of the resolved range against that record before writing; a line whose hash is missing from the record means it either changed on disk after it was shown or was never shown, and the edit is refused with `[E_RANGE_STALE]`. A `write` clears the record, so edits after a write are verified against whatever the next `read` or auto-read block serves.

Two guarantees make this safe even with duplicated content:

- An edited range never borrows a hash from a line outside it. Lines outside the replaced range keep their hashes unconditionally, even when their content is byte-identical to lines inside the range.
- Re-inserted identical text keeps its hash. If replacement content matches a line that was just removed, the removed line's hash is reused. "Replace X with X" doesn't rotate the anchor.

A no-op replace never changes the file, so anchors remain valid. On first run after upgrading from an older version, the previous `hash-store.json` is imported once and renamed to `hash-store.json.bak`.

## Error codes

| Code | Meaning |
| --- | --- |
| `[E_BAD_SHAPE]` | Request envelope or edit item has unknown, missing, or wrongly-typed fields (for example `replacement_lines` must be an array of strings, one element per line). |
| `[E_BAD_REF]` | An anchor in `remove_from`/`remove_to` is not a bare 3-char anchor. |
| `[E_STALE_ANCHOR]` | An anchor does not match any line in the current file; call `read` for fresh anchors. |
| `[E_AMBIGUOUS_ANCHOR]` | An anchor matches multiple lines; call `read` for fresh anchors. |
| `[E_INVALID_PATCH]` | A `replacement_lines` element is a diff-preview row (`+anchor│`, `-anchor│`, `-   │`). The marker is stripped automatically with a warning. |
| `[E_BARE_HASH_PREFIX]` | A `replacement_lines` element starts with an `anchor│` prefix (the anchor plus the separator). The prefix is stripped automatically with a warning. |
| `[E_BAD_OP]` | Range start line is after range end line. The pair is swapped automatically with a warning. |
| `[E_WOULD_EMPTY]` | An edit would empty a non-empty file; use `write` instead. |
| `[E_NOT_FOUND]` | The path does not exist. |
| `[E_ACCESS]` | The file is not readable or writable. |
| `[E_NOT_TEXT]` | The path is a directory, binary file, image, or UTF-16/UTF-32 encoded text; hashline editing only supports text files. |
| `[E_UNDO_STALE]` | `undo_last_change` refused: the file was modified after the last edit. The undo record is kept until the file matches the edited state again or a new edit replaces it. |
| `[E_UNDO_UNAVAILABLE]` | Undo history could not be persisted to the hash store; the edit was refused and the file was left unchanged. |
| `[E_RANGE_STALE]` | A line in the replaced range no longer matches what was last shown (the file changed on disk, or the line was never shown). The edit was refused; the current range is returned with fresh anchors. |
| `[E_BOUNDARY_BYPASS]` | The boundary anti-duplication was turned off for one replace call (an identical replacement had previously been cut to a noop); the duplicate lines were applied literally. The dedup is restored for the next call. |
| `[E_FILE_TOO_LARGE]` | The file exceeds the 238,328-line hashline limit or the 100MB size limit. |
| `[E_WRITE_HASH_ECHO]` | A `write` `content` line begins with the exact `anchor│` served for this file at the same line. The write is refused, file byte-identical; retry with bare content (remove the copied anchors). |

## Troubleshooting

- Stale anchors. `[E_STALE_ANCHOR]` or `[E_AMBIGUOUS_ANCHOR]` mean the file changed since the anchors were read. Call `read` for fresh anchors and retry.
- Range changed on disk. `[E_RANGE_STALE]` means a line inside the replaced range changed after it was last shown to you (or was never shown). Nothing was modified; the error carries the current range with fresh anchors, so retry with those without a `read`.
- Reset the hash store. Anchors live in `~/.config/pi-hashline-edit-pro/hash-store.sqlite` (with `-wal`/`-shm` sidecars). Quit pi, delete those three files, and the store is rebuilt on the next session. Anchor history is lost, but no project files are touched.
- Corrupt store. If the store fails its health check it is renamed to `hash-store.sqlite.corrupt-<timestamp>` and rebuilt automatically.
- Config directory moved. On non-Windows platforms, if `XDG_CONFIG_HOME` is set, the config directory (and the hash store inside it) lives at `$XDG_CONFIG_HOME/pi-hashline-edit-pro` instead of `~/.config/pi-hashline-edit-pro`. An existing store is not migrated automatically. To keep anchor and undo history, move the old `hash-store.sqlite` files (plus `-wal`/`-shm` sidecars) into the new directory before the first run.

## Development

Requires [Node.js](https://nodejs.org) ≥ 22.19 and npm.

```bash
npm install
npm test
npm run lint
npm run typecheck
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

## Credits

- [RimuruW](https://github.com/RimuruW), original `pi-hashline-edit` and the strict-semantics policy
- [can1357](https://github.com/can1357), original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept

## License

[MIT](LICENSE)
