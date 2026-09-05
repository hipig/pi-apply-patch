export class PatchError extends Error {
	override readonly name = "PatchError";
}

export function formatPatchLocation(lineNumber: number): string {
	return `Invalid patch at line ${lineNumber}`;
}

export function asErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
