export interface OutlineSymbol {
	name: string;
	type: string;
	startLine: number;
	endLine: number;
	children?: OutlineSymbol[];
}

export interface OutlineParse {
	symbols: OutlineSymbol[];
	languageName: string;
	hasSyntaxErrors: boolean;
}

export interface OutlineParser {
	languageFor(path: string): string | null;
	parse(path: string, content: string): Promise<OutlineParse | undefined>;
}

async function load(): Promise<OutlineParser | undefined> {
	try {
		const parsers = await import("./vendor/parsers/index.ts");
		return {
			languageFor: (path) => parsers.detectLanguage(path),
			parse: async (path, content) => {
				if (parsers.detectLanguage(path) === null) return undefined;
				const parsed = await parsers.parseSourceFile(path, content);
				return { symbols: parsed.symbols, languageName: parsed.languageName, hasSyntaxErrors: parsed.hasError === true };
			},
		};
	} catch (error) {
		console.error("Failed to load the vendored outline parsers:", error);
		return undefined;
	}
}

let parserPromise: Promise<OutlineParser | undefined> | undefined;

export function loadOutlineParser(): Promise<OutlineParser | undefined> {
	parserPromise ??= load();
	return parserPromise;
}
