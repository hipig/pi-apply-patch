import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ApplyPatchOptions, applyPatch } from "./apply.ts";
import { renderApplyPatchCall, renderApplyPatchResult } from "./render.ts";
import type { ApplyPatchResult } from "./types.ts";

export const APPLY_PATCH_DESCRIPTION = `Apply a patch to files in the current workspace.
The input must use Codex patch format and be wrapped in *** Begin Patch / *** End Patch.
Supported operations are Add File, Update File, Delete File, and Move to. Paths must be relative to the workspace.`;

export const APPLY_PATCH_PROMPT_SNIPPET =
	"Apply one complete Codex-format patch across the requested workspace files.";

export const APPLY_PATCH_PROMPT_GUIDELINES = [
	"Use one apply_patch call for related changes across multiple files.",
	"Include the exact *** Begin Patch and *** End Patch envelope.",
	"Do not edit or write the same files concurrently in the same turn.",
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

export function formatApplyPatchResult(result: ApplyPatchResult): string {
	if (result.changedPaths.length === 0)
		return "Patch applied successfully; no file content changed.";

	const lines = [
		`Applied patch successfully to ${result.changedPaths.length} file${result.changedPaths.length === 1 ? "" : "s"} (+${result.summary.additions} -${result.summary.deletions}):`,
		...result.changedPaths.map((path) => `- ${path}`),
	];
	if (result.fuzzyMatches.length > 0) {
		lines.push(
			`Matched ${result.fuzzyMatches.length} hunk${result.fuzzyMatches.length === 1 ? "" : "s"} with whitespace tolerance.`,
		);
	}
	return lines.join("\n");
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
			return {
				content: [
					{ type: "text" as const, text: formatApplyPatchResult(result) },
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
export type { ApplyPatchResult, ParsedPatch } from "./types.ts";
