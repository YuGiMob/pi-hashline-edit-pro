# pi-hashline-edit-pro

[![npm version](https://img.shields.io/npm/v/pi-hashline-edit-pro.svg)](https://www.npmjs.com/package/pi-hashline-edit-pro) [![npm downloads](https://img.shields.io/npm/dm/pi-hashline-edit-pro.svg)](https://www.npmjs.com/package/pi-hashline-edit-pro)

pi-hashline-edit-pro is an extension for [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) that edits files by anchor. Every line a tool shows you is prefixed with a unique 4-character anchor, and you edit by anchor. There are no line numbers and no fuzzy matching, so an edit lands on the line you meant.

It is a fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW, extended with 4-character tokenizer-friendly anchors and allocation-based anchor identity.

## Installation

```bash
pi install npm:pi-hashline-edit-pro
```

To install from a local checkout:

```bash
pi install /path/to/pi-hashline-edit-pro
```

## Usage

Read a file. Every line comes back as `anchor│content`:

```text
Dafo│function hello() {
Emno│  console.log("world");
HDtm│}
```

Replace a line by its anchor:

```json
{
  "remove_from": "Emno",
  "remove_to": "Emno",
  "replacement_lines": ["  console.log('hi');"]
}
```

The result is the post-edit diff with fresh anchors, so you can keep editing without re-reading. Lines you did not touch keep their anchors. After a `write`, an auto-read block gives you the new anchors. The most recent `replace` or `insert` on a file can be reverted, even after a restart.

The extension registers five tools: `read`, `replace`, `insert`, `anchor_grep`, and `undo_last_change`. The built-in `edit` tool is disabled. `replace` and `insert` take no `path` parameter by default: the file is resolved from the anchors' session ownership alone, so an edit can only land on the file the anchors were served for. Opt in with `/hashline-config` to require `path` in `replace` and `insert` for RPC visibility (for example pimacs.el); anchors still resolve the target and `path` must match.

### read

`read` returns a text file with every line prefixed by `anchor│content`. The anchor is the line's address.

| Parameter | Description |
| --- | --- |
| `path` | Path to the file (relative or absolute). |
| `offset` | Line number to start reading from (1-indexed). |
| `limit` | Maximum number of lines to return. |

Output is capped at 2000 lines and 50KB. Paged output ends with a continuation hint, for example `[Showing lines 1-50 of 120. Use offset=51 to continue.]`.

A line whose `anchor│content` row exceeds 50KB is replaced by a marker that keeps the line's anchor: `anchor│[Line N is 2.2MB, exceeds 50.0KB; content not shown. Use bash: sed -n 'Np' <path> | head -c 51200]`. The marker is served like a normal row, so the whole line can still be replaced through it.

Edge cases:

- Images (JPEG, PNG, GIF, WebP, BMP) come back as visual attachments. Other image formats (AVIF, HEIC/HEIF, TIFF, ICO, JPEG 2000, JPEG XL, PSD, APNG) are rejected as binary, since the built-in renderer cannot attach them.
- Binary files and directories are rejected. A magic-signature match is ignored when the sampled bytes contain no NUL and decode as UTF-8, so a text file that happens to start with `BM` or `8BPS` still reads as text. A NUL byte anywhere rejects the file.
- UTF-16 and UTF-32 text (detected by BOM) is rejected, since editing it would corrupt the file.
- An empty file comes back as one empty-line row (`anchor│`); replace that anchor to insert content.
- BOMs are stripped for display. Non-UTF-8 bytes are shown as `U+FFFD`; editing such a file rewrites it as UTF-8, with a warning.
- Files over 1,353,139 lines or 100MB are rejected with `[E_FILE_TOO_LARGE]`.

### replace

`replace` removes a range of lines and puts new lines in their place. One edit per call, with the fields at the top level:

| Field | Description |
| --- | --- |
| `remove_from` | 4-char anchor marking the FIRST line to remove (inclusive). |
| `remove_to` | 4-char anchor marking the LAST line to remove (inclusive). |
| `replacement_lines` | Replacement lines, one element per line. Mirror the removed lines exactly, blank lines included: `[]` deletes the range, `[""]` is a single blank line, `["a", ""]` is a line followed by a blank line. Never embed `\n` inside an element. A lone string is accepted too: it is split on newlines, and stringified array text is unwrapped. |

Example: read showed `Hasu│old` and `arvm│old2`; to replace both:

```json
{
  "remove_from": "Hasu",
  "remove_to": "arvm",
  "replacement_lines": ["new line 1", "new line 2"]
}
```

Single line: use the same anchor for `remove_from` and `remove_to`. `replace_from`/`replace_to` and `from`/`to` work as aliases.

The request is checked before any file I/O, so a bad request never touches the file.

Common copy-paste slips are fixed automatically: a leftover `anchor│` prefix in `replacement_lines` or the anchor fields (a prefix of 4 to 5 letters before `│`, for example `abde│`), and diff-preview rows pasted into the replacement are reported as warnings, while a reversed range, stringified array text (even with a trailing JS method call, for example `[…].map(s => s)`), and embedded newlines are corrected silently.
Content containing a NUL byte (`U+0000`) is rejected with `[E_BAD_SHAPE]` before any file I/O: writing it would make the file binary, so use an empty replacement to delete. This applies to `replace`'s `replacement_lines` and `insert`'s `lines`.

Every line in the removed range must match what was last shown to you. The extension records the `anchor│content` rows it serves (`read` output, `anchor_grep` output, the auto-read block after `write`, the `+anchor│` and ` anchor│` rows of post-edit diffs, the current-range rows of `[E_RANGE_STALE]` feedback, and the context rows of stale-anchor feedback) and verifies the whole range against that record before writing. A line that changed on disk since it was shown, or an anchor that is not owned in this session, refuses the edit with `[E_RANGE_STALE]` or `[E_STALE_ANCHOR]` and returns the current range with fresh anchors, so the retry needs no `read`. An owned anchor enters the served record when its row is shown (after a restart, restored ownership counts as shown), so a file with no owned anchors cannot be edited by anchor at all; call `read` first. An owned line that was never shown — for example beyond an auto-read preview's truncation cap — is refused with `[E_RANGE_STALE]` and returns the current range, so the retry still needs no `read`.

An edit that produces identical content reports `No changes made` and leaves the anchors alone.

After a successful edit, the diff is capped at 50KB. A row over 50KB is shown as a marker that keeps the row's anchor, and only the rows shown in the capped diff are recorded as served. The same caps apply to the `insert` and `undo_last_change` diffs, to the interactive previews, and to `details.patch`.

Multiple `replace` and `insert` calls on the same file in one assistant message are grouped per file into one batch. The batch unit is the message, not the turn: calls from separate messages in the same turn run solo, one after another. A solo edit commits before its result returns; a batch validates every call against the pre-batch state and commits once, during the batch's last call: earlier calls reply `In batch N` and the batch's last call shows the combined diff, with one undo reverting the whole batch. If the batch aborts, an earlier member's row renders the abort message instead of the placeholder. Nothing commits at turn end. A batch member accepts the same request shapes and auto-fixes as a solo call.
The hashline tools are sequential in pi, so a message that contains one runs all of its tool calls one at a time in the order given; a `read` or shell `cat` issued before the edit commits can still observe the pre-commit state, so verify in the next message with the post-edit diff or a fresh `read`.
Batched calls must target disjoint ranges; overlapping ranges, or any failing call, aborts the whole batch unwritten. One `insert` with `direction: "before"` and one with `direction: "after"` may target the same anchor line: the pair composes into a single insertion. A batch member that fails aborts its batch-mates with `[E_OP_ABORTED]`. A call whose anchors resolve nowhere never joins a batch: it runs solo and fails with its own error (`[E_STALE_ANCHOR]`, or `[E_BAD_SHAPE]` when its request cannot be parsed), while the same-file batch in the message still commits. Calls with one stale anchor and a valid co-anchor, or with a `requirePath` path hint, join their file's batch and abort it instead of applying partially. An error that aborts a batch ends with `Aborts batch N.`; an aborted call reads `[E_OP_ABORTED] Batch N aborted: [<kind>] Call Nr <X> errored [<code>]`, naming the failing call and its error code (or `[E_OP_ABORTED] Batch N aborted.` when the failing error carries no code). Anchor capacity is preflighted before writing; if anchor finalization fails after the write, the error states the file was written with one undo available. Verify each batch diff before the next turn's edits on that file.

### insert

`insert` adds lines after or before an existing line without removing anything. Like `replace`, there is no `path` parameter.

| Field | Description |
| --- | --- |
| `anchor` | 4-char anchor marking the line next to which the lines go. The anchor line is preserved. A pasted `+Hasu│x` diff row or `anchor│` prefix is stripped automatically with a warning. |
| `direction` | `"after"` inserts below the anchor line, `"before"` above it. |
| `lines` | Lines to insert, one element per line. `[""]` is a blank line. Never include the anchor line, and never embed `\n` inside an element. A lone string is split on newlines, and stringified array text is unwrapped. |

Nothing is removed and the inserted lines are written exactly as given; the anchor line and every other line stay in place. Inserting nothing (`lines: []`) reports a noop. To seed an empty file, read it and insert after the `anchor│` empty-line row.

The same safety machinery as `replace` applies: undo is saved before the write (a failed write restores the previous undo record), and line endings and BOMs survive.

### anchor_grep

`anchor_grep` is an anchored search backed by ripgrep. It is enabled by default; disable it in `/hashline-config` (or set `anchorGrepEnabled` to `false` in the config file). While it is enabled, the built-in grep is disabled. Disabling it removes the tool and restores the built-in grep only if that was active before the extension loaded.

Every matching line, and each requested context line, is returned as `lineNumber │ anchor│content`. The `anchor│content` part is served exactly like `read` output, so you can target it with `replace` or `insert` without a separate `read`; the line-number gutter and `=== path ===` header give filename and line for navigation.

| Field | Description |
| --- | --- |
| `pattern` | Search pattern (regex, or literal text when `literal` is true). |
| `path` | File or directory to search (default: the current working directory). `file_path` works as an alias. |
| `glob` | Filter files by glob; `*` matches across directories, for example `*.ts` or `**/*.spec.ts`. A leading `/` is ignored, and the pattern may be relative to the search root or the current directory. |
| `ignoreCase` | Case-insensitive search (default: false). |
| `literal` | Treat the pattern as literal text instead of a regex (default: false). |
| `context` | Lines of context before and after each match (default: 0). Context rows carry anchors too. |
| `limit` | Maximum number of matched lines to return (default: 100). |

Directory searches respect `.gitignore` (including parent directories); `.git` is always skipped, and hidden files are searched. `node_modules`, `.tmp`, and `coverage` are skipped only when a `.gitignore` lists them. Binary, image, and oversized files are skipped silently.

Regexes with backreferences, nested quantifiers, quantified alternation, or multiple variable quantifiers are rejected with `[E_UNSAFE_REGEX]` before any files are scanned. Use `literal: true` when regex behavior is unnecessary.

Output is capped at `limit` matched lines, 2000 rows, and 50KB of text, whichever comes first, with a note naming the caps that cut the results (the exact one is in `details.truncation`). A matched line whose `anchor│content` row exceeds 500 bytes is shown as a fragment around the match, with `...` marking the truncated sides; a context row over 500 bytes is shown as its head with a trailing `...`. Fragments keep the line's anchor (long lines are hashed from their first 500 bytes) and are served like full rows, so a fragmented match is still editable, and `replace` always replaces the whole line.

### undo_last_change

`undo_last_change` reverts the most recent successful `replace` or `insert` on a file, restoring the exact previous content, BOM and line endings included, plus the previous anchors.

- History is per-file and single-level: only the most recent `replace` or `insert` can be reverted. A same-message batch of `replace`/`insert` calls on one file counts as one entry: one undo reverts the whole batch.
- History is persisted and survives session restarts. A failed `write` does not clear it.
- Every applied `replace` or `insert` is undoable; the undo record is saved before the edit is written.
- A successful `write` clears the history for that file.
- If the file was modified since the last edit, the undo is refused with `[E_UNDO_STALE]` rather than overwriting those changes, and the record is kept. Once the file matches the edited state again, `undo_last_change` succeeds.
- If the file was deleted since the last edit, `undo_last_change` restores it from the recorded pre-edit content.
- Missing-file cleanup never touches the undo record. The per-session prune removes snapshots and served records of files that no longer exist (both are recomputed on the next read), but the undo history survives, even when the file is temporarily absent during a branch switch.

### Auto-read

Auto-read is enabled by default. After a successful `write`, the extension reads the file and appends an `--- Auto-read (hashline anchors) ---` block, so you get fresh `anchor│content` anchors without a separate `read` call.

After `replace`, `insert`, and `undo_last_change`, the result shows the post-edit diff. Inside a same-message batch, only the batch's last call shows the combined diff, headed by a `batch N:` line; earlier calls reply `In batch N`. The `+anchor│` and ` anchor│` rows carry the current anchors, so follow-up edits can anchor on the diff directly. The `-anchor│` rows show removed lines with their old anchors, which are stale after the edit. When the context line next to a change is blank or whitespace-only, one more context line is shown in that direction, so the change stays anchored to visible content. Call `read` when you want the full file's anchors.

Auto-read keeps the same 50KB and 2000-line budget as `read`. Auto-read and Diff context live in `/hashline-config` and persist across sessions. The post-edit diff shows 1 surrounding line by default; change Diff context in `/hashline-config` (0-10, needs Auto-read) to show more or fewer.

### Auto-read all

Auto-read all is off by default and has three modes, selected in `/hashline-config`: `off` injects nothing, `on` discovers every file in the working directory that is not git-ignored (`git ls-files`, falling back to `ripgrep`, then to a directory walk), and `git` uses `git ls-files` only, injecting nothing when the working directory is not a git repository. On the first turn of a session, the extension discovers the files, reads each one, and attaches the resulting `anchor│content` rows to the conversation as one extension message before the model answers. Those anchors are served exactly like `read` output, so the model can `replace` and `insert` immediately without calling `read` first. The message is injected once per session; resumed, forked, and cloned sessions that already contain it skip the injection.

Files are filtered before injection: symlinks, directories, image extensions (including SVG), binary files (a NUL byte in the first 8KB), files over 200KB, any path with a vendored segment (vendor, node_modules, bower_components, third_party, thirdparty, jspm_packages, .venv, venv, site-packages, __pycache__, .tox, .gradle, .terraform, Pods, Carthage, DerivedData, coreui, coreui-icons, case-insensitive), and vendored or generated names and patterns (*.min.js, *.min.css, *.min.mjs, *-min.js, *-min.css, *.bundle.*, *.chunk.*, *.umd.js, *.map, *.lock, package-lock.json, yarn.lock, composer.lock, Gemfile.lock, Cargo.lock, poetry.lock, Pipfile.lock, go.sum, flake.lock, *.generated.*, *.gen.*, *_pb2.py, *.pb.go, *.g.dart, *.freezed.dart, *.designer.cs, *.g.cs, *.snap, .eslintcache, coreui-icons.*, coreui.css) are skipped. The attachment stops at 500 files or at a byte budget derived from the model context window (200KB floor, 2MB ceiling), and it never drops below one file. Skipped and not-attached files are named at the end of the message so the model can `read` them on demand.

Each attached file is shown as `=== path ===` followed by its `anchor│content` rows — edit directly from the attachment with replace and insert, no read needed. Files attach whole.
A coverage line after the header reports the complete count. A `[files complete: [...] omitted: [...]]` line right after it lists every attached complete file and omitted file in one place — check that line instead of scanning sections.

The setting lives in `/hashline-config` as Auto-read all and in `config.json` as `autoReadAll` (`"off"`, `"on"`, or `"git"`; older configs with `true` or `false` are read as `"on"` or `"off"`). Extra folders and files are ignored via `/hashline-config` as Ignore folders/files and via `config.json` as `autoReadAllIgnore` (array of folder names, file names, or globs, for example `["docs", "scratch.md", "*.test.ts"]`). A single-segment entry skips any folder or file with that exact name (case-insensitive); an entry containing glob characters (`*`, `?`, `[`, `]`, `{`, `}`) is matched as a glob against the file name, or against the whole relative path when it also contains a slash, with the same syntax as `anchor_grep`'s `glob`; any other entry with a slash (for example `"src/tmp"`) skips that path. Custom ignores are counted with the vendor/name/pattern skips in the footer.

## Tool result details

All five tools return machine-readable metadata in `details` alongside the model-visible text.

| Tool | `details` |
| --- | --- |
| `read` | `truncation` (set when output was truncated), `snapshotId` (a `v2\|path\|ino\|mtime\|ctime\|size` fingerprint), `nextOffset` (use as the next `offset`), and `metrics` with `truncated` and `next_offset`. |
| `replace`, `insert` | `diff` (post-edit diff, capped, with current anchors on `+HASH│` and ` HASH│` rows; a same-message batch reports the combined diff on its last call and an empty diff on earlier calls), `patch` (a standard unified patch for external tools, capped like the diff), `patchTruncated` (true when the patch was cut or skipped for a pair over 1MB and can no longer be applied as-is), `firstChangedLine`, `snapshotId`, `classification` (`"noop"` when nothing changed), `batch` (`{ id, size, last, total }` marking same-message batch membership; earlier members also carry `aborted: true` and `abortMessage` after a batch abort), and `metrics`: `edits_attempted`, `edits_noop`, `warnings`, `classification` (`"applied"` or `"noop"`), `changed_lines` (`{ first, last }`), `added_lines`, `removed_lines`. |
| `undo_last_change` | `diff` (the undo diff with restored anchors), `patch`, `patchTruncated`, and `metrics` in the same shape as `replace`. |
| `anchor_grep` | `metrics` with `matches` (capped at `limit`), `files`, and `truncated`; `truncation` (the standard pi truncation report) when output was cut; and `linesTruncated` (true when long lines were shown as fragments). |

## Settings

| Command | Description |
| --- | --- |
| `/hashline-config` | Open the settings window: auto-read anchors, auto-read all mode, ignore folders/files, diff context lines, `anchor_grep` tool, required `path`, and strict input. Persists across sessions. |
| `/clear-anchors` | Clear the session's anchor claims. Anchors are re-claimed on the next `read`. |

Settings live in `~/.config/pi-hashline-edit-pro/config.json`, created when a setting is first changed in `/hashline-config`:

```json
{
  "autoRead": true,
  "autoReadAll": "off",
  "autoReadAllIgnore": [],
  "anchorGrepEnabled": true,
  "requirePath": false,
  "strictInput": false,
  "diffContextLines": 1
}
```

On non-Windows platforms the directory honors `XDG_CONFIG_HOME` when set (falling back to `~/.config`); on Windows it always uses `~/.config`.

## How anchors work

Anchors are allocated, never derived. Every line that is served to you, by `read`, `anchor_grep`, the auto-read block after `write`, or a post-edit diff, gets the next free anchor from the session's pool, claimed by walking the table with a large stride (roughly the golden ratio of the anchor space) coprime to it, so consecutively minted anchors land in unrelated regions of the table instead of sharing leading characters. Each session seeds its walk from its own offset (derived from the session key and the process id), so concurrent sessions mint different sequences instead of identical ones: an anchor minted in one session is unknown in another and is rejected with `[E_STALE_ANCHOR]` rather than resolving to a different file. Ownership is exclusive: an anchor is owned by one file's line until it is freed (the line was edited, the file was written or deleted, or you ran `/clear-anchors`). Minting prefers anchors the session has never used; when a bounded fresh-anchor probe finds nothing, freed anchors are recycled after their stale served records are purged, so an anchor is never shared by two live lines. Because ownership is exclusive, an anchor resolves to exactly one file. Two byte-identical lines never share an anchor, and that guarantee sets the file size cap: at most 1,353,139 lines per file, beyond which `read`, `replace`, and `insert` reject with `[E_FILE_TOO_LARGE]` (use `write` for very large files).

The table is curated for tokenizers, not for humans. Every anchor is the concatenation of two 2-character pieces that each encode as a single token, and beside the `│` separator the whole 5-character `anchor│` unit is verified to tokenize as exactly three tokens in each of eight modern open-weights tokenizers (Qwen 3.5, DeepSeek V4, Gemma 4, GLM 5.3 Flash, Tencent Hy4-preview, MiniMax M3, MiMo V2.5, Kimi K3). The shipped table is the intersection that satisfies the criterion on all of them; Nemotron 3 Ultra is the one modern tokenizer excluded. An anchor therefore costs 2 tokens on a read row and 2 in an edit call, with the `│` separator as the third. Anchors are letters only. The table is shipped as `src/hashline/anchor-table.json`.

Each line also carries a content checksum. The line is canonicalized (carriage returns stripped, trailing whitespace trimmed) and hashed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm). The canonicalization keeps the checksum stable across editor-save cycles that add or remove trailing whitespace. A line over 500 bytes is hashed from its first 500 bytes.

Allocated anchors live in a persistent per-file snapshot (`~/.config/pi-hashline-edit-pro/hash-store.sqlite`) keyed by content checksum, so resume-after-restart and cross-session edits reuse ownership instead of minting duplicates. Each session also appends an ownership log (`allocate`/`free`/`clear` events) to a sidecar file under `~/.config/pi-hashline-edit-pro/sessions/`; the fold of that log is the session's source of truth, sidecars whose session file is gone are garbage-collected at startup (never the sidecar of a session that is currently loaded in this process), and the in-memory ownership of a session is released when that session shuts down and rebuilt from its sidecar on next use.

When a range is edited, the mapping between old and new content is computed per span: lines whose content is unchanged keep their allocated anchors, anchors of removed lines are freed, and every genuinely new line is minted a fresh anchor. Anchors are never assigned by matching content; only positional survival across an edit preserves one.

Two guarantees make this safe even with duplicated content:

- An edited range never borrows an anchor from a line outside it. Lines outside the replaced range keep their anchors unconditionally, even when their content is byte-identical to lines inside the range.
- "Replace X with X" doesn't rotate the anchor: a line whose content is unchanged after an edit keeps its allocated anchor positionally. Every other line is minted fresh, so an anchor is never assigned by content matching.

A no-op replace never changes the file, so anchors remain valid. On first run after upgrading from an older version, the previous `hash-store.json` is imported once and renamed to `hash-store.json.bak`.

On POSIX systems, the state directory is restricted to mode `0700` and the SQLite database plus its WAL/SHM sidecars to `0600`. The undo table contains the complete pre-edit and post-edit text for the latest edit to each file, so the store should still be treated as sensitive data.

## Error and warning codes

Codes starting with `E_` are errors: nothing was written — except `File was written; anchor finalization failed`, which means the file was written and one undo reverts it. Codes starting with `W_` are warnings: the call succeeded with an auto-fix notice; check `classification` (`applied` vs `noop`) in `details.metrics` to tell whether bytes changed.

| Code | Meaning |
| --- | --- |
| `[E_BAD_SHAPE]` | Request envelope or edit item has unknown, missing, or wrongly-typed fields (for example `replacement_lines` must be an array of strings, one element per line), content contains a NUL byte (`U+0000`), which would make the file binary, or a grep `glob` has invalid bracket or brace syntax. |
| `[W_BAD_SHAPE]` | Auto-corrected request slip reported as a warning (for example stringified array text that could not be parsed and was kept as one literal line). |
| `[E_BAD_REF]` | An anchor in `remove_from`/`remove_to` is not a bare 4-character anchor (the anchor table is letters only). |
| `[W_BAD_REF]` | A pasted `anchor│` or diff-preview marker was stripped from an anchor field with a warning. |
| `[E_STALE_ANCHOR]` | An anchor is not owned in this session (it was never shown to you, or its line was edited or the file was rewritten); call `read` for fresh anchors. |
| `[W_INVALID_PATCH]` | A `replacement_lines` element is a diff-preview row (`+anchor│`, `-anchor│`, `-    │`). The marker is stripped automatically with a warning. |
| `[W_BARE_HASH_PREFIX]` | A `replacement_lines` element starts with an `anchor│` prefix. The prefix is stripped automatically with a warning. |
| `[E_WOULD_EMPTY]` | An edit would empty a non-empty file; use `write` instead. |
| `[E_NOT_FOUND]` | The path does not exist. |
| `[E_ACCESS]` | The file is not readable or writable. |
| `[E_NOT_TEXT]` | The path is a directory, binary file, image, or UTF-16/UTF-32 encoded text; hashline editing only supports text files. |
| `[E_UNDO_STALE]` | `undo_last_change` refused: the file was modified after the last edit. The undo record is kept until the file matches the edited state again or a new edit replaces it. |
| `[E_UNDO_UNAVAILABLE]` | Undo history could not be persisted to the hash store; the edit was refused and the file was left unchanged. |
| `[E_RANGE_STALE]` | A line in the replaced range no longer matches what was last shown (the file changed on disk, or the line was never shown). The edit was refused; the current range is returned with fresh anchors. |
| `[E_FILE_TOO_LARGE]` | The file exceeds the 1,353,139-line hashline limit or the 100MB size limit. |
| `[E_REGISTRY]` | The anchor registry was not initialized; a serve or edit ran outside an initialized session. |
| `[E_STORE_UNAVAILABLE]` | No SQLite runtime could be loaded: the host exposes neither `node:sqlite` (Node 22.19+) nor `bun:sqlite`. The pi release binary's bundled Bun lacks `node:sqlite`; run pi under Node or a Bun build that ships SQLite. |
| `[E_WRITE_HASH_ECHO]` | A `write` `content` line reproduces a served row for this file (a bare `anchor│` read row, a `+anchor│`, ` anchor│`, or `-anchor│` diff row, or a `lineNumber │ anchor│content` grep row). The write is refused, file byte-identical; retry with bare content (remove the copied anchors). |
| `[E_PATH_CHANGED]` | A write target changed identity after it was read; the write was refused to avoid following a swapped symlink or overwriting a replacement file. |
| `[E_BATCH_OVERLAP]` | Batched `replace`/`insert` calls target overlapping ranges; the whole batch was refused. One `before` plus one `after` insert on the same anchor line is not an overlap. Retry with disjoint ranges. |
| `[E_OP_ABORTED]` | An edit aborted (a same-message batch member failed, or the file changed or was deleted after the edit started). Nothing was written. Fix the sibling failure and retry the batch, otherwise call `read` for fresh anchors and retry. The abort names the failing call and its error code when one is known. |
| `[E_UNSAFE_REGEX]` | A grep regex can trigger excessive backtracking; simplify it or search with `literal: true`. |
| `[E_GREP_FAILED]` | `anchor_grep` could not start ripgrep or ripgrep exited with an error (for example a pattern valid in JavaScript but unsupported by ripgrep's regex engine); the message carries ripgrep's output. Retry with `literal: true` or simplify the pattern. |
| `[E_GREP_TIMEOUT]` | `anchor_grep` timed out after 10 seconds; narrow `path` or simplify `pattern` and retry. |
| `[E_AUTO_READ_ALL]` | File already attached and unchanged since this session's start; the attached content is still exact. |

## Troubleshooting

- Stale anchors. `[E_STALE_ANCHOR]` means an anchor is not owned in this session: it was never shown to you, or its line was edited or the file was rewritten since. Call `read` for fresh anchors and retry.
- Range changed on disk. `[E_RANGE_STALE]` means a line inside the replaced range changed after it was last shown to you (or was never shown). Nothing was modified; the error carries the current range with fresh anchors, so retry with those without a `read`.
- Multi-conversation hosts. Anchors, served records, and ownership logs are resolved per calling session, so a tool call in one conversation is never answered by another conversation's registry; a foreign anchor fails with `[E_STALE_ANCHOR]`. Interactive previews are the one exception: pi does not pass the session into render callbacks, so when one process serves several conversations at once a preview can fall back to the most recently active session and show a stale or wrong-file diff. Previews never write files or claim anchors; run the call for the authoritative result.
- Undo scope. `undo_last_change` records are keyed by file path, not by session, so in a multi-conversation host any conversation that names the file can revert its most recent `replace` or `insert`, even one made by another conversation. Anchor ownership remains session-scoped; only undo is shared.
- Reset the anchor state. Anchors live in `~/.config/pi-hashline-edit-pro/hash-store.sqlite` (with `-wal`/`-shm` sidecars) and in per-session ownership logs under `~/.config/pi-hashline-edit-pro/sessions/`. Quit pi, delete those files, and everything is rebuilt on the next session. Anchor history is lost, but no project files are touched.
- Corrupt store. If the store fails its health check it is renamed to `hash-store.sqlite.corrupt-<timestamp>` and rebuilt automatically.
- Config directory moved. If `XDG_CONFIG_HOME` is set on a non-Windows platform, the config directory (and the anchor state inside it) lives at `$XDG_CONFIG_HOME/pi-hashline-edit-pro` instead of `~/.config/pi-hashline-edit-pro`. An existing store is not migrated automatically. To keep anchor and undo history, move the old `hash-store.sqlite` files (plus `-wal`/`-shm` sidecars) into the new directory before the first run.
- Windows drives in WSL. Editing a file under a Windows mount (`/mnt/c`, drvfs/9p) can fail with `EPERM` from `fchmod` because those filesystems do not store POSIX modes. Mode preservation is best-effort there, so `replace`, `insert`, and `undo_last_change` still write the edit.

## Development

Requires [Node.js](https://nodejs.org) 22.19 or newer and npm.

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
