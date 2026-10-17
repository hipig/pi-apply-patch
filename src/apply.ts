import { sep } from "node:path";
import { buildApplyPatchDiffs } from "./diff.ts";
import { asErrorMessage, HunkMatchError, PatchError } from "./errors.ts";
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
	FilePatch,
	FuzzyMatch,
	HunkOutcome,
	MatchMode,
	OperationOutcome,
	ParsedPatch,
	PatchFailureCode,
	UpdateFilePatch,
	UpdateHunk,
} from "./types.ts";

interface FileEntry {
	path: ResolvedPatchPath;
	before: FileState;
	current: FileState;
}

interface PreparedOperation {
	patch: FilePatch;
	source: FileEntry;
	destination?: FileEntry;
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
		throw new HunkMatchError(
			"context_not_found",
			`${description} was not found`,
		);

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
			throw new HunkMatchError(
				"context_ambiguous",
				`${description} is ambiguous (${candidates.length} matches)`,
			);
		}
	}

	throw new HunkMatchError(
		"context_not_found",
		`${description} was not found`,
	);
}

function strongestMode(left: MatchMode, right: MatchMode): MatchMode {
	const rank: Record<MatchMode, number> = { exact: 0, rstrip: 1, trim: 2 };
	return rank[left] >= rank[right] ? left : right;
}

function applyHunks(
	content: string,
	hunks: UpdateHunk[],
): { content: string; hunks: HunkOutcome[] } {
	if (hunks.length === 0) return { content, hunks: [] };

	const text = splitText(content);
	let cursor = 0;
	const outcomes: HunkOutcome[] = [];

	for (const [hunkIndex, hunk] of hunks.entries()) {
		try {
			let searchStart = cursor;
			let matchMode: MatchMode = "exact";

			if (hunk.anchor !== undefined) {
				const anchor = findSequence(
					text.lines,
					[hunk.anchor],
					cursor,
					false,
					"anchor",
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
					throw new HunkMatchError(
						"insertion_out_of_bounds",
						"insertion point is outside the file",
					);
			} else {
				const match = findSequence(
					text.lines,
					oldLines,
					searchStart,
					hunk.endOfFile,
					"context",
				);
				index = match.index;
				matchMode = strongestMode(matchMode, match.mode);
			}

			text.lines.splice(index, oldLines.length, ...newLines);
			cursor = index + newLines.length;
			outcomes.push({
				hunk: hunkIndex + 1,
				lineNumber: hunk.lineNumber,
				status: "applied",
				mode: matchMode,
			});
		} catch (error) {
			if (!(error instanceof HunkMatchError)) throw error;
			outcomes.push({
				hunk: hunkIndex + 1,
				lineNumber: hunk.lineNumber,
				status: "failed",
				failure: { code: error.code, message: error.message },
			});
		}
	}

	return { content: joinText(text), hunks: outcomes };
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
	private readonly outcomes: OperationOutcome[] = [];
	private readonly blockedPaths = new Map<string, number>();
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
		const prepared = await this.prepareOperations(document);
		for (const [operationIndex, { patch, source, destination }] of prepared.entries()) {
			throwIfAborted(this.signal);
			const outcome: OperationOutcome = {
				operation: operationIndex + 1,
				kind: destination === undefined ? patch.kind : "move",
				path: source.path.displayPath,
				...(destination === undefined
					? {}
					: { destination: destination.path.displayPath }),
				lineNumber: patch.lineNumber,
				status: "complete",
				hunks: patch.kind === "update"
					? patch.hunks.map((hunk, index) => ({
						hunk: index + 1,
						lineNumber: hunk.lineNumber,
						status: "blocked" as const,
					}))
					: [],
			};
			const blockedBy = this.blockedPaths.get(source.path.key) ??
				(destination === undefined
					? undefined
					: this.blockedPaths.get(destination.path.key));

			if (blockedBy !== undefined) {
				this.rejectOperation(
					outcome,
					"blocked_by_previous_operation",
					`not applied because operation ${blockedBy} did not complete`,
					"blocked",
				);
			} else if (patch.kind === "add") {
				if (source.current.exists) {
					this.rejectOperation(outcome, "file_exists", "file already exists");
				} else {
					source.current = { exists: true, content: patch.content };
					this.operations.push({ kind: "add", path: source.path.displayPath });
				}
			} else if (patch.kind === "delete") {
				if (!source.current.exists) {
					this.rejectOperation(outcome, "file_not_found", "file does not exist");
				} else {
					source.current = { exists: false };
					this.operations.push({ kind: "delete", path: source.path.displayPath });
				}
			} else {
				this.applyUpdate(patch, source, destination, outcome);
			}

			this.outcomes.push(outcome);
			if (outcome.status !== "complete") {
				for (const entry of destination === undefined ? [source] : [source, destination]) {
					if (!this.blockedPaths.has(entry.path.key))
						this.blockedPaths.set(entry.path.key, outcome.operation);
				}
			}
		}
	}

	private async prepareOperations(document: ParsedPatch): Promise<PreparedOperation[]> {
		const prepared: PreparedOperation[] = [];
		// Validate every referenced path, including operations that may later be blocked.
		for (const [operationIndex, operation] of document.files.entries()) {
			throwIfAborted(this.signal);
			try {
				const source = await this.getEntry(operation.path);
				const destination = operation.kind === "update" && operation.moveTo !== undefined
					? await this.getEntry(operation.moveTo)
					: undefined;
				if (destination?.path.key === source.path.key) {
					throw new PatchError(
						`move destination resolves to the source file: ${destination.path.displayPath}`,
					);
				}
				prepared.push({ patch: operation, source, destination });
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
		return prepared;
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
			status: this.outcomes.every((outcome) => outcome.status === "complete")
				? "complete"
				: this.operations.length > 0 ? "partial" : "failed",
			outcomes: [...this.outcomes],
			operations: [...this.operations],
			changedPaths,
			fuzzyMatches: [...this.fuzzyMatches],
			...details,
		};
	}

	private rejectOperation(
		outcome: OperationOutcome,
		code: PatchFailureCode,
		message: string,
		status: "failed" | "blocked" = "failed",
	): void {
		outcome.status = status;
		outcome.failure = { code, message };
	}

	private applyUpdate(
		operation: UpdateFilePatch,
		source: FileEntry,
		destination: FileEntry | undefined,
		outcome: OperationOutcome,
	): void {
		if (!source.current.exists) {
			this.rejectOperation(outcome, "file_not_found", "file does not exist");
			return;
		}
		if (destination?.current.exists) {
			this.rejectOperation(outcome, "destination_exists", "move destination already exists");
			return;
		}

		const updated = applyHunks(
			source.current.content ?? "",
			operation.hunks,
		);
		outcome.hunks = updated.hunks;
		const hasFailures = updated.hunks.some((hunk) => hunk.status === "failed");
		if (hasFailures && destination !== undefined) {
			outcome.status = "failed";
			outcome.hunks = updated.hunks.map((hunk) => hunk.status === "applied"
				? { hunk: hunk.hunk, lineNumber: hunk.lineNumber, status: "blocked" }
				: hunk);
			return;
		}
		if (hasFailures && !updated.hunks.some((hunk) => hunk.status === "applied")) {
			outcome.status = "failed";
			return;
		}

		outcome.status = hasFailures ? "partial" : "complete";
		for (const hunk of updated.hunks) {
			if (hunk.status === "applied" && hunk.mode !== undefined && hunk.mode !== "exact")
				this.fuzzyMatches.push({ path: source.path.displayPath, hunk: hunk.hunk, mode: hunk.mode });
		}
		const nextState: FileState = {
			exists: true,
			content: updated.content,
			...(source.current.mode === undefined
				? {}
				: { mode: source.current.mode }),
		};

		if (destination === undefined) {
			source.current = nextState;
			this.operations.push({ kind: "update", path: source.path.displayPath });
			return;
		}

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
