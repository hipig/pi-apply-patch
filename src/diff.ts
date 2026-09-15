import * as Diff from "diff";
import type { PlannedFileChange } from "./filesystem.ts";
import type {
	AppliedOperation,
	ApplyPatchFileDiff,
	ApplyPatchSummary,
} from "./types.ts";

const DEFAULT_CONTEXT_LINES = 4;
const MAX_DIFF_LINES = 2_000;
const MAX_DIFF_BYTES = 64 * 1024;

interface GeneratedDiff {
	diff: string;
	patch: string;
	firstChangedLine: number | undefined;
	additions: number;
	deletions: number;
}

interface LimitedText {
	text: string;
	truncated: boolean;
}

function normalizeLineEndings(content: string): string {
	return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function limitText(text: string): LimitedText {
	const lines = text.split("\n");
	const kept: string[] = [];
	let bytes = 0;
	let truncated = false;

	for (const line of lines) {
		const lineBytes = Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
		if (kept.length >= MAX_DIFF_LINES || bytes + lineBytes > MAX_DIFF_BYTES) {
			truncated = true;
			break;
		}
		kept.push(line);
		bytes += lineBytes;
	}

	if (!truncated) return { text, truncated: false };
	const marker = "... diff truncated ...";
	const markerBytes = Buffer.byteLength(marker, "utf8");
	while (
		kept.length + 1 > MAX_DIFF_LINES ||
		bytes + (kept.length > 0 ? 1 : 0) + markerBytes > MAX_DIFF_BYTES
	) {
		const removed = kept.pop();
		if (removed === undefined) break;
		bytes -= Buffer.byteLength(removed, "utf8") + (kept.length > 0 ? 1 : 0);
	}
	return {
		text: [...kept, marker].join("\n"),
		truncated: true,
	};
}

function withinLimits(text: string): boolean {
	return (
		text.split("\n").length <= MAX_DIFF_LINES &&
		Buffer.byteLength(text, "utf8") <= MAX_DIFF_BYTES
	);
}

/**
 * Generate the same line-numbered shape used by Pi's built-in edit renderer.
 * The result is normalized to LF so CRLF files do not appear as whole-file changes.
 */
export function generateDisplayDiff(
	oldContent: string,
	newContent: string,
	contextLines = DEFAULT_CONTEXT_LINES,
): Omit<GeneratedDiff, "patch"> {
	const oldText = normalizeLineEndings(oldContent);
	const newText = normalizeLineEndings(newContent);
	const parts = Diff.diffLines(oldText, newText);
	const output: string[] = [];
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;
	let additions = 0;
	let deletions = 0;

	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (!part) continue;
		const raw = part.value.split("\n");
		if (raw.at(-1) === "") raw.pop();

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			if (part.added) additions += raw.length;
			if (part.removed) deletions += raw.length;

			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum += 1;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum += 1;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPart = parts[index + 1];
		const nextPartIsChange =
			nextPart !== undefined && (nextPart.added || nextPart.removed);
		const hasLeadingChange = lastWasChange;
		const hasTrailingChange = nextPartIsChange;

		if (hasLeadingChange && hasTrailingChange) {
			if (raw.length <= contextLines * 2) {
				for (const line of raw) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum += 1;
					newLineNum += 1;
				}
			} else {
				const leadingLines = raw.slice(0, contextLines);
				const trailingLines = raw.slice(raw.length - contextLines);
				const skippedLines = raw.length - leadingLines.length - trailingLines.length;
				for (const line of leadingLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum += 1;
					newLineNum += 1;
				}
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
				for (const line of trailingLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum += 1;
					newLineNum += 1;
				}
			}
		} else if (hasLeadingChange) {
			const shownLines = raw.slice(0, contextLines);
			const skippedLines = raw.length - shownLines.length;
			for (const line of shownLines) {
				const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
				output.push(` ${lineNum} ${line}`);
				oldLineNum += 1;
				newLineNum += 1;
			}
			if (skippedLines > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
			}
		} else if (hasTrailingChange) {
			const skippedLines = Math.max(0, raw.length - contextLines);
			if (skippedLines > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skippedLines;
				newLineNum += skippedLines;
			}
			for (const line of raw.slice(skippedLines)) {
				const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
				output.push(` ${lineNum} ${line}`);
				oldLineNum += 1;
				newLineNum += 1;
			}
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}
		lastWasChange = false;
	}

	return {
		diff: output.join("\n"),
		firstChangedLine,
		additions,
		deletions,
	};
}

function generateUnifiedPatch(
	path: string,
	oldContent: string,
	newContent: string,
): string {
	return Diff.createTwoFilesPatch(
		path,
		path,
		normalizeLineEndings(oldContent),
		normalizeLineEndings(newContent),
		undefined,
		undefined,
		{
			context: DEFAULT_CONTEXT_LINES,
			headerOptions: Diff.FILE_HEADERS_ONLY,
		},
	);
}

function stateContent(state: { exists: boolean; content?: string }): string {
	return state.exists ? state.content ?? "" : "";
}

function stateChanged(change: PlannedFileChange): boolean {
	if (change.before.exists !== change.after.exists) return true;
	if (!change.before.exists || !change.after.exists) return false;
	return (change.before.content ?? "") !== (change.after.content ?? "");
}

function moveForPath(
	path: string,
	operations: readonly AppliedOperation[],
): ApplyPatchFileDiff["move"] {
	for (const operation of operations) {
		if (operation.kind !== "move" || operation.destination === undefined) continue;
		if (operation.path === path) {
			return { from: operation.path, to: operation.destination, role: "source" };
		}
		if (operation.destination === path) {
			return { from: operation.path, to: operation.destination, role: "destination" };
		}
	}
	return undefined;
}

export function buildApplyPatchDiffs(
	changes: readonly PlannedFileChange[],
	operations: readonly AppliedOperation[],
): { files: ApplyPatchFileDiff[]; summary: ApplyPatchSummary } {
	const files: ApplyPatchFileDiff[] = [];

	for (const change of changes) {
		if (!stateChanged(change)) continue;
		const oldContent = stateContent(change.before);
		const newContent = stateContent(change.after);
		const generated = generateDisplayDiff(oldContent, newContent);
		const limitedDiff = limitText(generated.diff);
		const rawPatch = generateUnifiedPatch(
			change.path.displayPath,
			oldContent,
			newContent,
		);
		const kind = !change.before.exists
			? ("add" as const)
			: !change.after.exists
				? ("delete" as const)
				: ("update" as const);
		const move = moveForPath(change.path.displayPath, operations);

		files.push({
			path: change.path.displayPath,
			kind,
			diff: limitedDiff.text,
			...(withinLimits(rawPatch) ? { patch: rawPatch } : {}),
			...(generated.firstChangedLine === undefined
				? {}
				: { firstChangedLine: generated.firstChangedLine }),
			additions: generated.additions,
			deletions: generated.deletions,
			...(limitedDiff.truncated || !withinLimits(rawPatch)
				? { truncated: true }
				: {}),
			...(move === undefined ? {} : { move }),
		});
	}

	files.sort((left, right) => left.path.localeCompare(right.path));
	return {
		files,
		summary: {
			files: files.length,
			additions: files.reduce((total, file) => total + file.additions, 0),
			deletions: files.reduce((total, file) => total + file.deletions, 0),
		},
	};
}
