import type { HunkFailureCode } from "./types.ts";

export class PatchError extends Error {
	override readonly name = "PatchError";
}

export class HunkMatchError extends PatchError {
	readonly code: HunkFailureCode;

	constructor(code: HunkFailureCode, message: string) {
		super(message);
		this.code = code;
	}
}

export function formatPatchLocation(lineNumber: number): string {
	return `Invalid patch at line ${lineNumber}`;
}

export function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
