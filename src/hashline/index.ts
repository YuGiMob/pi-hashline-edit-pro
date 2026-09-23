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
} from "./hash";

export {
	parseHashRef,
	parseText,
	type Anchor,
} from "./parse";

export {
	type HEdit,
	type RHEdit,
	type HTEdit,
	type NEdit,
	resEdit,
	stripAnchorRow,
	resolveAnchorLine,
	valEdit,
	stripBarePrefixes,
	stripDiffPrefixes,
	swapReversedRanges,
	assertRangeServed,
	RangeStaleError,
	AnchorMismatchError,
} from "./resolve";

export {
	buildIdx,
	applyEdit,
	planEdit,
	type PlannedEdit,
	fmtRegion,
	fmtRow,
	changedRange,
	assertNotEmpty,
} from "./apply";
