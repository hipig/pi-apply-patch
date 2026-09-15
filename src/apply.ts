import { sep } from "node:path";
import { buildApplyPatchDiffs } from "./diff.ts";
import { asErrorMessage, PatchError } from "./errors.ts";
import {
	commitFileChanges,
	type FileState,
	nodeFileSystem,
	type PatchFileSystem,
	type PlannedFileChange,
	type ResolvedPatchPath,
	readFileState,
	WorkspacePaths,
} from "./filesystem.ts";
import { parsePatch } from "./parser.ts";
import type {
	AppliedOperation,
	ApplyPatchResult,
	FuzzyMatch,
	MatchMode,
	ParsedPatch,
	UpdateFilePatch,
	UpdateHunk,
} from "./types.ts";

interface FileEntry {
	path: ResolvedPatchPath;
	before: FileState;
	current: FileState;
}

interface TextLines {
	lines: string[];
	eol: "\n" | "\r\n" | "\r";
	finalNewline: boolean;
}

interface SequenceMatch {
	index: number;
	mode: MatchMode;
}

export interface ApplyPatchOptions {
	signal?: AbortSignal;
	fileSystem?: PatchFileSystem;
}

function cloneState(state: FileState): FileState {
	if (!state.exists) return { exists: false };
	return {
		exists: true,
		content: state.content ?? "",
		...(state.mode === undefined ? {} : { mode: state.mode }),
	};
}

function splitText(content: string): TextLines {
	const crlfIndex = content.indexOf("\r\n");
	const lfIndex = content.indexOf("\n");
	const loneCrIndex = content.search(/\r(?!\n)/u);

	let eol: TextLines["eol"] = "\n";
	const candidates: Array<{ index: number; eol: TextLines["eol"] }> = [];
	if (crlfIndex >= 0) candidates.push({ index: crlfIndex, eol: "\r\n" });
	if (lfIndex >= 0 && lfIndex !== crlfIndex + 1)
		candidates.push({ index: lfIndex, eol: "\n" });
	if (loneCrIndex >= 0) candidates.push({ index: loneCrIndex, eol: "\r" });
	candidates.sort((left, right) => left.index - right.index);
	if (candidates[0]) eol = candidates[0].eol;

	const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	const finalNewline = normalized.endsWith("\n");
	const body = finalNewline ? normalized.slice(0, -1) : normalized;
	const lines = body === "" ? (finalNewline ? [""] : []) : body.split("\n");
	return { lines, eol, finalNewline };
}

function joinText(text: TextLines): string {
	if (text.lines.length === 0) return "";
	const body = text.lines.join(text.eol);
	return text.finalNewline ? `${body}${text.eol}` : body;
}

function normalizeLine(line: string, mode: MatchMode): string {
	if (mode === "exact") return line;
	if (mode === "rstrip") return line.replace(/[\t ]+$/u, "");
	return line.trim();
}

function sequenceMatches(
	haystack: string[],
	needle: string[],
	index: number,
	mode: MatchMode,
): boolean {
	for (let offset = 0; offset < needle.length; offset += 1) {
		const actual = haystack[index + offset];
		const expected = needle[offset];
		if (actual === undefined || expected === undefined) return false;
		if (normalizeLine(actual, mode) !== normalizeLine(expected, mode))
			return false;
	}
	return true;
}

function findSequence(
	haystack: string[],
	needle: string[],
	start: number,
	endOfFile: boolean,
	description: string,
): SequenceMatch {
	const maximum = haystack.length - needle.length;
	if (maximum < start)
		throw new PatchError(`${description}: context was not found`);

	for (const mode of ["exact", "rstrip", "trim"] as const) {
		const candidates: number[] = [];
		if (endOfFile) {
			if (maximum >= start && sequenceMatches(haystack, needle, maximum, mode))
				candidates.push(maximum);
		} else {
			for (let index = start; index <= maximum; index += 1) {
				if (sequenceMatches(haystack, needle, index, mode))
					candidates.push(index);
			}
		}

		if (candidates.length === 1) return { index: candidates[0] ?? start, mode };
		if (candidates.length > 1) {
			throw new PatchError(
				`${description}: context is ambiguous (${candidates.length} matches)`,
			);
		}
	}

	throw new PatchError(`${description}: context was not found`);
}

function strongestMode(left: MatchMode, right: MatchMode): MatchMode {
	const rank: Record<MatchMode, number> = { exact: 0, rstrip: 1, trim: 2 };
	return rank[left] >= rank[right] ? left : right;
}

function applyHunks(
	path: string,
	content: string,
	hunks: UpdateHunk[],
): { content: string; fuzzy: FuzzyMatch[] } {
	if (hunks.length === 0) return { content, fuzzy: [] };

	const text = splitText(content);
	let cursor = 0;
	const fuzzy: FuzzyMatch[] = [];

	for (const [hunkIndex, hunk] of hunks.entries()) {
		const description = `${path}, hunk ${hunkIndex + 1}`;
		let searchStart = cursor;
		let matchMode: MatchMode = "exact";

		if (hunk.anchor !== undefined) {
			const anchor = findSequence(
				text.lines,
				[hunk.anchor],
				cursor,
				false,
				`${description} anchor`,
			);
			searchStart = anchor.index + 1;
			matchMode = strongestMode(matchMode, anchor.mode);
		}

		const oldLines = hunk.lines
			.filter((line) => line.kind !== "add")
			.map((line) => line.text);
		const newLines = hunk.lines
			.filter((line) => line.kind !== "delete")
			.map((line) => line.text);

		let index: number;
		if (oldLines.length === 0) {
			index = hunk.endOfFile ? text.lines.length : searchStart;
			if (index > text.lines.length)
				throw new PatchError(
					`${description}: insertion point is outside the file`,
				);
		} else {
			const match = findSequence(
				text.lines,
				oldLines,
				searchStart,
				hunk.endOfFile,
				description,
			);
			index = match.index;
			matchMode = strongestMode(matchMode, match.mode);
		}

		text.lines.splice(index, oldLines.length, ...newLines);
		cursor = index + newLines.length;
		if (matchMode !== "exact")
			fuzzy.push({ path, hunk: hunkIndex + 1, mode: matchMode });
	}

	return { content: joinText(text), fuzzy };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	throw new Error(
		signal.reason === undefined
			? "Patch operation was aborted"
			: String(signal.reason),
	);
}

class PatchPlanner {
	private readonly entries = new Map<string, FileEntry>();
	private readonly operations: AppliedOperation[] = [];
	private readonly fuzzyMatches: FuzzyMatch[] = [];
	private readonly workspace: WorkspacePaths;
	private readonly fileSystem: PatchFileSystem;
	private readonly signal: AbortSignal | undefined;

	constructor(
		workspace: WorkspacePaths,
		fileSystem: PatchFileSystem,
		signal: AbortSignal | undefined,
	) {
		this.workspace = workspace;
		this.fileSystem = fileSystem;
		this.signal = signal;
	}

	async plan(document: ParsedPatch): Promise<void> {
		for (const [operationIndex, operation] of document.files.entries()) {
			throwIfAborted(this.signal);
			try {
				if (operation.kind === "add") {
					const entry = await this.getEntry(operation.path);
					if (entry.current.exists)
						throw new PatchError(`file already exists: ${operation.path}`);
					entry.current = { exists: true, content: operation.content };
					this.operations.push({ kind: "add", path: entry.path.displayPath });
					continue;
				}

				if (operation.kind === "delete") {
					const entry = await this.getEntry(operation.path);
					if (!entry.current.exists)
						throw new PatchError(`file does not exist: ${operation.path}`);
					entry.current = { exists: false };
					this.operations.push({
						kind: "delete",
						path: entry.path.displayPath,
					});
					continue;
				}

				await this.applyUpdate(operation);
			} catch (error) {
				if (error instanceof PatchError) {
					throw new PatchError(
						`Operation ${operationIndex + 1} (${operation.path}, line ${operation.lineNumber}): ${error.message}`,
					);
				}
				throw error;
			}
		}

		this.assertNoPathHierarchyConflicts();
	}

	changes(): PlannedFileChange[] {
		return [...this.entries.values()].map((entry) => ({
			path: entry.path,
			before: cloneState(entry.before),
			after: cloneState(entry.current),
		}));
	}

	result(changedPaths: string[]): ApplyPatchResult {
		const details = buildApplyPatchDiffs(this.changes(), this.operations);
		return {
			operations: [...this.operations],
			changedPaths,
			fuzzyMatches: [...this.fuzzyMatches],
			...details,
		};
	}

	private async applyUpdate(operation: UpdateFilePatch): Promise<void> {
		const source = await this.getEntry(operation.path);
		if (!source.current.exists)
			throw new PatchError(`file does not exist: ${operation.path}`);

		const updated = applyHunks(
			source.path.displayPath,
			source.current.content ?? "",
			operation.hunks,
		);
		this.fuzzyMatches.push(...updated.fuzzy);
		const nextState: FileState = {
			exists: true,
			content: updated.content,
			...(source.current.mode === undefined
				? {}
				: { mode: source.current.mode }),
		};

		if (operation.moveTo === undefined) {
			source.current = nextState;
			this.operations.push({ kind: "update", path: source.path.displayPath });
			return;
		}

		const destination = await this.getEntry(operation.moveTo);
		if (destination.path.key === source.path.key) {
			throw new PatchError(
				`move destination resolves to the source file: ${operation.moveTo}`,
			);
		}
		if (destination.current.exists)
			throw new PatchError(
				`move destination already exists: ${operation.moveTo}`,
			);

		source.current = { exists: false };
		destination.current = nextState;
		this.operations.push({
			kind: "move",
			path: source.path.displayPath,
			destination: destination.path.displayPath,
		});
	}

	private async getEntry(input: string): Promise<FileEntry> {
		const path = await this.workspace.resolve(input);
		const existing = this.entries.get(path.key);
		if (existing) {
			if (existing.path.absolutePath !== path.absolutePath) {
				throw new PatchError(
					`${input} resolves to the same file as ${existing.path.displayPath}`,
				);
			}
			return existing;
		}

		const before = await readFileState(path, this.fileSystem);
		const entry = {
			path,
			before: cloneState(before),
			current: cloneState(before),
		};
		this.entries.set(path.key, entry);
		return entry;
	}

	private assertNoPathHierarchyConflicts(): void {
		const paths = [...this.entries.values()]
			.map((entry) => entry.path)
			.sort((left, right) => left.key.localeCompare(right.key));
		for (
			let parentIndex = 0;
			parentIndex < paths.length - 1;
			parentIndex += 1
		) {
			const parent = paths[parentIndex];
			if (!parent) continue;
			for (
				let childIndex = parentIndex + 1;
				childIndex < paths.length;
				childIndex += 1
			) {
				const child = paths[childIndex];
				if (child?.key.startsWith(`${parent.key}${sep}`)) {
					throw new PatchError(
						`Patch cannot modify both a path and its child: ${parent.displayPath}, ${child.displayPath}`,
					);
				}
			}
		}
	}
}

export async function applyPatch(
	input: string,
	cwd: string,
	options: ApplyPatchOptions = {},
): Promise<ApplyPatchResult> {
	const fileSystem = options.fileSystem ?? nodeFileSystem;
	throwIfAborted(options.signal);

	let document: ParsedPatch;
	try {
		document = parsePatch(input);
	} catch (error) {
		if (error instanceof PatchError) throw error;
		throw new PatchError(`Cannot parse patch: ${asErrorMessage(error)}`);
	}

	const workspace = await WorkspacePaths.create(cwd, fileSystem);
	const planner = new PatchPlanner(workspace, fileSystem, options.signal);
	await planner.plan(document);
	throwIfAborted(options.signal);
	const changedPaths = await commitFileChanges(
		planner.changes(),
		workspace,
		fileSystem,
	);
	return planner.result(changedPaths);
}
