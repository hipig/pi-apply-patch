import { formatPatchLocation, PatchError } from "./errors.ts";
import type {
	AddFilePatch,
	DeleteFilePatch,
	HunkLine,
	ParsedPatch,
	UpdateFilePatch,
	UpdateHunk,
} from "./types.ts";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

function fail(lineNumber: number, message: string): never {
	throw new PatchError(`${formatPatchLocation(lineNumber)}: ${message}`);
}

function readPath(line: string, prefix: string, lineNumber: number): string {
	const value = line.slice(prefix.length).trim();
	if (!value) fail(lineNumber, "file path cannot be empty");
	return value;
}

function isFileBoundary(line: string): boolean {
	return (
		line === END_PATCH ||
		line.startsWith(ADD_FILE) ||
		line.startsWith(DELETE_FILE) ||
		line.startsWith(UPDATE_FILE)
	);
}

function normalizeInput(input: string): string[] {
	if (!input.trim()) throw new PatchError("Patch input cannot be empty");
	if (input.includes("\0"))
		throw new PatchError("Patch input contains a NUL byte");

	const lines = input
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n");
	while (lines.at(-1) === "") lines.pop();
	return lines;
}

class PatchParser {
	private readonly lines: string[];
	private index = 0;

	constructor(input: string) {
		this.lines = normalizeInput(input);
	}

	parse(): ParsedPatch {
		if (this.lines[0] !== BEGIN_PATCH) {
			fail(1, `expected ${JSON.stringify(BEGIN_PATCH)}`);
		}
		if (this.lines.at(-1) !== END_PATCH) {
			fail(this.lines.length, `expected ${JSON.stringify(END_PATCH)}`);
		}

		this.index = 1;
		const files: ParsedPatch["files"] = [];

		while (this.index < this.lines.length - 1) {
			const line = this.current();
			if (line.startsWith(ADD_FILE)) {
				files.push(this.parseAdd());
			} else if (line.startsWith(DELETE_FILE)) {
				files.push(this.parseDelete());
			} else if (line.startsWith(UPDATE_FILE)) {
				files.push(this.parseUpdate());
			} else {
				fail(
					this.lineNumber(),
					`expected a file operation, received ${JSON.stringify(line)}`,
				);
			}
		}

		if (files.length === 0)
			throw new PatchError("Patch does not contain any file operations");
		return { files };
	}

	private parseAdd(): AddFilePatch {
		const lineNumber = this.lineNumber();
		const path = readPath(this.current(), ADD_FILE, lineNumber);
		this.index += 1;

		const contentLines: string[] = [];
		while (this.index < this.lines.length && !isFileBoundary(this.current())) {
			const line = this.current();
			if (!line.startsWith("+")) {
				fail(
					this.lineNumber(),
					"every line in an Add File block must start with '+'",
				);
			}
			contentLines.push(line.slice(1));
			this.index += 1;
		}

		if (contentLines.length === 0)
			fail(lineNumber, "Add File block must contain at least one '+' line");
		return {
			kind: "add",
			path,
			content: `${contentLines.join("\n")}\n`,
			lineNumber,
		};
	}

	private parseDelete(): DeleteFilePatch {
		const lineNumber = this.lineNumber();
		const path = readPath(this.current(), DELETE_FILE, lineNumber);
		this.index += 1;
		return { kind: "delete", path, lineNumber };
	}

	private parseUpdate(): UpdateFilePatch {
		const lineNumber = this.lineNumber();
		const path = readPath(this.current(), UPDATE_FILE, lineNumber);
		this.index += 1;

		let moveTo: string | undefined;
		if (this.index < this.lines.length && this.current().startsWith(MOVE_TO)) {
			moveTo = readPath(this.current(), MOVE_TO, this.lineNumber());
			this.index += 1;
		}

		const hunks: UpdateHunk[] = [];
		let currentHunk: UpdateHunk | undefined;

		const finishHunk = (): void => {
			if (!currentHunk) return;
			if (currentHunk.lines.length === 0) {
				fail(currentHunk.lineNumber, "update hunk cannot be empty");
			}
			if (
				!currentHunk.lines.some(
					(line) => line.kind === "add" || line.kind === "delete",
				)
			) {
				fail(currentHunk.lineNumber, "update hunk does not change any lines");
			}
			hunks.push(currentHunk);
			currentHunk = undefined;
		};

		while (this.index < this.lines.length && !isFileBoundary(this.current())) {
			const line = this.current();

			if (line === "@@" || line.startsWith("@@ ")) {
				finishHunk();
				const anchor =
					line === "@@" ? undefined : line.slice(3).trim() || undefined;
				currentHunk = {
					...(anchor === undefined ? {} : { anchor }),
					lines: [],
					endOfFile: false,
					lineNumber: this.lineNumber(),
				};
				this.index += 1;
				continue;
			}

			if (line === END_OF_FILE) {
				if (!currentHunk)
					fail(this.lineNumber(), `${END_OF_FILE} must follow an update hunk`);
				currentHunk.endOfFile = true;
				this.index += 1;
				finishHunk();
				if (this.index < this.lines.length && !isFileBoundary(this.current())) {
					fail(
						this.lineNumber(),
						`${END_OF_FILE} must be the final line of its file update`,
					);
				}
				continue;
			}

			const prefix = line[0];
			if (prefix !== "+" && prefix !== "-" && prefix !== " ") {
				fail(
					this.lineNumber(),
					"update lines must start with '+', '-', or a space",
				);
			}

			currentHunk ??= {
				lines: [],
				endOfFile: false,
				lineNumber: this.lineNumber(),
			};
			const kind: HunkLine["kind"] =
				prefix === "+" ? "add" : prefix === "-" ? "delete" : "context";
			currentHunk.lines.push({
				kind,
				text: line.slice(1),
				lineNumber: this.lineNumber(),
			});
			this.index += 1;
		}

		finishHunk();
		if (hunks.length === 0 && moveTo === undefined) {
			fail(
				lineNumber,
				"Update File block must contain a hunk or a Move to directive",
			);
		}

		return {
			kind: "update",
			path,
			...(moveTo === undefined ? {} : { moveTo }),
			hunks,
			lineNumber,
		};
	}

	private current(): string {
		const line = this.lines[this.index];
		if (line === undefined) fail(this.lineNumber(), "unexpected end of patch");
		return line;
	}

	private lineNumber(): number {
		return this.index + 1;
	}
}

export function parsePatch(input: string): ParsedPatch {
	return new PatchParser(input).parse();
}
