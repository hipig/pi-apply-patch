import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { applyPatch } from "../src/apply.ts";
import { PatchError } from "../src/errors.ts";
import { nodeFileSystem, type PatchFileSystem } from "../src/filesystem.ts";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "pi-apply-patch-"));
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

test("applies add, update, delete, and move operations after a complete preflight", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "source.txt"), "section\nold\nvalue\n", "utf8");
	await writeFile(join(cwd, "move.txt"), "before\n", "utf8");
	await writeFile(join(cwd, "delete.txt"), "unused\n", "utf8");

	const result = await applyPatch(
		`*** Begin Patch
*** Update File: source.txt
@@ section
 old
-value
+replacement
*** End of File
*** Add File: nested/new.txt
+hello
+world
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved.txt
@@
-before
+after
*** End Patch`,
		cwd,
	);

	assert.equal(
		await readFile(join(cwd, "source.txt"), "utf8"),
		"section\nold\nreplacement\n",
	);
	assert.equal(
		await readFile(join(cwd, "nested/new.txt"), "utf8"),
		"hello\nworld\n",
	);
	assert.equal(await readFile(join(cwd, "moved.txt"), "utf8"), "after\n");
	await assert.rejects(readFile(join(cwd, "move.txt"), "utf8"), {
		code: "ENOENT",
	});
	await assert.rejects(readFile(join(cwd, "delete.txt"), "utf8"), {
		code: "ENOENT",
	});
	assert.deepEqual(
		new Set(result.changedPaths),
		new Set([
			"source.txt",
			"nested/new.txt",
			"delete.txt",
			"move.txt",
			"moved.txt",
		]),
	);
	assert.equal(result.operations.length, 4);
	assert.deepEqual(result.summary, {
		files: 5,
		additions: 4,
		deletions: 3,
	});
	const diffs = new Map(result.files.map((file) => [file.path, file]));
	assert.equal(diffs.get("source.txt")?.kind, "update");
	assert.equal(diffs.get("source.txt")?.firstChangedLine, 3);
	assert.match(diffs.get("source.txt")?.diff ?? "", /-3 value/);
	assert.equal(diffs.get("delete.txt")?.kind, "delete");
	assert.equal(diffs.get("nested/new.txt")?.kind, "add");
	assert.deepEqual(diffs.get("move.txt")?.move, {
		from: "move.txt",
		to: "moved.txt",
		role: "source",
	});
	assert.deepEqual(diffs.get("moved.txt")?.move, {
		from: "move.txt",
		to: "moved.txt",
		role: "destination",
	});
});

test("preserves an existing file's CRLF style", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "windows.txt"), "one\r\ntwo\r\n", "utf8");

	const result = await applyPatch(
		`*** Begin Patch
*** Update File: windows.txt
@@
 one
-two
+second
*** End Patch`,
		cwd,
	);

	assert.equal(
		await readFile(join(cwd, "windows.txt"), "utf8"),
		"one\r\nsecond\r\n",
	);
	assert.equal(result.files[0]?.diff, " 1 one\n-2 two\n+2 second");
});

test("bounds large diff details without changing the committed file", async () => {
	const cwd = await workspace();
	const lines = Array.from({ length: 2_100 }, (_, index) => `+line-${index}`);
	const result = await applyPatch(
		`*** Begin Patch\n*** Add File: large.txt\n${lines.join("\n")}\n*** End Patch`,
		cwd,
	);

	const file = result.files[0];
	assert.equal(file?.truncated, true);
	assert.equal(file?.patch, undefined);
	assert.match(file?.diff ?? "", /diff truncated/);
	assert.ok((file?.diff.split("\n").length ?? 0) <= 2_000);
	assert.ok(Buffer.byteLength(file?.diff ?? "", "utf8") <= 64 * 1024);
	assert.equal((await readFile(join(cwd, "large.txt"), "utf8")).split("\n").length, 2_101);
});

test("uses whitespace-tolerant matching only when the location is unique", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "fuzzy.txt"), "one   \ntwo\n", "utf8");

	const result = await applyPatch(
		`*** Begin Patch
*** Update File: fuzzy.txt
@@
 one
-two
+second
*** End Patch`,
		cwd,
	);

	assert.deepEqual(result.fuzzyMatches, [
		{ path: "fuzzy.txt", hunk: 1, mode: "rstrip" },
	]);
	assert.equal(await readFile(join(cwd, "fuzzy.txt"), "utf8"), "one\nsecond\n");

	await writeFile(join(cwd, "ambiguous.txt"), "same\nold\nsame\nold\n", "utf8");
	await assert.rejects(
		applyPatch(
			`*** Begin Patch
*** Update File: ambiguous.txt
@@
 same
-old
+new
*** End Patch`,
			cwd,
		),
		/context is ambiguous/,
	);
	assert.equal(
		await readFile(join(cwd, "ambiguous.txt"), "utf8"),
		"same\nold\nsame\nold\n",
	);
});

test("does not write earlier operations when a later operation fails preflight", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "existing.txt"), "stable\n", "utf8");

	await assert.rejects(
		applyPatch(
			`*** Begin Patch
*** Add File: should-not-exist.txt
+temporary
*** Update File: existing.txt
@@
-missing
+changed
*** End Patch`,
			cwd,
		),
		/context was not found/,
	);

	await assert.rejects(readFile(join(cwd, "should-not-exist.txt"), "utf8"), {
		code: "ENOENT",
	});
	assert.equal(await readFile(join(cwd, "existing.txt"), "utf8"), "stable\n");
});

test("rolls back files already written when a later commit write fails", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "a.txt"), "old a\n", "utf8");
	await writeFile(join(cwd, "b.txt"), "old b\n", "utf8");

	let writes = 0;
	const failingFileSystem: PatchFileSystem = {
		...nodeFileSystem,
		async writeFile(path, content) {
			writes += 1;
			if (writes === 2) throw new Error("injected write failure");
			await nodeFileSystem.writeFile(path, content);
		},
	};

	await assert.rejects(
		applyPatch(
			`*** Begin Patch
*** Update File: a.txt
@@
-old a
+new a
*** Update File: b.txt
@@
-old b
+new b
*** End Patch`,
			cwd,
			{ fileSystem: failingFileSystem },
		),
		/All attempted changes were rolled back/,
	);

	assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "old a\n");
	assert.equal(await readFile(join(cwd, "b.txt"), "utf8"), "old b\n");
});

test("rejects traversal, absolute paths, symlink escapes, and binary files", async (context) => {
	const cwd = await workspace();
	await assert.rejects(
		applyPatch(
			"*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch",
			cwd,
		),
		PatchError,
	);
	await assert.rejects(
		applyPatch(
			"*** Begin Patch\n*** Add File: C:\\escape.txt\n+x\n*** End Patch",
			cwd,
		),
		PatchError,
	);

	await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
	await assert.rejects(
		applyPatch(
			"*** Begin Patch\n*** Update File: binary.bin\n@@\n-abc\n+def\n*** End Patch",
			cwd,
		),
		/binary/,
	);

	const outside = await workspace();
	try {
		await symlink(
			outside,
			join(cwd, "linked"),
			process.platform === "win32" ? "junction" : "dir",
		);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "EPERM" || error.code === "EACCES")
		) {
			context.diagnostic(
				"Symlink creation is unavailable on this host; symlink escape assertion skipped",
			);
			return;
		}
		throw error;
	}

	await assert.rejects(
		applyPatch(
			"*** Begin Patch\n*** Add File: linked/escape.txt\n+x\n*** End Patch",
			cwd,
		),
		/outside the workspace/,
	);
});

test("honors an already-aborted signal before changing files", async () => {
	const cwd = await workspace();
	const controller = new AbortController();
	controller.abort(new Error("cancelled"));

	await assert.rejects(
		applyPatch(
			"*** Begin Patch\n*** Add File: cancelled.txt\n+x\n*** End Patch",
			cwd,
			{ signal: controller.signal },
		),
		/cancelled/,
	);
	await assert.rejects(readFile(join(cwd, "cancelled.txt"), "utf8"), {
		code: "ENOENT",
	});
});
