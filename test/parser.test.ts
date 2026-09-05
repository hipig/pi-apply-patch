import assert from "node:assert/strict";
import { test } from "node:test";
import { PatchError } from "../src/errors.ts";
import { parsePatch } from "../src/parser.ts";

const COMPLETE_PATCH = `*** Begin Patch
*** Add File: added.txt
+first
+second
*** Update File: source.txt
*** Move to: moved.txt
@@ section
 old
-new
+replacement
*** End of File
*** Delete File: deleted.txt
*** End Patch`;

test("parses add, update, move, delete, anchors, and EOF markers", () => {
	const parsed = parsePatch(COMPLETE_PATCH);
	assert.equal(parsed.files.length, 3);

	const [added, updated, deleted] = parsed.files;
	assert.deepEqual(added, {
		kind: "add",
		path: "added.txt",
		content: "first\nsecond\n",
		lineNumber: 2,
	});
	assert.equal(updated?.kind, "update");
	if (updated?.kind !== "update") assert.fail("Expected an update operation");
	assert.equal(updated.path, "source.txt");
	assert.equal(updated.moveTo, "moved.txt");
	assert.equal(updated.hunks.length, 1);
	assert.equal(updated.hunks[0]?.anchor, "section");
	assert.equal(updated.hunks[0]?.endOfFile, true);
	assert.deepEqual(
		updated.hunks[0]?.lines.map(({ kind, text }) => ({ kind, text })),
		[
			{ kind: "context", text: "old" },
			{ kind: "delete", text: "new" },
			{ kind: "add", text: "replacement" },
		],
	);
	assert.deepEqual(deleted, {
		kind: "delete",
		path: "deleted.txt",
		lineNumber: 12,
	});
});

test("accepts update hunks without an explicit @@ marker", () => {
	const parsed = parsePatch(`*** Begin Patch
*** Update File: a.txt
-old
+new
*** End Patch`);
	const operation = parsed.files[0];
	assert.equal(operation?.kind, "update");
	if (operation?.kind !== "update") assert.fail("Expected an update operation");
	assert.equal(operation.hunks.length, 1);
	assert.equal(operation.hunks[0]?.lineNumber, 3);
});

test("normalizes CRLF in the patch document", () => {
	const parsed = parsePatch(
		"*** Begin Patch\r\n*** Add File: a.txt\r\n+x\r\n*** End Patch\r\n",
	);
	assert.equal(parsed.files[0]?.kind, "add");
});

test("rejects malformed envelopes and malformed operation lines", () => {
	const invalid = [
		"*** Add File: a.txt\n+x\n*** End Patch",
		"*** Begin Patch\n*** Add File: a.txt\nx\n*** End Patch",
		"*** Begin Patch\n*** Update File: a.txt\n@@\n context only\n*** End Patch",
		"*** Begin Patch\n*** Delete File: \n*** End Patch",
		"*** Begin Patch\n*** End Patch",
	];

	for (const input of invalid) {
		assert.throws(() => parsePatch(input), PatchError);
	}
});
