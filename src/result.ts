import type { ApplyPatchResult } from "./types.ts";

export function formatPatchSummary(result: ApplyPatchResult): string {
	if (result.status === "failed") return "Patch failed; no files changed.";
	if (result.changedPaths.length === 0) {
		return result.status === "partial"
			? "Patch partially applied; no file content changed."
			: "Patch applied successfully; no file content changed.";
	}

	const files = `${result.changedPaths.length} file${result.changedPaths.length === 1 ? "" : "s"}`;
	const changes = `(+${result.summary.additions} -${result.summary.deletions})`;
	if (result.status === "complete")
		return `Applied patch successfully to ${files} ${changes}:`;

	const appliedHunks = result.outcomes.reduce(
		(count, outcome) => count + outcome.hunks.filter((hunk) => hunk.status === "applied").length,
		0,
	);
	return `Partially applied patch: ${files} saved ${changes}; ${appliedHunks} hunk${appliedHunks === 1 ? "" : "s"} applied:`;
}

export function formatUnappliedChanges(result: ApplyPatchResult): string {
	const lines: string[] = [];
	for (const outcome of result.outcomes) {
		if (outcome.status === "complete") continue;
		const path = outcome.destination === undefined
			? outcome.path
			: `${outcome.path} -> ${outcome.destination}`;
		const location = `${path}: operation ${outcome.operation}`;
		if (outcome.failure !== undefined) {
			lines.push(`- ${location}, patch line ${outcome.lineNumber}: ${outcome.failure.message}.`);
		} else if (outcome.kind === "move") {
			lines.push(`- ${location}, patch line ${outcome.lineNumber}: entire move skipped.`);
		}
		for (const hunk of outcome.hunks) {
			if (hunk.status !== "failed" || hunk.failure === undefined) continue;
			lines.push(`- ${location}, hunk ${hunk.hunk}, patch line ${hunk.lineNumber}: ${hunk.failure.message}.`);
		}
	}
	if (lines.length === 0) return "";
	return [
		"Unapplied changes:",
		...lines,
		"Read the current files and retry only unapplied changes; do not resend the original patch.",
	].join("\n");
}

export function formatApplyPatchResult(result: ApplyPatchResult): string {
	const lines = [formatPatchSummary(result), ...result.changedPaths.map((path) => `- ${path}`)];
	if (result.fuzzyMatches.length > 0) {
		lines.push(
			`Matched ${result.fuzzyMatches.length} hunk${result.fuzzyMatches.length === 1 ? "" : "s"} with whitespace tolerance.`,
		);
	}
	const unapplied = formatUnappliedChanges(result);
	if (unapplied !== "") lines.push(unapplied);
	return lines.join("\n");
}
