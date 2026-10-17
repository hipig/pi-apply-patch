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
	assert.equal(result.status, "complete");
	assert.deepEqual(result.outcomes.map((outcome) => outcome.status), [
		"complete", "complete", "complete", "complete",
	]);
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
	const ambiguous = await applyPatch(
		`*** Begin Patch
*** Update File: ambiguous.txt
@@
 same
-old
+new
*** End Patch`,
		cwd,
	);
	assert.equal(ambiguous.status, "failed");
	assert.deepEqual(ambiguous.changedPaths, []);
	assert.equal(ambiguous.outcomes[0]?.hunks[0]?.failure?.code, "context_ambiguous");
	assert.equal(
		await readFile(join(cwd, "ambiguous.txt"), "utf8"),
		"same\nold\nsame\nold\n",
	);
});

test("saves independent operations before and after a matching failure", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "existing.txt"), "stable\n", "utf8");

	const result = await applyPatch(
		`*** Begin Patch
*** Add File: before.txt
+before
*** Update File: existing.txt
@@
-missing
+changed
*** Add File: after.txt
+after
*** End Patch`,
		cwd,
	);

	assert.equal(await readFile(join(cwd, "before.txt"), "utf8"), "before\n");
	assert.equal(await readFile(join(cwd, "after.txt"), "utf8"), "after\n");
	assert.equal(await readFile(join(cwd, "existing.txt"), "utf8"), "stable\n");
	assert.equal(result.status, "partial");
	assert.deepEqual(new Set(result.changedPaths), new Set(["before.txt", "after.txt"]));
	assert.deepEqual(result.outcomes.map((outcome) => outcome.status), [
		"complete", "failed", "complete",
	]);
	assert.equal(result.outcomes[1]?.hunks[0]?.failure?.code, "context_not_found");
});

test("saves matched hunks once and keeps the cursor unchanged after failures", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "value.txt"), "start\r\none\r\nmiddle\r\nbeta\r\nend\r\nomega\r\n", "utf8");
	let writes = 0;
	const fileSystem: PatchFileSystem = {
		...nodeFileSystem,
		async writeFile(path, content) {
			writes += 1;
			await nodeFileSystem.writeFile(path, content);
		},
	};
	const input = `*** Begin Patch
*** Update File: value.txt
@@ start
-one
+ONE
+extra
@@ end
-missing
+ignored
@@ middle
-beta
+BETA
@@ missing-anchor
-anything
+ignored
@@ end
-omega
+OMEGA
*** End of File
*** End Patch`;
	const result = await applyPatch(input, cwd, { fileSystem });

	assert.equal(writes, 1);
	assert.equal(await readFile(join(cwd, "value.txt"), "utf8"),
		"start\r\nONE\r\nextra\r\nmiddle\r\nBETA\r\nend\r\nOMEGA\r\n");
	assert.equal(result.status, "partial");
	assert.deepEqual(result.outcomes[0]?.hunks.map((hunk) => hunk.status), [
		"applied", "failed", "applied", "failed", "applied",
	]);
	assert.deepEqual(result.outcomes[0]?.hunks.map((hunk) => hunk.lineNumber), [
		3, 7, 10, 13, 16,
	]);
	assert.equal(result.outcomes[0]?.hunks[1]?.failure?.message, "context was not found");
	assert.equal(result.outcomes[0]?.hunks[3]?.failure?.message, "anchor was not found");
	assert.deepEqual(result.summary, { files: 1, additions: 4, deletions: 3 });
	assert.doesNotMatch(result.files[0]?.diff ?? "", /ignored|missing|anything/);
});

test("repairs only the failed hunk without replaying saved changes", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "value.txt"), "one\nactual\nthree\n", "utf8");
	const partial = await applyPatch(
		`*** Begin Patch
*** Update File: value.txt
@@
-one
+ONE
@@
-mistaken
+TWO
@@
-three
+THREE
*** End Patch`,
		cwd,
	);
	assert.equal(partial.status, "partial");
	assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "ONE\nactual\nTHREE\n");

	const repaired = await applyPatch(
		`*** Begin Patch
*** Update File: value.txt
@@
-actual
+TWO
*** End Patch`,
		cwd,
	);
	assert.equal(repaired.status, "complete");
	assert.equal(await readFile(join(cwd, "value.txt"), "utf8"), "ONE\nTWO\nTHREE\n");
	assert.deepEqual(repaired.summary, { files: 1, additions: 1, deletions: 1 });
});

test("reports file operation failures and continues on independent paths", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "existing.txt"), "stable\n", "utf8");
	const result = await applyPatch(
		`*** Begin Patch
*** Add File: existing.txt
+replacement
*** Update File: missing-update.txt
@@
-old
+new
*** Delete File: missing-delete.txt
*** Add File: created.txt
+saved
*** End Patch`,
		cwd,
	);

	assert.equal(result.status, "partial");
	assert.deepEqual(result.outcomes.map((outcome) => outcome.failure?.code), [
		"file_exists", "file_not_found", "file_not_found", undefined,
	]);
	assert.deepEqual(result.changedPaths, ["created.txt"]);
	assert.equal(await readFile(join(cwd, "existing.txt"), "utf8"), "stable\n");
	assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "saved\n");
	assert.equal(result.outcomes[1]?.hunks[0]?.status, "blocked");
});

test("blocks later operations on incomplete paths without overwriting saved hunks", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "source.txt"), "one\n", "utf8");
	const result = await applyPatch(
		`*** Begin Patch
*** Update File: source.txt
@@
-one
+ONE
@@
-missing
+ignored
*** Delete File: ./source.txt
*** Update File: source.txt
*** Move to: moved.txt
*** Add File: moved.txt
+must-not-be-created
*** Add File: independent.txt
+saved
*** End Patch`,
		cwd,
	);

	assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "ONE\n");
	await assert.rejects(readFile(join(cwd, "moved.txt")), { code: "ENOENT" });
	assert.deepEqual(result.outcomes.map((outcome) => outcome.status), [
		"partial", "blocked", "blocked", "blocked", "complete",
	]);
	assert.equal(result.outcomes[1]?.failure?.code, "blocked_by_previous_operation");
	assert.match(result.outcomes[2]?.failure?.message ?? "", /operation 1/);
	assert.match(result.outcomes[3]?.failure?.message ?? "", /operation 3/);
	assert.deepEqual(new Set(result.changedPaths), new Set(["source.txt", "independent.txt"]));
});

test("skips an entire move when a hunk fails and does not count its matched hunks", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "source.txt"), "one   \ntwo\n", "utf8");
	const result = await applyPatch(
		`*** Begin Patch
*** Update File: source.txt
*** Move to: moved.txt
@@
-one
+ONE
@@
-missing
+ignored
*** Update File: moved.txt
@@
-ONE
+wrong
*** Delete File: source.txt
*** Add File: independent.txt
+saved
*** End Patch`,
		cwd,
	);

	assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "one   \ntwo\n");
	await assert.rejects(readFile(join(cwd, "moved.txt")), { code: "ENOENT" });
	assert.deepEqual(result.outcomes.map((outcome) => outcome.status), [
		"failed", "blocked", "blocked", "complete",
	]);
	assert.deepEqual(result.outcomes[0]?.hunks.map((hunk) => hunk.status), ["blocked", "failed"]);
	assert.equal(result.outcomes[0]?.hunks[0]?.mode, undefined);
	assert.deepEqual(result.fuzzyMatches, []);
	assert.deepEqual(result.operations, [{ kind: "add", path: "independent.txt" }]);
	assert.deepEqual(result.summary, { files: 1, additions: 1, deletions: 0 });
});

test("skips moves to existing destinations without changing either file", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "source.txt"), "old\n", "utf8");
	await writeFile(join(cwd, "destination.txt"), "keep\n", "utf8");
	const result = await applyPatch(
		`*** Begin Patch
*** Update File: source.txt
*** Move to: destination.txt
@@
-old
+new
*** Add File: independent.txt
+saved
*** End Patch`,
		cwd,
	);

	assert.equal(result.status, "partial");
	assert.equal(result.outcomes[0]?.failure?.code, "destination_exists");
	assert.equal(result.outcomes[0]?.hunks[0]?.status, "blocked");
	assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "old\n");
	assert.equal(await readFile(join(cwd, "destination.txt"), "utf8"), "keep\n");
	assert.deepEqual(result.changedPaths, ["independent.txt"]);
});

test("fatal preflight errors prevent every write, including otherwise blocked operations", async () => {
	const cwd = await workspace();
	await writeFile(join(cwd, "source.txt"), "stable\n", "utf8");
	await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
	await writeFile(join(cwd, "invalid.txt"), Buffer.from([0xff]));
	let writes = 0;
	const fileSystem: PatchFileSystem = {
		...nodeFileSystem,
		async writeFile(path, content) {
			writes += 1;
			await nodeFileSystem.writeFile(path, content);
		},
	};
	const invalidOperations = [
		"unexpected operation",
		"*** Update File: source.txt\n*** Move to: ../escape.txt",
		"*** Add File: parent.txt\n+x\n*** Add File: parent.txt/child.txt\n+y",
		"*** Update File: binary.bin\n@@\n-old\n+new",
		"*** Update File: invalid.txt\n@@\n-old\n+new",
	];
	for (const operation of invalidOperations) {
		await assert.rejects(applyPatch(
			`*** Begin Patch
*** Add File: saved.txt
+must-not-be-written
*** Update File: source.txt
@@
-missing
+ignored
${operation}
*** End Patch`,
			cwd,
			{ fileSystem },
		), PatchError);
		await assert.rejects(readFile(join(cwd, "saved.txt")), { code: "ENOENT" });
		assert.equal(await readFile(join(cwd, "source.txt"), "utf8"), "stable\n");
	}
	assert.equal(writes, 0);
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
@@
-missing
+ignored
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
