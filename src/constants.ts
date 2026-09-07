export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_RANGE_STALE_LINES = 100;
export const MAX_OVERSIZED_WARNING_LINES = 100;

export const MAX_HASH_SOURCE_BYTES = 500;
export const MAX_GREP_LINE_BYTES = 500;

export const MAX_DIFF_INPUT_BYTES = 1024 * 1024;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
export const HASH_STORE_VERSION = 8;
export const NEW_CONTENT_NOT_ARRAY_MSG =
  `[E_BAD_SHAPE] "replacement_lines" must be an array of strings, one per line (use [] to delete).`;

export const ANCHOR_POOL_EXHAUSTED_PREFIX =
  "[E_FILE_TOO_LARGE] The session's anchor pool is exhausted";

export const DEDUP_ANCHOR = "dedup";
