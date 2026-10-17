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

export type PatchStatus = "complete" | "partial" | "failed";

export type HunkFailureCode =
	| "context_not_found"
	| "context_ambiguous"
	| "insertion_out_of_bounds";

export type PatchFailureCode =
	| HunkFailureCode
	| "file_not_found"
	| "file_exists"
	| "destination_exists"
	| "blocked_by_previous_operation";

export interface PatchFailure {
	code: PatchFailureCode;
	message: string;
}

export interface HunkOutcome {
	hunk: number;
	lineNumber: number;
	status: "applied" | "failed" | "blocked";
	mode?: MatchMode;
	failure?: PatchFailure;
}

export interface OperationOutcome {
	operation: number;
	kind: AppliedOperation["kind"];
	path: string;
	destination?: string;
	lineNumber: number;
	status: PatchStatus | "blocked";
	hunks: HunkOutcome[];
	failure?: PatchFailure;
}

export type ApplyPatchFileKind = "add" | "update" | "delete";

export interface ApplyPatchFileDiff {
	path: string;
	kind: ApplyPatchFileKind;
	diff: string;
	patch?: string;
	firstChangedLine?: number;
	additions: number;
	deletions: number;
	truncated?: boolean;
	move?: {
		from: string;
		to: string;
		role: "source" | "destination";
	};
}

export interface ApplyPatchSummary {
	files: number;
	additions: number;
	deletions: number;
}

export interface ApplyPatchResult {
	status: PatchStatus;
	outcomes: OperationOutcome[];
	operations: AppliedOperation[];
	changedPaths: string[];
	fuzzyMatches: FuzzyMatch[];
	files: ApplyPatchFileDiff[];
	summary: ApplyPatchSummary;
}
