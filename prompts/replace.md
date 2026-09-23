Replace a range of lines (or a single line) in a text file, targeted by 4-character anchors from any served anchor│content row. Give `remove_from` and `remove_to` as bare anchors marking the first and last line to remove, and `replacement_lines` as one string per new line with no anchor prefixes and no embedded newlines; `[]` deletes the range.

Same-file calls in one message batch: earlier calls reply `In batch N` and the last call shows the combined diff, with one undo for the whole batch.

Example: read served `Hasu│old` and `arvm│old2`. Call { "remove_from": "Hasu", "remove_to": "arvm", "replacement_lines": ["new"] }. The post-edit diff shows `-Hasu│old`, `-arvm│old2`, `+Qwer│new`: the `-` rows are dead anchors now; the `+` and ` ` rows are live anchors for the next edit.
