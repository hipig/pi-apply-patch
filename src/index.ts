import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ApplyPatchOptions, applyPatch } from "./apply.ts";
import { PatchError } from "./errors.ts";
import { renderApplyPatchCall, renderApplyPatchResult } from "./render.ts";
import { formatApplyPatchResult } from "./result.ts";

export const APPLY_PATCH_DESCRIPTION = `Apply a patch to files in the current workspace.
The input must use Codex patch format and be wrapped in *** Begin Patch / *** End Patch.
Supported operations are Add File, Update File, Delete File, and Move to. Paths must be relative to the workspace.
Ordinary updates save matched hunks and report unmatched changes. A move is skipped in full if any of its hunks fail.`;

export const APPLY_PATCH_PROMPT_SNIPPET =
	"Apply a Codex-format patch, saving matched hunks and reporting unapplied changes.";

export const APPLY_PATCH_PROMPT_GUIDELINES = [
	"Use one apply_patch call for related changes across multiple files.",
	"Include the exact *** Begin Patch and *** End Patch envelope.",
	"Do not edit or write the same files concurrently in the same turn.",
	"After a partial result, read the current files and retry only unapplied changes; never resend the original patch.",
];

export const APPLY_PATCH_PARAMETERS = Type.Object(
	{
		input: Type.String({
			description: "Patch text wrapped in *** Begin Patch / *** End Patch",
		}),
	},
	{ additionalProperties: false },
);

let mutationQueue: Promise<void> = Promise.resolve();

function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
	const result = mutationQueue.then(task, task);
	mutationQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

export function createApplyPatchTool() {
	return {
		name: "apply_patch",
		label: "apply_patch",
		description: APPLY_PATCH_DESCRIPTION,
		promptSnippet: APPLY_PATCH_PROMPT_SNIPPET,
		promptGuidelines: APPLY_PATCH_PROMPT_GUIDELINES,
		parameters: APPLY_PATCH_PARAMETERS,
		executionMode: "sequential" as const,
		renderShell: "self" as const,
		renderCall: renderApplyPatchCall,
		renderResult: renderApplyPatchResult,
		async execute(
			_toolCallId: string,
			params: { input: string },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			context: { cwd: string },
		) {
			const options: ApplyPatchOptions = signal === undefined ? {} : { signal };
			const result = await enqueueMutation(() =>
				applyPatch(params.input, context.cwd, options),
			);
			const text = formatApplyPatchResult(result);
			if (result.status === "failed") throw new PatchError(text);
			return {
				content: [
					{ type: "text" as const, text },
				],
				details: result,
			};
		},
	};
}

export default function applyPatchExtension(pi: ExtensionAPI): void {
	pi.registerTool(createApplyPatchTool());
}

export { applyPatch } from "./apply.ts";
export { PatchError } from "./errors.ts";
export { parsePatch } from "./parser.ts";
export { formatApplyPatchResult } from "./result.ts";
export type {
	ApplyPatchResult,
	HunkOutcome,
	OperationOutcome,
	ParsedPatch,
	PatchFailure,
	PatchFailureCode,
	PatchStatus,
} from "./types.ts";
