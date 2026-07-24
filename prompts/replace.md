Replace lines in a text file using HASH anchors from `read`.{{MODE_DESCRIPTION}}

Workflow:
1. Call `read` to get `HASH│content` lines for the file.
2. Identify the range to replace using the 3-char hashes from the read output.
3. Call `replace` with `hash_range_inclusive` (the two hashes) and `content_lines` (the new lines).
4. On `[E_STALE_ANCHOR]`, call `read` again for fresh anchors, then retry.
5. On success, call `read` to get fresh anchors for follow-up edits.

Request structure:
{{MODE_REQUEST_STRUCTURE}}

Fields:
- content_lines — replacement lines as a JSON array of strings. File content only — no HASH│ prefix.
- hash_range_inclusive — [start_hash, end_hash] from read output. 3-char base64 hash only — no │ or line content.
- path — file to edit.

Examples:
{{MODE_EXAMPLES}}

Rules:
- Anchors must be 3-char base64 hashes from the most recent read. Stale anchors fail with [E_STALE_ANCHOR].
- The range is inclusive: every line from start_hash through end_hash is deleted.
- Those lines are replaced with content_lines — nothing is inserted, nothing is appended.
- content_lines is literal file content. Never include the HASH│ prefix — that goes in hash_range_inclusive.
- content_lines must be a native JSON array of strings, not a serialized string.
- Preserve leading whitespace exactly as it appears after │ in read output.
- To delete lines, use content_lines: [].
- If content_lines matches current content, the edit is a noop (file unchanged).
- **Verify boundaries:** before submitting, check your `content_lines`. If its first non-empty line matches the line just before `start_hash`, remove it — that line survives outside your range. If its last non-empty line matches the line just after `end_hash`, remove it — it also survives. A `[W_DUP]` warning means you missed this check.
{{MODE_RULES}}
On success, the response shows the change summary. {{AUTO_READ_GUIDANCE}}

Recovery: If a replace produces incorrect results, call undo_last_replace with the file path to revert.