export {
	HASH_LEN,
	ANCHOR_LEN,
	HASH_SEP,
	HASH_CLASS,
	HASH_RUN,
	HASH_SPACE,
	HASH_PROBE_STRIDE,
	MAX_HASH_LINES,
	lineHashes,
	_lineHashesPure,
	initHasher,
	canon,
	hashSource,
	lineChecksum,
} from "./hash.ts";

export {
	parseHashRef,
	parseText,
	parseTextWithSeparators,
	parsePayloadText,
	type Anchor,
	type ParsedText,
} from "./parse.ts";

export {
	type HEdit,
	type RHEdit,
	type HTEdit,
	type HTPayloadEdit,
	type NEdit,
	resEdit,
	stripAnchorRow,
	resolveAnchorLine,
	valEdit,
	stripBarePrefixes,
	stripDiffPrefixes,
	type StripWarningLocation,
	swapReversedRanges,
	preserveDeletionSeparators,
	assertRangeServed,
	RangeStaleError,
	AnchorMismatchError,
} from "./resolve.ts";

export {
	buildIdx,
	applyEdit,
	planEdit,
	type PlannedEdit,
	fmtRegion,
	fmtRow,
	changedRange,
} from "./apply.ts";
