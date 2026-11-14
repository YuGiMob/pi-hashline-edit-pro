import xxhash from "xxhash-wasm";
import { truncateToBytes } from "../utils.ts";
import { MAX_HASH_SOURCE_BYTES } from "../constants.ts";

export type Hasher = {
	h32(input: string, seed?: number): number;
	h64ToString(input: string, seed?: bigint): string;
};

let hasher: Hasher | null = null;

export function getH(): Hasher {
	if (hasher) return hasher;
	throw new Error("xxhash-wasm hasher not initialized; await initHasher() before calling hashline APIs.");
}

const hasherP: Promise<Hasher> = xxhash().then((h) => {
	hasher = h as unknown as Hasher;
	return hasher;
}).catch((err: unknown) => {
	console.error("xxhash-wasm initialization failed:", err);
	throw err;
});

export function initHasher(): Promise<Hasher> {
	return hasherP;
}

export function xxh32(input: string, seed = 0): number {
	return getH().h32(input, seed) >>> 0;
}

export function contentChecksum(content: string): string {
	return getH().h64ToString(content);
}

export function canon(line: string): string {
  return line.replace(/\r/g, "").trimEnd();
}

export function hashSource(line: string): string {
  return truncateToBytes(canon(line), MAX_HASH_SOURCE_BYTES);
}

export function lineChecksum(line: string): string {
  return contentChecksum(hashSource(line));
}
