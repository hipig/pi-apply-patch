export type HunkLineKind = "context" | "add" | "delete";

export interface HunkLine {
	kind: HunkLineKind;
	text: string;
	lineNumber: number;
}

export interface UpdateHunk {
	anchor?: string;
	lines: HunkLine[];
	endOfFile: boolean;
	lineNumber: number;
}

export interface AddFilePatch {
	kind: "add";
	path: string;
	content: string;
	lineNumber: number;
}

export interface DeleteFilePatch {
	kind: "delete";
	path: string;
	lineNumber: number;
}

export interface UpdateFilePatch {
	kind: "update";
	path: string;
	moveTo?: string;
	hunks: UpdateHunk[];
	lineNumber: number;
}

export type FilePatch = AddFilePatch | DeleteFilePatch | UpdateFilePatch;

export interface ParsedPatch {
	files: FilePatch[];
}

export type MatchMode = "exact" | "rstrip" | "trim";

export interface FuzzyMatch {
	path: string;
	hunk: number;
	mode: Exclude<MatchMode, "exact">;
}

export interface AppliedOperation {
	kind: FilePatch["kind"] | "move";
	path: string;
	destination?: string;
}

export interface ApplyPatchResult {
	operations: AppliedOperation[];
	changedPaths: string[];
	fuzzyMatches: FuzzyMatch[];
}
