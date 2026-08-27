import { open as fsOpen, stat as fsStat } from "fs/promises";
import { fileTypeFromBuffer } from "file-type";
import { SNIFF_BYTES, MAX_BYTES } from "./constants";
import { assertLineLimit, lineLimitMoreThanMessage } from "./utils";
import type { FileIdentity } from "./fs-write";

const IMG_TYPES = new Set<string>([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const TEXT_TYPES = new Set<string>([
  "application/rtf",
  "application/xml",
  "application/x-ms-regedit",
]);

function detectTextBom(sample: Uint8Array): string | undefined {
  if (
    sample.length >= 4 &&
    sample[0] === 0xff &&
    sample[1] === 0xfe &&
    sample[2] === 0x00 &&
    sample[3] === 0x00
  ) return "UTF-32LE";
  if (
    sample.length >= 4 &&
    sample[0] === 0x00 &&
    sample[1] === 0x00 &&
    sample[2] === 0xfe &&
    sample[3] === 0xff
  ) return "UTF-32BE";
  if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return "UTF-16LE";
  if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return "UTF-16BE";
  return undefined;
}

function isTextType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_TYPES.has(mimeType);
}

function looksLikeText(sample: Uint8Array): boolean {
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

export type LFile =
  | { kind: "directory" }
  | { kind: "image"; mimeType: string }
  | { kind: "text"; text: string; identity?: FileIdentity; hadUtf8DecodeErrors?: true }
  | { kind: "binary"; description: string }
  | { kind: "too_large"; description: string };


export interface LoadFileOptions {
  maxLines?: number;
  displayPath?: string;
}

export async function loadFileKindAndText(
  filePath: string,
  options?: LoadFileOptions,
): Promise<LFile> {
  const pathStat = await fsStat(filePath);
  if (pathStat.isDirectory()) {
    return { kind: "directory" };
  }
  if (!pathStat.isFile()) {
    return {
      kind: "binary",
      description: "unsupported file type",
    };
  }
  if (pathStat.size > MAX_BYTES) {
    return {
      kind: "too_large",
      description: `exceeds the ${MAX_BYTES / (1024 * 1024)}MB size limit`,
    };
  }

  const fileHandle = await fsOpen(filePath, "r");
  try {
    const openedStats = await fileHandle.stat();
    const identity = { dev: openedStats.dev, ino: openedStats.ino };
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(
      buffer,
      0,
      SNIFF_BYTES,
      0,
    );
    if (bytesRead === 0) {
      return { kind: "text", text: "", identity };
    }

    const sample = buffer.subarray(0, bytesRead);
    const textBom = detectTextBom(sample);
    if (textBom) {
      return {
        kind: "binary",
        description: `${textBom} encoded text`
      };
    }
    const detectedMimeType = (await fileTypeFromBuffer(sample))?.mime;
    if (
      detectedMimeType !== undefined &&
      !isTextType(detectedMimeType) &&
      !looksLikeText(sample)
    ) {
      if (IMG_TYPES.has(detectedMimeType)) {
        return { kind: "image", mimeType: detectedMimeType };
      }
      return {
        kind: "binary",
        description: detectedMimeType,
      };
    }
    if (detectedMimeType === undefined && sample.includes(0)) {
      return { kind: "binary", description: "contains NUL bytes" };
    }

    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
    let hadUtf8DecodeErrors = false;
    let containsNul = false;
    let newlineCount = 0;
    const parts: string[] = [];

    function decodeChunk(chunk: Uint8Array, stream: boolean): string {
      const decoded = decoder.decode(chunk, { stream });
      if (!hadUtf8DecodeErrors && decoded.includes("\uFFFD")) {
        hadUtf8DecodeErrors = true;
      }
      if (!containsNul && decoded.includes("\0")) {
        containsNul = true;
      }
      if (options?.maxLines !== undefined) {
        for (let i = 0; i < decoded.length; i++) {
          if (decoded.charCodeAt(i) === 10) newlineCount++;
        }
        if (newlineCount > options.maxLines) throw new Error(lineLimitMoreThanMessage(options.displayPath ?? filePath, options.maxLines));
      }
      return decoded;
    }

    parts.push(decodeChunk(sample, true));

    let position = bytesRead;
    while (true) {
      const { bytesRead: chunkBytesRead } = await fileHandle.read(
        buffer,
        0,
        SNIFF_BYTES,
        position,
      );
      if (chunkBytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, chunkBytesRead);
      parts.push(decodeChunk(chunk, true));
      position += chunkBytesRead;
    }
    parts.push(decodeChunk(new Uint8Array(0), false));
    const text = parts.join("");
    if (options?.maxLines !== undefined && text.length > 0) {
      const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      assertLineLimit(normalized, options.displayPath ?? filePath, options.maxLines);
    }

    if (containsNul) {
      return { kind: "binary", description: "contains NUL bytes" };
    }

    return {
      kind: "text",
      text,
      identity,
      ...(hadUtf8DecodeErrors ? { hadUtf8DecodeErrors: true as const } : {}),
    };
  } finally {
    await fileHandle.close();
  }
}
