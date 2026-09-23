Insert lines after or before one existing line in a text file, addressed by a bare anchor from any served anchor│content row. The anchor line is preserved: `lines` go after it with `direction: "after"` or before it with `direction: "before"`, one string per line, no anchor prefixes, no embedded newlines. Inserted lines are written exactly as given; nothing else in the file changes.

Same-file calls in one message batch: earlier calls reply `In batch N` and the last call shows the combined diff, with one undo for the whole batch.
