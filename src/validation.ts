import { constants } from "fs";
import { access as fsAccess } from "fs/promises";
import type { LFile } from "./file-kind";
import type { FileIdentity } from "./fs-write";
import { errCode } from "./utils";

export async function valAccess(
	absolutePath: string,
	path: string,
	accessMode: number = constants.R_OK,
): Promise<void> {
	try {
		await fsAccess(absolutePath, accessMode);
	} catch (error: unknown) {
		const code = errCode(error);
		if (code === "ENOENT") {
			throw new Error(`[E_NOT_FOUND] File not found: ${path}`);
		}
		if (code === "EACCES" || code === "EPERM") {
			const accessLabel = accessMode & constants.W_OK ? "not writable" : "not readable";
			throw new Error(`[E_ACCESS] File is ${accessLabel}: ${path}`);
		}
		if (code === "ELOOP") {
			throw new Error(`[E_ACCESS] Too many symbolic links while resolving: ${path}`);
		}
		throw new Error(`[E_ACCESS] Cannot access file: ${path}`);
	}
}

export function valKind(file: LFile, path: string): asserts file is { kind: "text"; text: string; identity?: FileIdentity; hadUtf8DecodeErrors?: true } {
	if (file.kind === "directory") {
		throw new Error(`[E_NOT_TEXT] Path is a directory: ${path}. Use ls to inspect directories.`);
	}
	if (file.kind === "binary") {
		throw new Error(`[E_NOT_TEXT] Path is a binary file: ${path} (${file.description}). Hashline edit only supports text files.`);
	}
	if (file.kind === "image") {
		throw new Error(`[E_NOT_TEXT] Path is an image file: ${path}. Hashline edit only supports text files.`);
	}
	if (file.kind === "too_large") {
		throw new Error(
			`[E_FILE_TOO_LARGE] File is too large: ${path} (${file.description}). For very large files, use write.`,
		);
	}
}
