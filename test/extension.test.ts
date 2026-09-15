import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import applyPatchExtension, { createApplyPatchTool } from "../src/index.ts";
import {
	renderApplyPatchCall,
	renderApplyPatchResult,
} from "../src/render.ts";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-apply-patch-extension-"));
	workspaces.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(
		workspaces
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

test("registers only the apply_patch tool", () => {
	const registered: Array<{ name: string }> = [];
	const pi = {
		registerTool(tool: { name: string }) {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;

	applyPatchExtension(pi);
	assert.deepEqual(
		registered.map((tool) => tool.name),
		["apply_patch"],
	);
});

test("the registered tool uses its own renderer shell", () => {
	const tool = createApplyPatchTool() as { renderShell?: string };
	assert.equal(tool.renderShell, "self");
});

test("the registered tool executes patches and returns a concise result", async () => {
	const cwd = await workspace();
	const tool = createApplyPatchTool();
	const result = await tool.execute(
		"call-1",
		{
			input:
				"*** Begin Patch\n*** Add File: created.txt\n+hello\n*** End Patch",
		},
		undefined,
		undefined,
		{ cwd },
	);

	assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "hello\n");
	assert.match(
		result.content[0]?.text ?? "",
		/Applied patch successfully to 1 file/,
	);
	assert.deepEqual(result.details.changedPaths, ["created.txt"]);
	assert.equal(result.details.files[0]?.kind, "add");
	assert.match(result.details.files[0]?.diff ?? "", /\+1 hello/);
	assert.deepEqual(result.details.summary, {
		files: 1,
		additions: 1,
		deletions: 0,
	});
});

test("renders the call summary and file diff", async () => {
	const cwd = await workspace();
	const tool = createApplyPatchTool();
	const input =
		"*** Begin Patch\n*** Add File: created.txt\n+hello\n*** End Patch";
	const result = await tool.execute(
		"call-render",
		{ input },
		undefined,
		undefined,
		{ cwd },
	);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
	} as never;

	const call = renderApplyPatchCall({ input }, theme, { isError: false });
	assert.match(call.render(120).join("\n"), /apply_patch/);
	assert.match(call.render(120).join("\n"), /created\.txt/);

	const rendered = renderApplyPatchResult(
		result,
		{ expanded: true, isPartial: false },
		theme,
		{ isError: false },
	);
	const output = rendered.render(120).join("\n");
	assert.match(output, /add created\.txt/);
	assert.match(output, /\+1 hello/);
});

test("collapses long diffs and exposes the full diff when expanded", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
	} as never;
	const diff = Array.from({ length: 50 }, (_, index) => `+${index + 1} line-${index}`).join("\n");
	const result = {
		content: [{ type: "text" as const, text: "Applied patch successfully" }],
		details: {
			operations: [{ kind: "add" as const, path: "large.txt" }],
			changedPaths: ["large.txt"],
			fuzzyMatches: [],
			files: [{ path: "large.txt", kind: "add" as const, diff, additions: 50, deletions: 0 }],
			summary: { files: 1, additions: 50, deletions: 0 },
		},
	};

	const collapsed = renderApplyPatchResult(
		result,
		{ expanded: false, isPartial: false },
		theme,
		{ isError: false },
	);
	assert.match(collapsed.render(120).join("\n"), /expand to view/);

	const expanded = renderApplyPatchResult(
		result,
		{ expanded: true, isPartial: false },
		theme,
		{ isError: false },
	);
	assert.match(expanded.render(120).join("\n"), /\+50 line-49/);
});

test("serializes concurrent apply_patch calls through one mutation queue", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "value.txt"), "zero\n", "utf8");
	const tool = createApplyPatchTool();

	const first = tool.execute(
		"call-1",
		{
			input:
				"*** Begin Patch\n*** Update File: value.txt\n@@\n-zero\n+one\n*** End Patch",
		},
		undefined,
		undefined,
		{ cwd },
	);
	const second = tool.execute(
		"call-2",
		{
			input:
				"*** Begin Patch\n*** Update File: value.txt\n@@\n-one\n+two\n*** End Patch",
		},
		undefined,
		undefined,
		{ cwd },
	);

	await Promise.all([first, second]);
	assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "two\n");
});

test("source does not invoke Codex or any child process", async () => {
	const sourceFiles = [
		"index.ts",
		"apply.ts",
		"filesystem.ts",
		"parser.ts",
		"errors.ts",
		"types.ts",
		"diff.ts",
		"render.ts",
	];
	for (const file of sourceFiles) {
		const source = await readFile(
			new URL(`../src/${file}`, import.meta.url),
			"utf8",
		);
		assert.doesNotMatch(
			source,
			/node:child_process|\bspawn\s*\(|\bexecFile\s*\(|\bpi\.exec\s*\(/u,
			file,
		);
	}
});
