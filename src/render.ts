import type {
	AgentToolResult,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import * as Diff from "diff";
import { parsePatch } from "./parser.ts";
import { formatPatchSummary, formatUnappliedChanges } from "./result.ts";
import type { ApplyPatchResult } from "./types.ts";

export interface ApplyPatchArgs {
	input?: string;
}

interface ApplyPatchRenderContext {
	isError: boolean;
}

interface ParsedDiffLine {
	prefix: string;
	lineNumber: string;
	content: string;
}

const COLLAPSED_DIFF_LINES = 40;

function parseDiffLine(line: string): ParsedDiffLine | undefined {
	const match = /^([+-\s])(\s*\d*)\s(.*)$/.exec(line);
	if (!match) return undefined;
	return {
		prefix: match[1] ?? " ",
		lineNumber: match[2] ?? "",
		content: match[3] ?? "",
	};
}

function replaceTabs(text: string): string {
	return text.replaceAll("\t", "   ");
}

function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	theme: Theme,
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);
	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			if (isFirstRemoved) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWhitespace.length);
				removedLine += leadingWhitespace;
				isFirstRemoved = false;
			}
			removedLine += value === "" ? "" : theme.inverse(value);
		} else if (part.added) {
			let value = part.value;
			if (isFirstAdded) {
				const leadingWhitespace = value.match(/^(\s*)/)?.[1] ?? "";
				value = value.slice(leadingWhitespace.length);
				addedLine += leadingWhitespace;
				isFirstAdded = false;
			}
			addedLine += value === "" ? "" : theme.inverse(value);
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

/** Render a line-numbered diff with the same visual conventions as Pi edit. */
export function renderDisplayDiff(diffText: string, theme: Theme): string {
	const lines = diffText.split("\n");
	const rendered: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const parsed = parseDiffLine(line);
		if (!parsed) {
			rendered.push(theme.fg("toolDiffContext", line));
			index += 1;
			continue;
		}

		if (parsed.prefix === "-") {
			const removedLines: ParsedDiffLine[] = [];
			while (index < lines.length) {
				const current = parseDiffLine(lines[index] ?? "");
				if (current?.prefix !== "-") break;
				removedLines.push(current);
				index += 1;
			}
			const addedLines: ParsedDiffLine[] = [];
			while (index < lines.length) {
				const current = parseDiffLine(lines[index] ?? "");
				if (current?.prefix !== "+") break;
				addedLines.push(current);
				index += 1;
			}

			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];
				if (removed && added) {
					const intraLine = renderIntraLineDiff(
						replaceTabs(removed.content),
						replaceTabs(added.content),
						theme,
					);
					rendered.push(
						theme.fg(
							"toolDiffRemoved",
							`-${removed.lineNumber} ${intraLine.removedLine}`,
						),
					);
					rendered.push(
						theme.fg(
							"toolDiffAdded",
							`+${added.lineNumber} ${intraLine.addedLine}`,
						),
					);
					continue;
				}
			}

			for (const removed of removedLines) {
				rendered.push(
					theme.fg(
						"toolDiffRemoved",
						`-${removed.lineNumber} ${replaceTabs(removed.content)}`,
					),
				);
			}
			for (const added of addedLines) {
				rendered.push(
					theme.fg(
						"toolDiffAdded",
						`+${added.lineNumber} ${replaceTabs(added.content)}`,
					),
				);
			}
			continue;
		}

		if (parsed.prefix === "+") {
			rendered.push(
				theme.fg(
					"toolDiffAdded",
					`+${parsed.lineNumber} ${replaceTabs(parsed.content)}`,
				),
			);
			index += 1;
			continue;
		}

		rendered.push(
			theme.fg(
				"toolDiffContext",
				` ${parsed.lineNumber} ${replaceTabs(parsed.content)}`,
			),
		);
		index += 1;
	}

	return rendered.join("\n");
}

function summarizePatchCall(input: string): string {
	try {
		const parsed = parsePatch(input);
		const paths = parsed.files.map((file) =>
			file.kind === "update" && file.moveTo !== undefined
				? `${file.path} -> ${file.moveTo}`
				: file.path,
		);
		const counts = {
			add: parsed.files.filter((file) => file.kind === "add").length,
			update: parsed.files.filter((file) => file.kind === "update").length,
			delete: parsed.files.filter((file) => file.kind === "delete").length,
		};
		const operations = [`${parsed.files.length} file${parsed.files.length === 1 ? "" : "s"}`];
		if (counts.add > 0) operations.push(`+${counts.add}`);
		if (counts.update > 0) operations.push(`~${counts.update}`);
		if (counts.delete > 0) operations.push(`-${counts.delete}`);
		return `${operations.join(" ")} ${paths.join(", ")}`;
	} catch {
		return "validating patch";
	}
}

function contentText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function isApplyPatchResult(value: unknown): value is ApplyPatchResult {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ApplyPatchResult>;
	return Array.isArray(candidate.files) && Array.isArray(candidate.outcomes) &&
		candidate.summary !== undefined &&
		(candidate.status === "complete" || candidate.status === "partial" || candidate.status === "failed");
}

function fileLabel(file: ApplyPatchResult["files"][number]): string {
	const kind = file.move === undefined ? file.kind : `move ${file.move.role}`;
	const target =
		file.move === undefined
			? file.path
			: `${file.move.from} -> ${file.move.to}`;
	return `${kind} ${target} (+${file.additions} -${file.deletions})`;
}

export function renderApplyPatchCall(
	args: ApplyPatchArgs | undefined,
	theme: Theme,
	_context: ApplyPatchRenderContext,
): Text {
	const title = theme.fg("toolTitle", theme.bold("apply_patch"));
	return new Text(
		`${title} ${theme.fg("muted", summarizePatchCall(args?.input ?? ""))}`,
		0,
		0,
	);
}

export function renderApplyPatchResult(
	result: AgentToolResult<ApplyPatchResult>,
	options: ToolRenderResultOptions,
	theme: Theme,
	_context: ApplyPatchRenderContext,
): Container | Text {
	const text = contentText(result);
	if (_context.isError) return new Text(theme.fg("error", text), 0, 0);

	const details = isApplyPatchResult(result.details) ? result.details : undefined;
	if (details === undefined) {
		return new Text(text, 0, 0);
	}
	const color = details.status === "complete" ? "success"
		: details.status === "partial" ? "warning" : "error";
	if (details.files.length === 0) return new Text(theme.fg(color, text), 0, 0);

	const container = new Container();
	container.addChild(
		new Text(
			theme.fg(color, formatPatchSummary(details)),
			0,
			0,
		),
	);
	if (details.fuzzyMatches.length > 0) {
		container.addChild(
			new Text(
				theme.fg(
					"warning",
					`Matched ${details.fuzzyMatches.length} hunk${details.fuzzyMatches.length === 1 ? "" : "s"} with whitespace tolerance.`,
				),
				0,
				0,
			),
		);
	}
	const unapplied = formatUnappliedChanges(details);
	if (unapplied !== "") {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg(color, unapplied), 0, 0));
	}

	let remaining = options.expanded ? Number.POSITIVE_INFINITY : COLLAPSED_DIFF_LINES;
	for (const file of details.files) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("toolTitle", theme.bold(fileLabel(file))), 0, 0),
		);

		const lines = file.diff.split("\n");
		const shown = options.expanded ? lines : lines.slice(0, Math.max(0, remaining));
		remaining -= shown.length;
		const hidden = lines.length - shown.length;
		const diffText = shown.join("\n");
		if (diffText !== "") {
			container.addChild(new Text(renderDisplayDiff(diffText, theme), 0, 0));
		}
		if (hidden > 0 || file.truncated) {
			container.addChild(
				new Text(
					theme.fg("muted", `... ${hidden > 0 ? `${hidden} more lines; ` : ""}expand to view ...`),
					0,
					0,
				),
			);
		}
	}

	return container;
}
