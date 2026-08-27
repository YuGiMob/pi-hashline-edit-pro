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
	type BDup,
	type AutoFix,
	resEdit,
	stripAnchorRow,
	resolveAnchorLine,
	valEdit,
	stripBarePrefixes,
	stripDiffPrefixes,
	swapReversedRanges,
	findNewEdge,
	assertRangeServed,
	RangeStaleError,
	AnchorMismatchError,
} from "./resolve";

export {
	buildIdx,
	applyEdit,
	fmtRegion,
	fmtRow,
	changedRange,
} from "./apply";
