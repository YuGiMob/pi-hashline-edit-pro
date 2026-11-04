# pi-hashline-edit-pro

![pi-hashline-edit-pro banner](https://raw.githubusercontent.com/YuGiMob/pi-hashline-edit-pro/master/assets/banner.svg)

[![npm version](https://img.shields.io/npm/v/pi-hashline-edit-pro.svg)](https://www.npmjs.com/package/pi-hashline-edit-pro) [![npm downloads](https://img.shields.io/npm/dm/pi-hashline-edit-pro.svg)](https://www.npmjs.com/package/pi-hashline-edit-pro) [![Explicit Edit Benchmark](https://img.shields.io/endpoint?url=https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark/resolve/main/badges/pi-hashline-edit-pro.json&style=flat-square)](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Api-hashline-edit-pro%40latest)

pi-hashline-edit-pro is an extension for [pi-coding-agent](https://github.com/earendil-works/pi) that edits files by anchor. Every line a tool serves gets a unique 5-character anchor, and you edit by anchor. Edits are never addressed by line number and nothing is fuzzy-matched, so an edit lands on the line you meant.

It is a fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW, extended with 5-character tokenizer-friendly anchors and allocation-based anchor identity.

```text
read a file; every line comes back as anchor│content:

dafox│function hello() {
emnox│  console.log("world");
hdtmx│}

replace one line by its anchor:

{ "remove_from": "emnox", "remove_to": "emnox", "text": "  console.log('hi');" }

the result is the post-edit diff with fresh anchors, so the next edit needs no re-read.
```

## Contents

- [Why anchors](#why-anchors)
- [Install](#install)
- [Quickstart](#quickstart)
- [Tools](#tools)
  - [read](#read)
  - [outline](#outline)
  - [replace](#replace)
  - [replace_match](#replace_match)
  - [insert](#insert)
  - [copy](#copy)
  - [move](#move)
  - [grep](#grep)
  - [undo_last_change](#undo_last_change)
- [Batching](#batching)
- [Auto-read](#auto-read)
- [Auto-read all](#auto-read-all)
- [Configuration](#configuration)
- [Limits](#limits)
- [Tool result details](#tool-result-details)
- [Error, warning, and hint codes](#error-warning-and-hint-codes)
- [Troubleshooting](#troubleshooting)
- [Privacy and on-disk state](#privacy-and-on-disk-state)
- [How anchors work](#how-anchors-work)
- [Benchmark](#benchmark)
- [Development](#development)
- [Credits](#credits)
- [License](#license)

## Why anchors

Line numbers shift when anything above them changes; fuzzy matching can silently pick a similar-looking line. Anchors avoid both problems:

| Dimension | Line numbers or fuzzy matching | Anchors (this extension) |
| --- | --- | --- |
| Address | a line number | a 5-character anchor minted for one line |
| After an edit | downstream numbers shift, so stale numbers can hit the wrong line | untouched lines keep their anchors; only changed lines get new ones |
| Wrong target | a fuzzy match may land on a similar line | an anchor resolves to exactly one file and line, or the edit is refused |
| Stale request | can apply silently | refused with `[E_STALE_ANCHOR]` or `[E_RANGE_STALE]`, with fresh anchors returned for the retry |

What "pro" adds over upstream `pi-hashline-edit`: the anchor table is a curated set of 5-letter lowercase anchors whose `anchor│` unit stays within three tokens (so an anchored row and an edit call stay cheap in tokens), and anchors are allocated per line and never derived from content, so byte-identical lines never share an anchor and an edit cannot re-target a different line.

## Install

Prerequisites:

- [pi-coding-agent](https://github.com/earendil-works/pi) `>= 0.99.0` (`@earendil-works/pi-coding-agent`).
- Node.js 22.19 or newer, or a Bun build that ships `bun:sqlite`.
- An SQLite runtime. The extension uses `node:sqlite` on Node 22.19+ and falls back to `bun:sqlite`. The pi release binary's bundled Bun lacks `node:sqlite`, so run pi under Node or a Bun build that ships SQLite. Without a runtime, every tool fails with `[E_STORE_UNAVAILABLE]`.

```bash
pi install npm:pi-hashline-edit-pro
```

To install from a local checkout:

```bash
pi install /path/to/pi-hashline-edit-pro
```

### What changes in your session

| Built-in | Effect |
| --- | --- |
| `read` | overridden, returns `anchor│content` rows |
| `outline` | new opt-in tool; returns the structural outline of a file, a directory, or a glob |
| `edit` | disabled |
| `grep` | replaced by an anchored `grep`; pi's own `grep` returns when Anchor grep is off |
| `copy`, `move` | disabled while Copy/move is off |
| `replace_match` | disabled while Replace match is off |
| `write` | kept; an auto-read block with fresh anchors is appended to its result |
| `bash` | untouched |

If anything of yours expects line-numbered `read` output (prompts, skills, hooks), account for the override before installing.

### Verify

After install, `read` any file and confirm the rows look like this:

```text
dafox│function hello() {
emnox│  console.log("world");
hdtmx│}
```

Then replace `emnox` and confirm the result is a post-edit diff with fresh anchors.

### Uninstall

```bash
pi uninstall npm:pi-hashline-edit-pro
```

## Quickstart

1. Read a file. Every line comes back as `anchor│content`:

   ```text
   dafox│function hello() {
   emnox│  console.log("world");
   hdtmx│}
   ```

2. Replace a line by its anchor. One edit per call, fields at the top level:

   ```json
   {
     "remove_from": "emnox",
     "remove_to": "emnox",
     "text": "  console.log('hi');"
   }
   ```

3. Read the post-edit diff. `-anchor│` rows are dead anchors; `+anchor│` and ` anchor│` rows are live, so you can keep editing without re-reading:

   ```text
   ...
   -emnox│  console.log("world");
   +qwerx│  console.log('hi');
   ...
   ```

4. Revert the last `replace` or `insert` on the file with `undo_last_change`, whose one argument is the path:

   ```json
   { "path": "src/hello.ts" }
   ```

   Undo is single-level and survives restarts.

Nothing commits until an edit call returns: the extension validates the request before touching the file, and refuses the edit when the file's served range changed on disk.

## Tools

The extension registers nine tools: `read`, `outline`, `replace`, `replace_match`, `insert`, `copy`, `move`, `grep`, and `undo_last_change`. The built-in `edit` tool is disabled. `copy` and `move` are enabled by default; turn Copy/move off in `/hashline-config` to remove both. `replace_match` is enabled by default; turn Replace match off in `/hashline-config` to remove it. `outline` is off by default; turn Outline tool on in `/hashline-config` to enable it, which also activates it when the host's default tool list omits it. `replace`, `replace_match`, `insert`, `copy`, and `move` do not need a `path` parameter by default: the file is resolved from the anchors' session ownership alone, so an edit can only land on the file the anchors were served for. A `path` passed anyway is checked against anchor ownership: a matching path is accepted, a mismatch is rejected. Opt in with `/hashline-config` to require `path` in `replace`, `replace_match`, `insert`, `copy`, and `move` for RPC visibility (for example pimacs.el); anchors still resolve the target and `path` must match.

### read

`read` returns a text file with every line prefixed by `anchor│content`. The anchor is the line's address. `offset` accepts a 1-indexed line number or a served anchor; with an anchor, `limit` counts the lines to return starting at that anchor row. Anchor offsets are stable across edits and return the same editable rows.

| Parameter | Description |
| --- | --- |
| `path` | Path to the file (relative or absolute). |
| `offset` | Line number (1-indexed) or a served anchor to start reading from. |
| `limit` | Maximum number of lines to return from `offset`. |

Output is capped at 2000 lines and 50KB. Paged output ends with a continuation hint, for example `[Showing lines 1-50 of 120. Use offset=emnox to continue.]`. When the `outline` tool is enabled, a truncated read appends a notice pointing at it.

A line whose `anchor│content` row exceeds 50KB is replaced by a marker that keeps the line's anchor: `anchor│[Line N is 2.2MB, exceeds 50.0KB; content not shown. Use bash: sed -n 'Np' <path> | head -c 51200]`. The marker is served like a normal row, so the whole line can still be replaced through it.

Edge cases:

- Images (JPEG, PNG, GIF, WebP, BMP) come back as visual attachments. Other image formats (AVIF, HEIC/HEIF, TIFF, ICO, JPEG 2000, JPEG XL, PSD, APNG) are rejected as binary, since the built-in renderer cannot attach them.
- Binary files and directories are rejected. A magic-signature match is ignored when the sampled bytes contain no NUL and decode as UTF-8, so a text file that happens to start with `BM` or `8BPS` still reads as text. A NUL byte anywhere rejects the file.
- UTF-16 and UTF-32 text (detected by BOM) is rejected, since editing it would corrupt the file.
- An empty file comes back as one empty-line row (`anchor│`); replace that anchor to insert content.
- BOMs are stripped for display. Non-UTF-8 bytes are shown as `U+FFFD`; editing such a file rewrites it as UTF-8, with a warning.
- Files over 1,353,139 lines or 100MB are rejected with `[E_FILE_TOO_LARGE]`.

### outline

`outline` returns the structural outline of a file, a directory, or a glob: a `=== path (language) — N lines ===` header per file, then one `anchor│content` row per symbol whose content is the first line of that symbol's declaration (annotations, decorators, and attributes excluded, and outside the symbol's span). Rows cover top-level declarations and the members of a type or module; a declaration inside a function body is never a row, whatever `depth` you pass. A `[limit N]` line under a multi-line symbol is the span to pass as `read`'s `limit` when reading the body from that anchor, and an `[N nested]` line marks children hidden by `depth`. Hiding children that way is a view choice rather than truncation, so `truncated` stays false and the section still counts as complete. The structured result reports `complete`, which is true only when no row or byte cap cut the outline, every rendered row was served, no line was skipped for a missing anchor, and no outlined file's anchors were reclaimed; a head-and-tail preview that omits lines is incomplete. Files the parser cannot outline, and supported files with no symbols, fall back to the same head-and-tail preview auto-read all uses, followed by a note that names the reason. Another note says when the parser could not read part of a file (a syntax error, or syntax the vendored grammar does not cover), since symbols in that part may be missing. A row whose line is longer than 200 characters is clipped and is not served for editing, even when an `E_RANGE_STALE` or `E_STALE_ANCHOR` error shows it again, so read that line first. The tool is offered only while Outline tool is on in `/hashline-config`.

A directory or glob outlines every supported source file it matches, sorted by path, with files separated by a blank line. Listing starts at the named folder (or the glob's literal prefix): inside a Git work tree it uses tracked and untracked-but-not-ignored files, otherwise a filesystem walk, and it skips the folders and files auto-read all excludes plus your `autoReadAllIgnore` list. `*` and `**` both cross folders, as in `grep`'s `glob`. All files share the 400-row cap and the 50KB budget; each file gets at least 20 rows, or an equal share of what is left, so one large file does not hide the rest. Files over 200KB are skipped before reading, and a batch stops once it has read 400,000 source lines so files the output would not show cannot exhaust the session's anchor pool. When the budget runs out, a footer names how many files were not outlined and how to narrow the request. Listed paths that are no longer regular files (deleted, or symlinks) are dropped silently; a file that fails to read (binary, oversized, or unreadable) is skipped with a notice. All notices count against the budget, and each outlined file's own notes are always kept. A path that exists is never read as a glob, so `app/[id].ts` names that file; otherwise `*`, `?`, `[...]`, or `{a,b}` makes it a glob. A pattern that matches no supported file returns `[E_NOT_FOUND]`, and an invalid glob returns `[E_BAD_SHAPE]`.

| Parameter | Description |
| --- | --- |
| `path` | A file (relative or absolute), a directory, or a glob such as `src/**/*.ts`, relative to the working directory. |
| `depth` | Nesting depth: `0` lists top-level symbols only, `1` adds their members, and the default is `2` (maximum `10`). |

Rows are the file's real lines, so an outline anchor is editable with `replace` or `insert` without a separate `read`, exactly like an auto-read-all outline row. The outline shows only each symbol's declaration line, so an edit inside a body still needs a `read` of that span.

### replace

`replace` removes a range of lines and puts new lines in their place. One edit per call, with the fields at the top level:

| Field | Description |
| --- | --- |
| `remove_from` | 5-char anchor marking the FIRST line to remove (inclusive). |
| `remove_to` | 5-char anchor marking the LAST line to remove (inclusive). |
| `text` | The exact text to write in place of the removed range, as one string: `""` deletes the range. A trailing line break sets the newline of the last line written instead of adding a blank line; a lone newline writes one blank line. Embedded `\r\n`/`\r`/`\n` are preserved; escapes in the tool call are decoded once when the call is parsed, and the tool then writes the string it receives as-is, never decoding again — `\uXXXX` is the character, `\\uXXXX` the literal text. Legacy arrays are converted to text (elements joined with LF); prefer the string form. |

Example: read showed `hasux│old` and `arvmx│old2`; to replace both:

```json
{
  "remove_from": "hasux",
  "remove_to": "arvmx",
  "text": "new line 1\nnew line 2"
}
```

Single line: use the same anchor for `remove_from` and `remove_to`.
A deletion keeps blank lines at the edges of the removed range, so the separators around a block survive the edit; target a blank line on its own to delete it. Deleting every line empties the file; the result names the new empty-line anchor, so a follow-up `replace` on it can seed content without a `read`.

The extension checks the request before any file I/O, so a bad request never touches the file.

Auto-fixable slips fall into two groups. Fixed silently: embedded newlines and a legacy array payload (a single-element array that holds stringified array text, even with a trailing JS method call, for example `[…].map(s => s)`, is unwrapped). Fixed with a warning or a hint: a reversed `remove_from`/`remove_to` range is applied in document order with an `[H_RANGE_REVERSED]` hint; a leftover `anchor│` prefix in `text` or a pasted served row in the anchor fields (a bare `abdef│` prefix, a line-numbered row such as `12:│ abdef│content`, or an `abdef (line 12)` suffix) and diff-preview rows pasted into the replacement are stripped with a warning.

Content containing a NUL byte (`U+0000`) is rejected with `[E_BAD_SHAPE]` before any file I/O: writing it would make the file binary, so use an empty replacement to delete. This applies to the `text` field of both `replace` and `insert`.

Every line in the removed range must match what was last shown to you, except that a pure deletion (an empty replacement) verifies only the first and last line of the range and removes the interior as it currently stands. The extension records the `anchor│content` rows it serves (`read` output, `grep` output, the auto-read block after `write`, the `+anchor│` and ` anchor│` rows of post-edit diffs, the current-range rows of `[E_RANGE_STALE]` feedback, and the context rows of stale-anchor feedback) and verifies the whole range against that record before writing. A line that changed on disk since it was shown, or an anchor that is not live in this session, refuses the edit with `[E_RANGE_STALE]` or `[E_STALE_ANCHOR]` and returns the current range with fresh anchors, so the retry needs no `read`. An owned anchor enters the served record when its row is shown (after a restart, restored ownership counts as shown), so a file with no owned anchors cannot be edited by anchor at all; call `read` first. An owned line that was never shown, for example beyond an auto-read preview's truncation cap, is refused with `[E_RANGE_STALE]` and returns the current range, so the retry still needs no `read`; only lines strictly between the boundaries of a pure deletion are exempt.

An edit that changes neither content nor line endings reports `No changes made` and leaves the anchors alone.

After a successful edit, the diff is capped at 50KB. A row over 50KB is shown as a marker that keeps the row's anchor, and only the rows shown in the capped diff are recorded as served. The same caps apply to the `insert` and `undo_last_change` diffs, to the interactive previews, and to `details.patch`.

### replace_match

`replace_match` changes part of a line — or the same fragment on several lines of a range — without retyping the rest. `replace_from` and `replace_to` are bare anchors from served `anchor│content` rows marking the first and last line of the range searched (the same anchor for a single line). `match` is the exact text to find inside that range, and `replacement` replaces every occurrence of it; every other character stays untouched. `match` stays within one line: a single trailing line break is accepted as the line's own terminator and dropped, so the file keeps its separator, while a line break anywhere else is refused with `[E_BAD_SHAPE]` (a `match` that is only that trailing line break leaves nothing to find and is refused). `replacement` may span lines: a single trailing line break is its terminator and is dropped, a value that is only a line break counts as `""` and deletes the matches, and leading or interior breaks split the replacement into lines; new lines inherit the file's line endings. Send `match` as only the fragment that changes — never include text that `replacement` leaves unchanged — and use `replace` with the same anchors when the change covers whole lines; if `match` is an entire single-line range except indentation and trailing punctuation, that is a whole-line change. The anchors bound the search, so occurrences outside the selected range are left alone. That makes it the tool for a change the request quotes as a substring: a whole-line `replace` has to reproduce the rest of the lines, so a slipped character becomes a wrong byte, while `replace_match` leaves everything the request did not name untouched. It is enabled by default; turn Replace match off in `/hashline-config` to remove the tool.

`match` is matched against each selected line's text (LF line breaks) and every non-overlapping occurrence is replaced, left to right. Each occurrence expands to the replacement's lines: the first line continues the text before the match, the last line continues the text after it, and middle lines sit between them. A missing match is refused with `[E_SUBSTRING_NOT_FOUND]` and the current `anchor│content` rows, so the retry needs no `read`. The two boundary anchors are verified against what was last shown; lines strictly inside the range are searched as they currently stand on disk.

`match` must be isolated. An occurrence whose own edge character and the character just outside it are both identifier characters is embedded in a larger identifier, and replacing it would rewrite text the request does not name. The guard covers letters, digits, `$`, `_`, and Unicode identifier characters (including combining marks and astral letters), so `Context` inside `createContext`, `ThemeContext`, or `$themeContext` is caught before anything is written. Every occurrence in the selected range is pre-checked; if any is embedded the whole call is refused with `[E_MATCH_NOT_ISOLATED]`, nothing is written, and the error names the first offending line and column, up to three of the offending `anchor│content` rows, and the identifier each match sits in. A match bounded by whitespace, punctuation, the line edges, or a whole-line fragment is unaffected. When replacing a fragment inside an identifier is deliberate, pass `allowEmbeddedMatch: true` on that call; every occurrence of the call is then replaced as before.

In a same-message batch it joins the other calls on its file: the batch validates everything against the pre-batch state and commits once, with one undo. A missing `match` or an embedded `match` fails that call on its own and is left out of the batch; the rest of the batch still commits. The post-edit diff carries fresh anchors, and the edit is undoable with `undo_last_change`.

### insert

`insert` adds lines after or before an existing line without removing anything. Like `replace`, `path` is unnecessary and must match anchor ownership when passed.

| Field | Description |
| --- | --- |
| `anchor` | 5-char anchor marking the line next to which the lines go. The anchor line is preserved. A pasted `+hasux│x` diff row or `anchor│` prefix is stripped automatically with a warning. |
| `direction` | `"after"` inserts below the anchor line, `"before"` above it. |
| `text` | The exact text to insert, as one string: `""` inserts one blank line (the same as a lone newline). A trailing line break sets the newline of the last line written instead of adding a blank line. Never include the anchor line. Embedded `\r\n`/`\r`/`\n` are preserved; escapes in the tool call are decoded once when the call is parsed, and the tool then writes the string it receives as-is, never decoding again — `\uXXXX` is the character, `\\uXXXX` the literal text. Legacy arrays are converted to text (elements joined with LF); prefer the string form. |

Nothing is removed and the inserted lines are written exactly as given; the anchor line and every other line stay in place. An empty `text` payload inserts one blank line. To seed an empty file, read it and insert after the `anchor│` empty-line row.

Example: add a line after `emnox│`:

```json
{ "anchor": "emnox", "direction": "after", "text": "  // log the greeting" }
```

The same safety machinery as `replace` applies: undo is saved before the write (a failed write restores the previous undo record), and line endings and BOMs survive.

### copy

`copy` duplicates a range of lines to another position without removing the source. `source_from` and `source_to` select lines in the source file; `anchor` and `direction` (`"before"` or `"after"`) select the destination line and side, and the anchor may live in a different file. An empty destination file is seeded with the copied lines. It is a served-anchor edit like `replace` and `insert`: the source's first and last lines and the destination anchor line must come from rows you were shown, and the request is refused if they changed on disk or were never served; the interior of the range is transferred verbatim and does not need to have been shown. With `requirePath` on, `path` must match the source or the destination file.

| Field | Description |
| --- | --- |
| `source_from` | 5-char anchor marking the FIRST source line to copy (inclusive). |
| `source_to` | 5-char anchor marking the LAST source line to copy (inclusive). |
| `anchor` | 5-char anchor of the destination line the block goes before or after, resolved in the destination file. |
| `direction` | `"after"` places the block below the anchor line, `"before"` above it. Within one file the insertion point must fall before the source range's first line or after its last. |

Example: read served `hasux│old` in `a.ts` and `qwerx│top` in `b.ts`; to copy `old` into `b.ts` below `top`:

```json
{ "source_from": "hasux", "source_to": "hasux", "anchor": "qwerx", "direction": "after" }
```

The source lines stay in place and keep their anchors; the copied lines are minted fresh anchors in the destination's post-edit diff and carry the source's line endings. The destination's end-of-file state is preserved either way: a destination that ended without a newline still does, and one that ended with a newline still does. A cross-file copy writes only the destination, so one `undo_last_change` on it reverts the copy. In a same-message batch, a same-file copy and a cross-file copy join the destination file's batch; the copy still duplicates the content its source anchors were served from, not the result of a sibling edit. Anchoring the block's last line with `direction: "after"` (or its first line with `direction: "before"`) duplicates the block right beside itself.

### move

`move` relocates a range of lines in one call: the range is removed from the source file and written before or after `anchor`, which may live in a different file. It takes the same fields as `copy`, and an empty destination file is seeded with the moved lines. Within one file, the destination position must sit outside the source range, and moving a range to where it already sits reports `No changes made` and leaves the anchors alone. A same-file `move` and a cross-file `move` join the same-message batch of the destination file; a cross-file `move` whose source file also gets other edits in the message runs outside any batch, so same-message edits to its destination file can then either abort or make the move fail; send such a move in a separate message. A batched cross-file `move` commits its source removal with the batch but shows only the destination diff; read the source file for fresh anchors. Lines between the source and the target keep their content but may be re-anchored; the moved lines keep their source line endings, and a cross-file move that removes every source line leaves the source file empty.

The same safety machinery as `replace` applies to both tools: undo is saved before the write (a failed write restores the previous undo record), and line endings and BOMs survive. A cross-file `move` writes two files and records one undo entry per file; undo both sides to revert the whole move, because undoing one side alone leaves the moved lines duplicated or missing. When the move is part of a batch, the destination side is reverted by that batch's undo and the source side by its own entry.

### grep

`grep` is an anchored search backed by ripgrep, registered under pi's own `grep` name. It is enabled by default; turn Anchor grep off in `/hashline-config` (or set `anchorGrepEnabled` to `false` in the config file) to register pi's plain `grep` in its place.

Every matching line is returned as `lineNumber:│ anchor│content` and each requested context line as `lineNumber-│ anchor│content`, so the `:`/`-` gutter always tells a hit from a context row. The `anchor│content` part is served exactly like `read` output, so you can target it with `replace` or `insert` without a separate `read`; the line-number gutter and `=== path ===` header give filename and line for navigation.

| Field | Description |
| --- | --- |
| `pattern` | Search pattern (regex, or literal text when `literal` is true). |
| `path` | File or directory to search (default: the current working directory). |
| `glob` | Filter files by glob; `*` matches across directories, for example `*.ts` or `**/*.spec.ts`. A leading `/` is ignored, and the pattern may be relative to the search root or the current directory. |
| `ignoreCase` | Case-insensitive search (default: false). |
| `literal` | Treat the pattern as literal text instead of a regex (default: false). |
| `context` | Lines of context before and after each match (default: 0). Context rows carry anchors too. |
| `limit` | Maximum number of matched lines to return (default: 100). |

Directory searches respect `.gitignore` (including parent directories); `.git` is always skipped, and hidden files are searched. `node_modules`, `.tmp`, and `coverage` are skipped only when a `.gitignore` lists them. Binary, image, and oversized files are skipped silently.

Patterns are evaluated by ripgrep's linear-time regex engine, so shapes that stall a backtracking engine (nested quantifiers, several `.*` terms, huge repetitions) are safe. Pattern syntax is ripgrep's Rust regex syntax; backreferences and look-around are rejected with `[E_GREP_FAILED]`. Use `literal: true` when regex behavior is unnecessary.

Output is capped at `limit` matched lines, 2000 rows, and 50KB of text, whichever comes first, with a note naming the caps that cut the results (the exact one is in `details.truncation`). A matched line whose `anchor│content` row exceeds 500 bytes is shown as a fragment around the match, with `...` marking the truncated sides; a context row over 500 bytes is shown as its head with a trailing `...`. Fragments keep the line's anchor (long lines are hashed from their first 500 bytes) and are served like full rows, so a fragmented match is still editable, and `replace` always replaces the whole line.

A path ripgrep cannot read does not abort the search. ripgrep reports the error and keeps scanning, so directory searches return every match from the readable files and add a `[grep: some paths could not be searched, so these results are partial: ...]` note naming the failure. `[E_GREP_FAILED]` is reserved for a search that produced nothing: an unusable pattern or glob, ripgrep failing to start, or an exit that left no matches at all.

Matching uses the same line model as `read`, so `^` and `$` address the file's own line boundaries: in a CRLF file `TWO$` matches the second line, and a byte order mark does not keep `^` from matching line 1. A file with lone-CR (classic Mac) endings is still read, displayed, and anchored by its real lines, and every match is attributed to the line it is on, but ripgrep only breaks lines at `\n` there, so `^` and `$` see such a file as a single line: unanchored patterns work, `^` matches only at the start of the file, and `$` only at its end. Use `read` when line anchoring matters for a lone-CR file.

### undo_last_change

`undo_last_change` reverts the most recent successful `replace`, `replace_match`, `insert`, `copy`, or `move` on a file, restoring the exact previous content, BOM and line endings included, plus the previous anchors.

- History is per-file and single-level: only the most recent `replace`, `replace_match`, `insert`, `copy`, or `move` can be reverted. A same-message batch of `replace`/`insert` calls on one file counts as one entry: one undo reverts the whole batch.
- History is persisted and survives session restarts. A failed `write` does not clear it.
- Undo records older than `undoRetentionDays` (default 30; `0` keeps them forever) are deleted when the store opens.
- Every applied `replace`, `replace_match`, `insert`, `copy`, or `move` is undoable; the undo record is saved before the edit is written.
- A cross-file `move` stores one undo entry per file; `undo_last_change` reverts the file you name, so revert both sides to undo the whole move; a batched cross-file `move` reverts its destination side with the batch's undo and its source side with its own entry.
- A successful `write` clears the history for that file.
- If the file was modified since the last edit, the undo is refused with `[E_UNDO_STALE]` rather than overwriting those changes, and the record is kept. Once the file matches the edited state again, `undo_last_change` succeeds.
- If the file was deleted since the last edit, `undo_last_change` restores it from the recorded pre-edit content.
- A path with no undo record reports `[E_UNDO_NONE]`, and `[E_NOT_FOUND]` when that path does not exist either. The record is looked up first, so a file deleted since its last edit is still restored.
- Missing-file cleanup never touches the undo record. The per-session prune removes snapshots and served records of files that no longer exist (both are recomputed on the next read), but the undo history survives, even when the file is temporarily absent during a branch switch.
- Records are keyed by file path, not by session, so in a multi-conversation host any conversation that names the file can revert its most recent edit, even one made by another conversation.

## Batching

Multiple `replace`, `replace_match`, `insert`, `copy`, and `move` calls on the same file in one assistant message are grouped per file into one batch. A cross-file `copy` and a cross-file `move` are grouped with the edits of their destination file; a cross-file `move` whose source file also has batched edits in the same message is not grouped. The batch unit is the message, not the turn: calls from separate messages in the same turn run on their own, one after another.

- A call outside a batch commits before its result returns.
- A cross-file `move` whose source file also has batched edits in the same message is not grouped: it commits on its own, and a pending same-file batch aborts safely with `[E_OP_ABORTED]` if the file changed under it.
- A batched cross-file `move` displays only the destination diff: the arrival is covered by the batch's undo, and the source removal is committed with the same batch but is not shown. Read the source file for fresh anchors; it keeps its own undo entry, and `details.patch` still contains the source patch.
- A batch validates every call against the pre-batch state and commits once, during the batch's last applied call: earlier applied calls reply `In batch N (queued)`, and the batch's last applied call shows the combined diff, with one undo reverting the whole batch. A `copy` always duplicates the content its source anchors were served from: when the source file is also edited in the message, the copy reads that file's pre-edit state, even if the source batch commits before the copy runs. A batched cross-file `move` defers the source-file removal to the batch commit, so if the batch aborts, the source file is untouched.
- Before committing, the batch validates every call against the pre-batch state. A call whose own request is invalid (`[E_BAD_SHAPE]`, `[E_BAD_REF]`, `[E_STALE_ANCHOR]`, `[E_RANGE_STALE]`, `[E_SUBSTRING_NOT_FOUND]`, `[E_MATCH_NOT_ISOLATED]`, or a strict-input rejection) is left out: it fails on its own call without an `Aborts batch N.` suffix, and the remaining calls still commit as one batch with one undo. A failure of the file, the commit, or a cross-file member aborts the whole batch instead: nothing is written, the failing call's error ends with `Aborts batch N.`, and an earlier member's row renders the abort message instead of the queued placeholder.
- A batch member accepts the same request shapes and auto-fixes as a standalone call.

Batched calls must target disjoint ranges; overlapping ranges abort the whole batch unwritten. A `copy`'s `anchor` line is the copy's destination range, so replacing or moving that same line in the batch is an overlap. One `insert`, `copy`, or cross-file `move` with `direction: "before"` and one with `direction: "after"` may target the same anchor line: the pair composes into a single insertion. A batch member that fails a batch-level step aborts its batch-mates with `[E_OP_ABORTED]`; a call left out of the batch does not.

A call whose anchors resolve nowhere never joins a batch: it runs on its own and fails with its own error (`[E_STALE_ANCHOR]`, or `[E_BAD_SHAPE]` when its request cannot be parsed), while the same-file batch in the message still commits. Calls with one stale anchor and a valid co-anchor, or with a `requirePath` path hint, are grouped into their file's batch; when their own request then fails validation against the pre-batch state, they are left out of the batch and fail on their own instead of applying partially. A `copy` or `move` whose source anchors no longer resolve cannot be grouped, because the source file cannot be identified; it runs on its own and fails with its own error. A cross-file `move` whose source file gets other edits in the message is also left out of the batch and commits on its own; same-message edits to its destination file can then either abort or make the move fail. An error that aborts a batch ends with `Aborts batch N.`; an aborted call reads `[E_OP_ABORTED] Batch N aborted: [<kind>] Call Nr <X> errored [<code>]`, naming the failing call and its error code (or `[E_OP_ABORTED] Batch N aborted.` when the failing error carries no code). Anchor capacity is preflighted before writing; if anchor finalization fails after the write, the error states the file was written with one undo available. Verify each batch diff before the next turn's edits on that file.

The hashline tools are sequential in pi, so a message that contains one runs all of its tool calls one at a time in the order given; a `read` or shell `cat` issued before the edit commits can still observe the pre-commit state, so verify in the next message with the post-edit diff or a fresh `read`.

## Auto-read

Auto-read is enabled by default. After a successful `write`, the extension reads the file and appends an `--- Auto-read (hashline anchors) ---` block, so you get fresh `anchor│content` anchors without a separate `read` call. A model matched by `disableOnModels` skips the block, and the post-edit diff substitution below is skipped with it.

After `replace`, `replace_match`, `insert`, `copy`, `move`, and `undo_last_change`, the result shows the post-edit diff. Inside a same-message batch, only the batch's last applied call shows the combined diff, headed by a `batch N:` line; earlier applied calls reply `In batch N (queued)`. The `+anchor│` and ` anchor│` rows carry the current anchors, so follow-up edits can anchor on the diff directly. The `-anchor│` rows show removed lines with their old anchors, which are stale after the edit. When the context line next to a change is blank or whitespace-only, one more context line is shown in that direction, so the change stays anchored to visible content. Call `read` when you want the full file's anchors.

An edit that changes only line endings has no content diff; the result still reports `applied`, and one `undo_last_change` reverts it.

Auto-read keeps the same 50KB and 2000-line budget as `read`. Auto-read and Diff context live in `/hashline-config` and persist across sessions. The post-edit diff shows 1 surrounding line by default; change Diff context in `/hashline-config` (0-10, needs Auto-read) to show more or fewer.

## Auto-read all

Auto-read all is off by default and has three modes, selected in `/hashline-config`: `off` injects nothing; `outline` attaches an anchor-stamped structural outline per file; and `full` discovers every file in the working directory that is not git-ignored (`git ls-files`, falling back to `ripgrep`, then to a directory walk) and attaches full contents. `Git repos only` is on by default and keeps the whole injection inside a git repository; turn it off to attach files in any directory. On the first turn of a session, the extension discovers the files, reads each one, and attaches the resulting `anchor│content` rows to the conversation as one extension message before the model answers. Those anchors are served exactly like `read` output, so the model can `replace` and `insert` immediately without calling `read` first. The message is injected once per session; resumed, forked, and cloned sessions that already contain it skip the injection.

Files are filtered before injection: symlinks, directories, image extensions (including SVG), binary files (a NUL byte in the first 8KB), files over 200KB, any path with a vendored segment (vendor, node_modules, bower_components, third_party, thirdparty, jspm_packages, .venv, venv, site-packages, __pycache__, .tox, .gradle, .terraform, Pods, Carthage, DerivedData, coreui, coreui-icons, case-insensitive; `resources/views/vendor` is kept so Laravel view overrides stay attached), and vendored or generated names and patterns (*.min.js, *.min.css, *.min.mjs, *-min.js, *-min.css, *.bundle.*, *.chunk.*, *.umd.js, *.map, *.lock, package-lock.json, yarn.lock, composer.lock, Gemfile.lock, Cargo.lock, poetry.lock, Pipfile.lock, go.sum, flake.lock, *.generated.*, *.gen.*, *_pb2.py, *.pb.go, *.g.dart, *.freezed.dart, *.designer.cs, *.g.cs, *.snap, _ide_helper.php, _ide_helper_models.php, .phpstorm.meta.php, .eslintcache, coreui-icons.*, coreui.css) are skipped. The attachment stops at 500 files or at a byte budget derived from the model context window (200KB floor, 2MB ceiling), and it never drops below one file; `full` also caps the budget at 2MB, while `outline` follows the context-derived budget because outlines stay compact. Files are ranked before the budget applies: working-tree changes first, then manifest and entry files, then the dominant source tree, then everything else, and no single top-level directory may take more than 40% of the budget in the first pass, so one large subtree cannot crowd out the rest. Skipped and not-attached files are named at the end of the message so the model can `read` them on demand. A model matched by `disableOnModels` skips the injection entirely.

Each attached file starts with a header (`=== path ===` in `full` mode, `=== path (language) — lines ===` in `outline` mode) followed by its anchor rows. Edit directly from the attachment with replace and insert, so no `read` is needed. `full` attaches files whole; `outline` attaches each file's structural outline within the budget. In outline mode each symbol appears as the first line of its declaration, a `[limit N]` line under it gives the span to read when the symbol spans several lines, and `[N nested]` marks children hidden by auto-read all's six-level depth cap.

A coverage line after the header reports how many attached files were served in full; a section truncated by the per-file budget, a preview that omitted lines, or one that includes a clipped row is not counted as complete. Children hidden by the outline depth cap are marked `[N nested]` and do not make a section incomplete. Each attached file begins with a `=== path ===` header, and files that were not attached are named in the footer.

The setting lives in `/hashline-config` as Auto-read all and in `config.json` as `autoReadAll` (`"off"`, `"outline"`, or `"full"`; older configs with `"on"` or `true` are read as `"full"`, `"git"` as `"full"`, `"outline(git)"` as `"outline"` — both with Git repos only on — and `false` as `"off"`), and as `autoReadAllRequireGit`, the Git repos only switch (on by default). Extra folders and files are ignored via `/hashline-config` as Ignore folders/files and via `config.json` as `autoReadAllIgnore` (array of folder names, file names, or globs, for example `["docs", "scratch.md", "*.test.ts"]`). A single-segment entry skips any folder or file with that exact name (case-insensitive); an entry containing glob characters (`*`, `?`, `[`, `]`, `{`, `}`) is matched as a glob against the file name, or against the whole relative path when it also contains a slash, with the same syntax as `grep`'s `glob`; any other entry with a slash (for example `"src/tmp"`) skips that path. Custom ignores are counted with the vendor/name/pattern skips in the footer.

## Configuration

| Command | Description |
| --- | --- |
| `/hashline-config` | Open the settings window: auto-read anchors, auto-read all mode, git repos only, ignore folders/files, disable on models, read on disabled models, diff context lines, `grep` tool, copy/move tools, replace_match tool, outline tool, required `path`, strict input, and undo retention. Persists across sessions. |
| `/clear-anchors` | Clear the session's anchor claims. Anchors are re-claimed on the next `read`. |

Settings live in `~/.config/pi-hashline-edit-pro/config.json`, created when a setting is first changed in `/hashline-config`:

```json
{
  "autoRead": true,
  "autoReadAll": "off",
  "autoReadAllRequireGit": true,
  "autoReadAllIgnore": [],
  "anchorGrepEnabled": true,
  "copyMoveEnabled": true,
  "replaceMatchEnabled": true,
  "outlineEnabled": false,
  "requirePath": false,
  "strictInput": false,
  "diffContextLines": 1,
  "undoRetentionDays": 30,
  "disableOnModels": [],
  "readOnDisabledModels": "vanilla"
}
```

| Key | `/hashline-config` label | Default | Effect |
| --- | --- | --- | --- |
| `autoRead` | Auto-read | `true` | Append the auto-read block after `write` and show post-edit diffs. |
| `autoReadAll` | Auto-read all | `"off"` | Attachment mode: `"off"`, `"outline"` (anchor-stamped per-file outlines), or `"full"` (full contents). Legacy `"git"`/`"outline(git)"` read as `"full"`/`"outline"` with Git repos only on; `"on"`/`true` read as `"full"`. |
| `autoReadAllRequireGit` | Git repos only | `true` | Run the injection only when the working directory is inside a git repository; when off, auto-read all also attaches files discovered by `ripgrep` or the directory walk. |
| `autoReadAllIgnore` | Ignore folders/files | `[]` | Extra folder names, file names, or globs skipped by auto-read all. |
| `anchorGrepEnabled` | Anchor grep | `true` | Register an anchored `grep` in place of pi's own `grep` while it is on. |
| `copyMoveEnabled` | Copy/move | `true` | Offer the `copy` and `move` tools; when off, both are removed from the active tools. |
| `replaceMatchEnabled` | Replace match | `true` | Offer the `replace_match` tool; when off, it is removed from the active tools. |
| `outlineEnabled` | Outline tool | `false` | Register the `outline` tool for the structure of a file, directory, or glob on demand; when off, it is removed from the active tools. |
| `requirePath` | Require path | `false` | `replace`, `replace_match`, `insert`, `copy`, and `move` require a `path` argument that must match anchor ownership. |
| `strictInput` | Strict input | `false` | Reject auto-fixable slips (`[W_BAD_SHAPE]`, `[W_BAD_REF]`, `[W_INVALID_PATCH]`, `[W_BARE_HASH_PREFIX]`, `[W_ANCHOR_CASE]`) with `[E_BAD_SHAPE]` instead of applying them with a warning. |
| `diffContextLines` | Diff context | `1` | Surrounding lines in post-edit diffs, 0-10 (needs Auto-read). |
| `disableOnModels` | Disable on models | `[]` | Model globs matched case-insensitively against `provider/id`, the bare `id`, and `api`, with `*` and `?` wildcards. A matching model gets no anchored edit tools, no auto-read, and no write-echo refusal; `read` stays available as pi's ordinary read unless Read on disabled models is `remove`. |
| `readOnDisabledModels` | Read on disabled models | `"vanilla"` | `read` for a model matched by `disableOnModels`: `"vanilla"` keeps pi's ordinary `read` active while the anchored edit tools stay off; `"remove"` disables `read` with the rest of the anchored tools. |
| `undoRetentionDays` | Undo retention | `30` | Days to keep undo history; records older than this are deleted when the store opens. `0` keeps them forever (0-3650). |

`disableOnModels` turns off the whole anchored surface for the models you name, so another edit tool (`apply_patch`, a shell read) can own the session without competing instructions. A match removes `outline`, `replace`, `replace_match`, `insert`, `copy`, `move`, `grep`, and `undo_last_change` from the active tools, and also `read` when Read on disabled models is `remove`, registering pi's plain `grep` for those models, and it also skips the auto-read-all injection, the auto-read block after `write`, the post-edit diff substitution, and the `write` hook that refuses a `write` echoing a served anchor. Because the extension's `read` replaces the built-in one, a matched model has no `read` at all under `remove` unless another extension provides one; the default `vanilla` gives those models pi's ordinary `read` while the anchored edit tools stay off. The list is checked on `session_start`, on `model_select`, and again on `before_agent_start`, so a model change inside a session switches the surface immediately and another extension cannot re-add the tools mid-session. The default `[]` leaves every model unchanged.

When `PI_HASHLINE_DIR` is unset or empty, non-Windows platforms honor `XDG_CONFIG_HOME` when set (falling back to `~/.config`); on Windows the directory always uses `~/.config`, where `~` is `%USERPROFILE%`. To move the directory explicitly, see [Isolated state](#isolated-state).

## Limits

| Limit | Value | Applies to |
| --- | --- | --- |
| Output cap | 2000 lines and 50KB | `read`, auto-read after `write`, post-edit diffs, patches, previews, `details.patch` |
| Oversized row | 50KB per `anchor│content` row | replaced by an anchor-keeping marker you can still edit through |
| Line cap | 1,353,139 lines per file | `read`, `outline`, `replace`, `replace_match`, `insert`, `copy`, `move` (`[E_FILE_TOO_LARGE]`) |
| File size | 100MB | all tools (`[E_FILE_TOO_LARGE]`) |
| Hash window | first 500 bytes of a line | anchor identity for long lines |
| Patch guard | 1MB of pre-edit + post-edit text | patch generation is skipped and `patchTruncated` is set |
| Grep matches | 100 matched lines by default (`limit`) | `grep` |
| Grep output | 2000 rows and 50KB | `grep` |
| Grep row fragment | 500 bytes | long match and context rows shown as `...` fragments |
| Auto-read all files | 500 files, 200KB per file | files larger than 200KB and files past the cap are omitted |
| Outline rows | 400 symbol rows and 50KB of content per file, shared across files for a directory or glob (a truncation footer may follow) | `outline`, auto-read all `outline` mode |
| Outline directory file | 200KB per file | `outline` directory/glob; larger files are skipped with a notice |
| Outline source lines | 400,000 lines | `outline` directory/glob; stops early to protect the session anchor pool |
| Auto-read all budget | 200KB floor; 2MB ceiling in `full` | total injection size derived from the model context window; `outline` is not capped at 2MB |
| Stale-range feedback | first 100 lines | rows returned with `[E_RANGE_STALE]` |
| Session anchors | 1,353,139 anchors in use | all tools; the least recently read or edited files are freed when the quota is exhausted (`[W_ANCHOR_RECLAIMED]`) |
| Undo retention | 30 days by default (`undoRetentionDays` 0-3650) | `undo_last_change` history |

`grep` uses the same 100MB file-size cutoff as `read`. Files over the line cap are skipped silently in directory searches.

## Tool result details

All nine tools return machine-readable metadata in `details` alongside the model-visible text.

All nine tools also declare an `outputSchema` and return `structuredContent`, so codemode scripts receive anchors, line numbers, diffs, and errors as data instead of parsing the rendered text. In a codemode session `tools.read()` resolves to the file's text, like the built-in `read`; pass `anchors: true` to receive `{ text, lines, notices }`, where `text` is the raw file content of the served window and `lines` carries the anchored rows. The model still receives `content`. Every structured result is either `{ ok: true, kind, ... }` or `{ ok: false, kind: "error", error: { code, message } }`; a failed call is still a tool error (`isError: true`) and also carries `structuredContent`, so a script can branch on the code without matching the message.

`read` returns `{ kind: "read", path, text, lines, totalLines, startLine, nextOffset, truncated, blockedByLongLine, hadUtf8DecodeErrors, notices }`, where `text` is the raw file content of the served window (no anchors, no footers) and each entry of `lines` is `{ line, text, anchor, rendered }` for a row that was served (`text` there is what was shown, so an oversized line appears as its marker while keeping its anchor). `notices` carries non-file notes such as the UTF-8 rewrite note and `[W_ANCHOR_RECLAIMED]`. An image read returns `{ type: "image", data, mimeType, note }`.

`replace`, `replace_match`, `insert`, `copy`, `move`, and `undo_last_change` return `{ kind: "edit", verb, classification, path, text, diff, warnings, hints, firstChangedLine, anchors, anchorsOmitted }`, where `verb` is `"replaced"`, `"inserted"`, `"copied"`, `"moved"`, or `"undone"`, `anchors` are the live rows of the post-edit diff, and `anchorsOmitted` is true when the diff was truncated or carried no rows, meaning a fresh read is needed. A cross-file move reports the destination file and its anchors.

`outline` returns `{ kind: "outline", path, text, totalLines, depth, lines, truncated, complete, notices }`, where `text` is the outline body without the notices, `lines` is the anchored rows it served, `complete` is true only when no cap cut the outline, every rendered row was served, and no line was skipped for a missing anchor; `notices` carries notes such as the preview reason, the UTF-8 rewrite note, and `[W_ANCHOR_RECLAIMED]`; for a directory or glob, `lines` is replaced by `files: [{ path, lines, totalLines, truncated, complete }]`, one entry per outlined file, and `totalLines` is their sum; in a codemode session `tools.outline()` resolves to the served outline text (with notices) unless `anchors: true` is passed.

`grep` returns `{ kind: "grep", text, matches, files, truncated, results }`, where each entry of `results` is `{ path, matchLines, lines, hadUtf8DecodeErrors }` and `lines` uses the same `{ line, text, anchor, rendered }` shape as `read`.

| Tool | `details` |
| --- | --- |
| `read` | `truncation` (set when output was truncated), `snapshotId` (a `v2\|path\|ino\|mtime\|ctime\|size` fingerprint), `nextOffset` (use as the next `offset`), and `metrics` with `truncated` and `next_offset`. |
| `replace`, `insert` | `diff` (post-edit diff, capped, with current anchors on `+anchor│` and ` anchor│` rows; a same-message batch reports the combined diff on its last call and an empty diff on earlier calls), `patch` (a standard unified patch for external tools, capped like the diff), `patchTruncated` (true when the patch was cut or skipped for a pair over 1MB and can no longer be applied as-is), `firstChangedLine`, `snapshotId`, `classification` (`"noop"` when nothing changed), `batch` (`{ id, size, last, total }` marking same-message batch membership; earlier members also carry `aborted: true` and `abortMessage` after a batch abort), `hints` (informative `[H_*]` notices, for example literal escaped text written as sent), and `metrics`: `edits_attempted`, `edits_noop`, `warnings`, `classification` (`"applied"` or `"noop"`), `changed_lines` (`{ first, last }`), `added_lines`, `removed_lines`. |
| `replace_match` | Same shape as `replace`: `diff` (post-edit diff with current anchors), `patch`, `patchTruncated`, `firstChangedLine`, `snapshotId`, `classification` (`"noop"` when nothing changed), and `metrics` with the same counters. |
| `copy`, `move` | Same shape as `replace`: `diff` (post-edit diff with current anchors), `patch`, `patchTruncated`, `firstChangedLine`, `snapshotId`, `classification` (`"noop"` when a move changes nothing), and `metrics` with the same counters. |
| `undo_last_change` | `diff` (the undo diff with restored anchors), `patch`, `patchTruncated`, and `metrics` in the same shape as `replace`. |
| `outline` | `truncated` (true when the row or byte cap cut the outline), `complete` (true only when no cap cut the outline, every rendered row was served, and no line was skipped for a missing anchor), `snapshotId`, and `metrics` with `rows` (every rendered symbol row, including clipped ones) and `truncated`; structured `lines` holds only the rows that were served for editing. |
| `grep` | `metrics` with `matches` (capped at `limit`), `files`, and `truncated`; `truncation` (the standard pi truncation report) when output was cut; and `linesTruncated` (true when long lines were shown as fragments). |

`snapshotId`, `firstChangedLine`, and `metrics.warnings` are the three fields external consumers most often read; `snapshotId` is a string fingerprint, `firstChangedLine` is a 1-based line number on the result file, and `metrics.warnings` counts the `[W_*]` notices in `details.warnings`; hint `[H_*]` notices live in `details.hints` and are not counted.

## Error, warning, and hint codes

Codes starting with `E_` are errors: nothing was written, with one exception. `File was written; anchor finalization failed` means the file was written and one undo reverts it. Codes starting with `W_` are warnings: the call succeeded with an auto-fix notice or an anchor-reclaim notice; check `classification` (`applied` vs `noop`) in `details.metrics` to tell whether bytes changed. Codes starting with `H_` are hints: the call succeeded and the file holds exactly what was requested, so the notice is informational, never blocks an edit (not even in strict-input mode), and is reported in `details.hints` instead of `details.warnings`.

Most common, with the fix:

- `[E_STALE_ANCHOR]`: the anchor is stale: it was never served in this session, or its line was edited or its anchors were freed since. Call `read` for fresh anchors and retry.
- `[E_RANGE_STALE]`: a line in the replaced range changed on disk or was never shown (a pure deletion checks only its first and last line). The error already returns the current range with fresh anchors; retry with those.
- `[E_FILE_TOO_LARGE]`: the file exceeds the 1,353,139-line hashline limit or the 100MB size limit. Use `write` for very large files.
- `[E_STORE_UNAVAILABLE]`: no SQLite runtime. Run pi under Node 22.19+ or a Bun build that ships `bun:sqlite`.
- `[E_WRITE_HASH_ECHO]`: a `write` content line contains a copied served row. Remove the anchors and retry.
- `[E_GREP_TIMEOUT]`: ripgrep timed out after 10 seconds. Narrow `path` or simplify `pattern` and retry.

Full reference:

| Code | Meaning |
| --- | --- |
| `[E_CONFIG]` | `PI_HASHLINE_DIR` is nonempty but not an absolute path. |
| `[E_BAD_SHAPE]` | Request envelope or edit item has unknown, missing, or wrongly-typed fields (for example `text` must be a string holding the exact text), content contains a NUL byte (`U+0000`), which would make the file binary, a grep `glob` has invalid bracket or brace syntax, or a `replace_match` `match` spans lines: `match` contains a line break after the optional trailing one. |
| `[W_BAD_SHAPE]` | Auto-corrected request slip reported as a warning (for example legacy array text that could not be parsed and was kept as one literal line). |
| `[E_BAD_REF]` | An anchor field does not yield a 5-character anchor. Anchors come from read or grep output and are exactly 5 lowercase letters; a pasted served row in an anchor field is reduced to its anchor first. |
| `[E_SUBSTRING_NOT_FOUND]` | `replace_match` did not find `match` in the selected range. The current `anchor│content` rows are returned, and when `match` looks like a retyped copy of a single-line range the message names the first mismatching column; copy only the fragment that changes from the served row and retry, or use `replace` for a whole-line rewrite. |
| `[E_MATCH_NOT_ISOLATED]` | `replace_match` found `match` inside a larger identifier (its edge and the character just outside it are both identifier characters: letters, digits, `$`, `_`, or Unicode identifier characters). Nothing is written. The message names the first embedded occurrence's line and column, up to three offending `anchor│content` rows, and the identifier each match sits in; include the whole identifier in `match`, narrow the range, or pass `allowEmbeddedMatch: true` when replacing inside an identifier is intended. |
| `[W_BAD_REF]` | A pasted served row (bare `anchor│content`, a line-numbered grep row, or an `anchor (line N)` suffix) or diff-preview marker was stripped from an anchor field with a warning. |
| `[W_ANCHOR_CASE]` | An edit anchor field used uppercase or mixed case; it was lowercased to the lowercase anchor with a warning (strict input rejects it). `read`'s `offset` lowercases a case-only mismatch silently. |
| `[E_STALE_ANCHOR]` | An anchor is stale: it was never served in this session, or its line was edited, the file was rewritten, or its anchors were freed since; the message names the case. Call `read` for fresh anchors. |
| `[W_INVALID_PATCH]` | A `text` line is a diff-preview row (`+anchor│`, `-anchor│`, `-    │`). The marker is stripped automatically with a warning. |
| `[W_BARE_HASH_PREFIX]` | A `text` line starts with an `anchor│` prefix. The prefix is stripped automatically with a warning. |
| `[W_ANCHOR_RECLAIMED]` | The session's anchor quota was exhausted, so all anchors of the listed files (the least recently read or edited) were freed to make room. Read those files again before editing them. |
| `[H_LITERAL_ESCAPE]` | A payload field contains literal escaped text such as `\uXXXX`, `\n`, `\t`, `\r`, or `\"` (one hint per distinct escape, up to three). The file receives those backslash characters as written, because escapes in the tool call are decoded once when the call is parsed (`\uXXXX` → the character), so a doubled escape (`\\uXXXX`) lands literally. The hint is one line: `text: "\u200b" written as literal text (kqafq│ col 31).` names the field, the escape, and up to three affected anchors with their columns; when more than three rows carry it, it gives `on 10 rows; undo_last_change if unintended.` instead of the anchor list. |
| `[H_UNICODE_LOST]` | The new text is missing an invisible or look-alike character (for example `U+200B`, `U+2060`, `U+00A0`, or a smart quote) that a replaced row has, or that a context row sharing a long run with an inserted line has. The edit applied as sent; the one-line hint names the live anchor of the offending result row, when one can be identified, and the character as its JSON escape, for example `[H_UNICODE_LOST] zbbbx│ missing "\u2060"; kqafq│ has it at col 31.` The column is attributed to the row that had the character: `; kqafq│ has it at col N` while that row's anchor is still valid, otherwise `; the replaced row had it at col N`, and a dead anchor is never named. When another look-alike character (including `U+FFFD`) takes its place, the hint reports the substitute with `[H_UNICODE_SWAPPED]` wording. |
| `[H_UNICODE_SWAPPED]` | The new text uses a different invisible or look-alike character than the line it matches (for example `U+200D` where that line has `U+200B`, or an ASCII stand-in such as `.` for `。` or a space for `U+00A0`). The edit applied as sent; the one-line hint names the live anchor of the offending result row with both characters as JSON escapes, for example `[H_UNICODE_SWAPPED] zbbbx│ has "\u200d" at col 21; expected "\u200b".` A surviving reference row appears as `; kqafq│ has "\u200b"`; a replaced row's dead anchor is never named. The substitute may also be `U+FFFD`, for example where a row has `U+00A0`. |
| `[H_TRAILING_WHITESPACE]` | The new text differs from the replaced line only in trailing whitespace. Anchor checksums trim trailing whitespace, so the change does not invalidate the anchor; the one-line hint names the old and new trailing-whitespace counts and the column, for example `[H_TRAILING_WHITESPACE] 1 trailing whitespace character at col 7; kqafq│ had 0.` |
| `[H_INDENT_MISMATCH]` | The new line has fewer leading whitespace characters than a structurally similar row (a reference row near the anchor line for an insert, or the replaced line). The edit applied as sent; the one-line hint names both counts and the reference anchor, for example `[H_INDENT_MISMATCH] new line has 0 leading whitespace characters; kqafq│ has 2.` Copied or moved blocks are not checked, because their indentation comes from the source lines. |
| `[H_SEPARATOR_MOVED]` | An insert landed its text directly against the anchor line, and the blank line that separated the anchor from its neighbor was displaced to the other side of the inserted text. The edit applied as sent; the one-line hint names the anchor and which side lost the blank line, for example `[H_SEPARATOR_MOVED] blank separator above kqafq│ was displaced; add a blank line before kqafq│ if unintended.` |
| `[H_SEPARATOR_LOST]` | A pure deletion removed a run of blank lines that sat between two content lines. The edit applied as sent; the one-line hint names the two surviving anchors and the removed count, for example `[H_SEPARATOR_LOST] deletion removed 2 blank lines between aaaaz│ and ddddz│.` |
| `[H_RANGE_REVERSED]` | The `remove_from` anchor resolved to a line after `remove_to`. The call applied the range in document order; the one-line hint names the line range used. |
| `[E_NOT_FOUND]` | The path does not exist. |
| `[E_ACCESS]` | The file is not readable or writable. |
| `[E_NOT_TEXT]` | The path is a directory, binary file, image, or UTF-16/UTF-32 encoded text; hashline editing only supports text files. |
| `[E_UNDO_STALE]` | `undo_last_change` refused: the file was modified after the last edit. The undo record is kept until the file matches the edited state again or a new edit replaces it. |
| `[E_UNDO_UNAVAILABLE]` | Undo history could not be persisted to the hash store; the edit was refused and the file was left unchanged. |
| `[E_UNDO_NONE]` | `undo_last_change` found no recorded edit for the file. Nothing was changed; make an edit first. |
| `[E_RANGE_STALE]` | A line in the replaced range no longer matches what was last shown (the file changed on disk, or the line was never shown; a pure deletion checks only its first and last line). The edit was refused; the current range is returned with fresh anchors. |
| `[E_FILE_TOO_LARGE]` | The file exceeds the 1,353,139-line hashline limit or the 100MB size limit. |
| `[E_REGISTRY]` | The anchor registry was not initialized, or the session's registry was released because the session was replaced or reloaded; a serve or edit ran without a usable session. Retry the operation in the current session. |
| `[E_STORE_UNAVAILABLE]` | No SQLite runtime could be loaded: the host exposes neither `node:sqlite` (Node 22.19+) nor `bun:sqlite`. The pi release binary's bundled Bun lacks `node:sqlite`; run pi under Node or a Bun build that ships SQLite. |
| `[E_WRITE_HASH_ECHO]` | A `write` `content` line reproduces a served row for this file (a bare `anchor│` read row, a `+anchor│`, ` anchor│`, or `-anchor│` diff row, or a `lineNumber:│ anchor│content` grep row). The write is refused, file byte-identical; retry with bare content (remove the copied anchors). |
| `[E_PATH_CHANGED]` | A write target changed identity after it was read; the write was refused to avoid following a swapped symlink or overwriting a replacement file. |
| `[E_BATCH_OVERLAP]` | Batched edit calls target overlapping ranges; the whole batch was refused. One `before` plus one `after` insert on the same anchor line is not an overlap. Retry with disjoint ranges. |
| `[E_OP_ABORTED]` | The edit was aborted before writing: the file changed or was deleted after it was read (a single edit or a cross-file move reports the file; a batch reports the batch and the failing call), the base read failed, a cross-file member could not be prepared, or the composed result exceeded a limit. Nothing was written; a call whose own request is invalid is left out of the batch instead. Fix the cause and retry, otherwise call `read` for fresh anchors and retry. The batch abort names the failing call and its error code when one is known. |
| `[E_GREP_FAILED]` | `grep` could not start ripgrep or ripgrep exited with an error (for example a pattern with backreferences, look-around, or invalid regex syntax, which ripgrep's regex engine does not support); the message carries ripgrep's output. Retry with `literal: true` or simplify the pattern. A path ripgrep cannot read is not one of these: the search returns the readable matches with a partial-results note. |
| `[E_GREP_TIMEOUT]` | `grep` timed out after 10 seconds; narrow `path` or simplify `pattern` and retry. |

## Troubleshooting

- Stale anchors. `[E_STALE_ANCHOR]` means an anchor no longer addresses a line: it was never served in this session, or its line was edited, the file was rewritten, or its anchors were freed since. The message names the case. Call `read` for fresh anchors and retry.
- Range changed on disk. `[E_RANGE_STALE]` means a line inside the replaced range changed after it was last shown to you (or was never shown; a pure deletion only needs its first and last line shown). Nothing was modified; the error carries the current range with fresh anchors, so retry with those without a `read`.
- Multi-conversation hosts. Anchors, served records, and ownership logs are resolved per calling session, so a tool call in one conversation is never answered by another conversation's registry; a foreign anchor fails with `[E_STALE_ANCHOR]`. Interactive previews are the one exception: pi does not pass the session into render callbacks, so when one process serves several conversations at once a preview can fall back to the most recently active session and show a stale or wrong-file diff. Previews never write files or claim anchors; run the call for the authoritative result.
- Undo scope. `undo_last_change` records are keyed by file path, not by session, so in a multi-conversation host any conversation that names the file can revert its most recent `replace` or `insert`, even one made by another conversation. Anchor ownership remains session-scoped; only undo is shared.
- Reset the anchor state. Anchors live in `~/.config/pi-hashline-edit-pro/hash-store.sqlite` (with `-wal`/`-shm` sidecars) and in per-session ownership logs under `~/.config/pi-hashline-edit-pro/sessions/`. Quit pi, delete those files, and everything is rebuilt on the next session. Anchor history is lost, but no project files are touched.
- Corrupt store. If the store fails its health check it is renamed to `hash-store.sqlite.corrupt-<timestamp>` and rebuilt automatically.
- Config directory moved. If `XDG_CONFIG_HOME` is set on a non-Windows platform, the config directory (and the anchor state inside it) lives at `$XDG_CONFIG_HOME/pi-hashline-edit-pro` instead of `~/.config/pi-hashline-edit-pro`. An existing store is not migrated automatically. To keep anchor and undo history, move the old `hash-store.sqlite` files (plus `-wal`/`-shm` sidecars) into the new directory before the first run.
- Windows drives in WSL. Editing a file under a Windows mount (`/mnt/c`, drvfs/9p) can fail with `EPERM` from `fchmod` because those filesystems do not store POSIX modes. Mode preservation is best-effort there, so `replace`, `replace_match`, `insert`, and `undo_last_change` still write the edit.
- Not sure what the extension changed. `read` returns anchored rows and the built-in `edit` is gone; that is expected. See [What changes in your session](#what-changes-in-your-session).

## Privacy and on-disk state

All state lives under the config directory (see [Configuration](#configuration)):

| Path | Contents |
| --- | --- |
| `config.json` | The settings from [Configuration](#configuration). |
| `hash-store.sqlite` (+ `-wal`, `-shm`) | Per-file snapshots of allocated anchors keyed by content checksum, plus the undo table. |
| `sessions/<key>.registry.jsonl` | The session's anchor ownership log (`allocate`/`free`/`clear` events). |

The undo table contains the complete pre-edit and post-edit text for the latest edit to each file, so treat the store as sensitive data. Undo records older than `undoRetentionDays` are deleted when the store opens, and SQLite's `secure_delete` overwrites deleted content. On POSIX systems the state directory is restricted to mode `0700` and the SQLite database plus its WAL/SHM sidecars to `0600`. Sidecar logs whose session file is gone are garbage-collected at startup (never the sidecar of a session that is currently loaded in this process); the in-memory ownership of a session is released when that session shuts down and rebuilt from its sidecar on next use. Served records live in memory only and are recomputed on the next read.

### Isolated state

Set `PI_HASHLINE_DIR` before starting pi to an absolute directory to override only this extension's state directory on all platforms. An unset or empty value preserves the XDG/home defaults; a nonempty relative value is rejected with `[E_CONFIG]`. Keep the value fixed for the lifetime of the process; the database remains a process-wide singleton.

Config, SQLite (including WAL/SHM and undo history), registry sidecars, and the legacy `hash-store.json` location all follow the override. A fresh directory starts without shared config or history: no data is copied or imported from the default directory. Legacy migration, if needed, reads only `hash-store.json` inside the selected directory. Use a separate, access-restricted directory for each isolation scope; undo contains full file text.

Background snapshot pruning and registry sidecar GC skip `EPERM`/`EACCES` without deleting records or logging each inaccessible path. Unexpected errors remain visible; tool file-access failures and SQLite errors are not silenced.

### Environment variables

| Variable | Effect |
| --- | --- |
| `PI_HASHLINE_DIR` | Absolute path overriding this extension's state directory on all platforms; an unset or empty value keeps the XDG/home defaults and a relative value is rejected with `[E_CONFIG]`. |
| `PI_HASHLINE_DEBUG` | Set to `1` or `true` to show the "Hashline Edit mode active" notification at session start. |

## How anchors work

### Request flow

```text
read / grep / auto-read-all ──► anchor registry (ownership + served records)
                                            │
edit call ──► resolve anchors ──► apply ──► commit ──► post-edit diff with fresh anchors
                                            │
                                      hash store (SQLite snapshots + undo)
```

### Allocation

Anchors are allocated, never derived. Every line that is served to you, by `read`, `grep`, the auto-read block after `write`, or a post-edit diff, gets the next free anchor from the session's pool, claimed by walking the table with a stride of 836,286 entries (coprime to the 1,353,139-entry table), so consecutively minted anchors land in unrelated regions of the table instead of sharing leading characters. Each session seeds its walk from its own offset (derived from the session key and the process id), so concurrent sessions mint different sequences instead of identical ones: an anchor minted in one session is unknown in another and is rejected with `[E_STALE_ANCHOR]` rather than resolving to a different file. Ownership is exclusive: an anchor is owned by one file's line until it is freed (the line was edited, the file was written or deleted, you ran `/clear-anchors`, or the session's quota ran out and the file was the least recently read or edited, which frees all of its anchors and reports it in `[W_ANCHOR_RECLAIMED]`). Minting prefers anchors the session has never used; when a bounded fresh-anchor probe finds nothing, freed anchors are recycled after their stale served records are purged, so an anchor is never shared by two live lines. Because ownership is exclusive, an anchor resolves to exactly one file. Two byte-identical lines never share an anchor, and that guarantee sets the file size cap: the pool is the shipped table's 1,353,139 entries (not all 26⁵ letter combinations), so a file can hold at most 1,353,139 lines, beyond which `read`, `replace`, `replace_match`, `insert`, `copy`, and `move` reject with `[E_FILE_TOO_LARGE]` (use `write` for very large files).

### Ownership and mapping across edits

When a range is edited, the mapping between old and new content is computed per span: lines whose content is unchanged keep their allocated anchors, anchors of removed lines are freed, and every genuinely new line is minted a fresh anchor. Anchors are never assigned by matching content; only positional survival across an edit preserves one.

Two guarantees make this safe even with duplicated content:

- An edited range never borrows an anchor from a line outside it. Lines outside the replaced range keep their anchors unconditionally, even when their content is byte-identical to lines inside the range.
- "Replace X with X" doesn't rotate the anchor: a line whose content is unchanged after an edit keeps its allocated anchor positionally. Every other line is minted fresh, so an anchor is never assigned by content matching.

A no-op replace never changes the file, so anchors remain valid. On first run after upgrading from an older version, the previous `hash-store.json` is imported once and renamed to `hash-store.json.bak`.

### The anchor table is built for tokenizers

Every anchor is a 5-letter lowercase string selected so that the anchor alone tokenizes as at most two tokens and the whole `anchor│` unit as at most three tokens in each of nine modern open-weights tokenizers (DeepSeek V4 and V4.1, Qwen 3.5, Gemma 4, GLM 5.3 Flash, Tencent Hy4-preview, MiniMax M3, MiMo V2.5, Kimi K3). The shipped table is the intersection that satisfies the criterion on all of them; it also has one anchor per case-fold class, so no two anchors differ only by case. Nemotron 3 Ultra is the one modern tokenizer excluded. An anchor therefore costs at most 2 tokens, and `anchor│` at most 3, in both read rows and edit calls. Anchors are lowercase letters only. The table is generated offline and its 1,353,139-entry count is frozen so the per-file line cap stays stable; it is shipped as `src/hashline/anchor-table.json`.

### Line checksums

Each line also carries a content checksum. The line is canonicalized (carriage returns stripped, trailing whitespace trimmed) and hashed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm). The canonicalization keeps the checksum stable across editor-save cycles that add or remove trailing whitespace. A line over 500 bytes is hashed from its first 500 bytes.

### Persistent state

Allocated anchors live in a persistent per-file snapshot (`~/.config/pi-hashline-edit-pro/hash-store.sqlite`) keyed by content checksum, so resume-after-restart and cross-session edits reuse ownership instead of minting duplicates. Each session also appends an ownership log (`allocate`/`free`/`clear` events) to a sidecar file under `~/.config/pi-hashline-edit-pro/sessions/`; that log is the session's record, sidecars whose session file is gone are garbage-collected at startup (never the sidecar of a session that is currently loaded in this process), and the in-memory ownership of a session is released when that session shuts down and rebuilt from its sidecar on next use.

Upgrading from a 6.x release invalidates the old 4-character anchors: the hash store version changes, so snapshots and undo history are cleared, old sidecar anchors are ignored, and anchors are re-minted on the next read.

## Benchmark

pi-hashline-edit-pro is scored on the [Explicit Edit Benchmark](https://github.com/alexshpunt/explicit-edit-benchmark), an open third-party suite of 226 deterministic, byte-exact editing tasks. Per-model results and the scoring rules are in the [benchmark explorer](https://huggingface.co/spaces/alexshpunt/benchmark-explorer?card=harness%3Api-hashline-edit-pro%40latest) and the [dataset](https://huggingface.co/datasets/alexshpunt/explicit-edit-benchmark).

## Development

Requires [Node.js](https://nodejs.org) 22.19 or newer and npm.

```bash
npm install
npm test              # full suite
npm run test:unit     # unit suite (heavy stress and property tests excluded)
npm run test:coverage # full suite with coverage thresholds
npm run lint
npm run typecheck
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

## Credits

- [RimuruW](https://github.com/RimuruW), original `pi-hashline-edit` and the strict-semantics policy
- [can1357](https://github.com/can1357), original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept
- [HanzCEO](https://github.com/HanzCEO), [pi-codebase-reader](https://github.com/HanzCEO/pi-codebase-reader): vendored tree-sitter parsers and outline extraction (Apache-2.0), exposed through the auto-read-all `outline` and `outline(git)` modes

## License

[MIT](LICENSE)
