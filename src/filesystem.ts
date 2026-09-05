import type { Stats } from "node:fs";
import {
	chmod as nodeChmod,
	lstat as nodeLstat,
	mkdir as nodeMkdir,
	readFile as nodeReadFile,
	realpath as nodeRealpath,
	rm as nodeRm,
	rmdir as nodeRmdir,
	stat as nodeStat,
	writeFile as nodeWriteFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";
import { asErrorMessage, PatchError } from "./errors.ts";

export interface PatchFileSystem {
	lstat(path: string): Promise<Stats>;
	stat(path: string): Promise<Stats>;
	realpath(path: string): Promise<string>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	rm(path: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	rmdir(path: string): Promise<void>;
}

export const nodeFileSystem: PatchFileSystem = {
	lstat: nodeLstat,
	stat: nodeStat,
	realpath: nodeRealpath,
	readFile: nodeReadFile,
	async writeFile(path, content) {
		await nodeWriteFile(path, content, "utf8");
	},
	chmod: nodeChmod,
	async rm(path) {
		await nodeRm(path, { force: true });
	},
	async mkdir(path) {
		await nodeMkdir(path);
	},
	rmdir: nodeRmdir,
};

export interface ResolvedPatchPath {
	displayPath: string;
	absolutePath: string;
	canonicalPath: string;
	key: string;
}

export interface FileState {
	exists: boolean;
	content?: string;
	mode?: number;
}

export interface PlannedFileChange {
	path: ResolvedPatchPath;
	before: FileState;
	after: FileState;
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isWithin(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) &&
			pathFromRoot !== ".." &&
			!isAbsolute(pathFromRoot))
	);
}

function pathKey(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function normalizePatchPath(input: string): string {
	if (!input || input.includes("\0"))
		throw new PatchError("Patch path cannot be empty or contain NUL bytes");
	if (
		isAbsolute(input) ||
		win32.isAbsolute(input) ||
		/^[A-Za-z]:/.test(input)
	) {
		throw new PatchError(`Absolute patch path is not allowed: ${input}`);
	}

	const normalized = input.replaceAll("\\", "/");
	const segments = normalized
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".");
	if (segments.length === 0)
		throw new PatchError(`Patch path does not name a file: ${input}`);
	if (segments.includes(".."))
		throw new PatchError(
			`Patch path cannot traverse outside the workspace: ${input}`,
		);

	if (process.platform === "win32") {
		for (const segment of segments) {
			if (segment.includes(":") || /[. ]$/.test(segment)) {
				throw new PatchError(`Patch path is unsafe on Windows: ${input}`);
			}
		}
	}

	return segments.join("/");
}

export class WorkspacePaths {
	readonly rootPath: string;
	readonly rootRealPath: string;
	private readonly fileSystem: PatchFileSystem;

	private constructor(
		rootPath: string,
		rootRealPath: string,
		fileSystem: PatchFileSystem,
	) {
		this.rootPath = rootPath;
		this.rootRealPath = rootRealPath;
		this.fileSystem = fileSystem;
	}

	static async create(
		cwd: string,
		fileSystem: PatchFileSystem = nodeFileSystem,
	): Promise<WorkspacePaths> {
		const rootPath = resolve(cwd);
		let rootStats: Stats;
		try {
			rootStats = await fileSystem.stat(rootPath);
		} catch (error) {
			throw new PatchError(
				`Cannot access workspace ${rootPath}: ${asErrorMessage(error)}`,
			);
		}
		if (!rootStats.isDirectory())
			throw new PatchError(`Workspace is not a directory: ${rootPath}`);
		const rootRealPath = await fileSystem.realpath(rootPath);
		return new WorkspacePaths(rootPath, rootRealPath, fileSystem);
	}

	async resolve(input: string): Promise<ResolvedPatchPath> {
		const displayPath = normalizePatchPath(input);
		const absolutePath = resolve(this.rootPath, ...displayPath.split("/"));
		if (
			!isWithin(this.rootPath, absolutePath) ||
			absolutePath === this.rootPath
		) {
			throw new PatchError(`Patch path escapes the workspace: ${input}`);
		}

		let existingPath = absolutePath;
		let existingStats: Stats | undefined;
		while (existingPath !== this.rootPath) {
			try {
				existingStats = await this.fileSystem.lstat(existingPath);
				break;
			} catch (error) {
				if (!isErrno(error, "ENOENT")) {
					throw new PatchError(
						`Cannot inspect ${displayPath}: ${asErrorMessage(error)}`,
					);
				}
				existingPath = dirname(existingPath);
			}
		}

		existingStats ??= await this.fileSystem.lstat(this.rootPath);
		if (existingPath === absolutePath && existingStats.isSymbolicLink()) {
			throw new PatchError(
				`Refusing to modify a symbolic link: ${displayPath}`,
			);
		}

		const existingRealPath = await this.fileSystem.realpath(existingPath);
		if (!isWithin(this.rootRealPath, existingRealPath)) {
			throw new PatchError(
				`Patch path resolves outside the workspace: ${displayPath}`,
			);
		}

		if (existingPath !== absolutePath) {
			const followedStats = await this.fileSystem.stat(existingPath);
			if (!followedStats.isDirectory()) {
				throw new PatchError(
					`Parent path is not a directory: ${relative(this.rootPath, existingPath)}`,
				);
			}
		}

		const unresolvedSuffix = relative(existingPath, absolutePath);
		const canonicalPath = unresolvedSuffix
			? resolve(existingRealPath, unresolvedSuffix)
			: existingRealPath;
		if (!isWithin(this.rootRealPath, canonicalPath)) {
			throw new PatchError(
				`Patch path resolves outside the workspace: ${displayPath}`,
			);
		}

		return {
			displayPath,
			absolutePath,
			canonicalPath,
			key: pathKey(canonicalPath),
		};
	}
}

export async function readFileState(
	path: ResolvedPatchPath,
	fileSystem: PatchFileSystem,
): Promise<FileState> {
	let stats: Stats;
	try {
		stats = await fileSystem.lstat(path.absolutePath);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return { exists: false };
		throw new PatchError(
			`Cannot inspect ${path.displayPath}: ${asErrorMessage(error)}`,
		);
	}

	if (stats.isSymbolicLink())
		throw new PatchError(
			`Refusing to modify a symbolic link: ${path.displayPath}`,
		);
	if (!stats.isFile())
		throw new PatchError(
			`Patch target is not a regular file: ${path.displayPath}`,
		);

	const bytes = await fileSystem.readFile(path.absolutePath);
	if (bytes.includes(0))
		throw new PatchError(
			`Patch target appears to be binary: ${path.displayPath}`,
		);

	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new PatchError(
			`Patch target is not valid UTF-8: ${path.displayPath}`,
		);
	}

	return { exists: true, content, mode: stats.mode & 0o777 };
}

function statesEqual(left: FileState, right: FileState): boolean {
	if (left.exists !== right.exists) return false;
	if (!left.exists) return true;
	return left.content === right.content && left.mode === right.mode;
}

async function ensureDirectory(
	target: string,
	workspace: WorkspacePaths,
	fileSystem: PatchFileSystem,
	createdDirectories: Set<string>,
): Promise<void> {
	if (target === workspace.rootPath) return;

	const missing: string[] = [];
	let current = target;
	while (current !== workspace.rootPath) {
		try {
			const stats = await fileSystem.stat(current);
			if (!stats.isDirectory())
				throw new PatchError(`Parent path is not a directory: ${current}`);
			break;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
			missing.push(current);
			current = dirname(current);
		}
	}

	for (const path of missing.reverse()) {
		try {
			await fileSystem.mkdir(path);
			createdDirectories.add(path);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			const stats = await fileSystem.stat(path);
			if (!stats.isDirectory()) throw error;
		}
	}
}

async function removeCreatedDirectories(
	paths: Set<string>,
	fileSystem: PatchFileSystem,
): Promise<void> {
	const deepestFirst = [...paths].sort(
		(left, right) => right.length - left.length,
	);
	for (const path of deepestFirst) {
		try {
			await fileSystem.rmdir(path);
		} catch (error) {
			if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTEMPTY"))
				throw error;
		}
	}
}

async function restoreChanges(
	attempted: PlannedFileChange[],
	workspace: WorkspacePaths,
	fileSystem: PatchFileSystem,
	createdDirectories: Set<string>,
): Promise<string[]> {
	const failures: string[] = [];
	for (const change of [...attempted].reverse()) {
		try {
			if (change.before.exists) {
				await ensureDirectory(
					dirname(change.path.absolutePath),
					workspace,
					fileSystem,
					createdDirectories,
				);
				await fileSystem.writeFile(
					change.path.absolutePath,
					change.before.content ?? "",
				);
				if (change.before.mode !== undefined)
					await fileSystem.chmod(change.path.absolutePath, change.before.mode);
			} else {
				await fileSystem.rm(change.path.absolutePath);
			}
		} catch (error) {
			failures.push(`${change.path.displayPath}: ${asErrorMessage(error)}`);
		}
	}

	try {
		await removeCreatedDirectories(createdDirectories, fileSystem);
	} catch (error) {
		failures.push(`directory cleanup: ${asErrorMessage(error)}`);
	}
	return failures;
}

export async function commitFileChanges(
	allChanges: PlannedFileChange[],
	workspace: WorkspacePaths,
	fileSystem: PatchFileSystem = nodeFileSystem,
): Promise<string[]> {
	const changes = allChanges
		.filter((change) => !statesEqual(change.before, change.after))
		.sort((left, right) =>
			left.path.absolutePath.localeCompare(right.path.absolutePath),
		);
	const attempted: PlannedFileChange[] = [];
	const createdDirectories = new Set<string>();

	try {
		for (const change of changes.filter((entry) => !entry.after.exists)) {
			attempted.push(change);
			await fileSystem.rm(change.path.absolutePath);
		}
		for (const change of changes.filter((entry) => entry.after.exists)) {
			await ensureDirectory(
				dirname(change.path.absolutePath),
				workspace,
				fileSystem,
				createdDirectories,
			);
			attempted.push(change);
			await fileSystem.writeFile(
				change.path.absolutePath,
				change.after.content ?? "",
			);
			if (change.after.mode !== undefined)
				await fileSystem.chmod(change.path.absolutePath, change.after.mode);
		}
	} catch (error) {
		const rollbackFailures = await restoreChanges(
			attempted,
			workspace,
			fileSystem,
			createdDirectories,
		);
		const rollbackMessage =
			rollbackFailures.length === 0
				? "All attempted changes were rolled back."
				: `Rollback was incomplete: ${rollbackFailures.join("; ")}`;
		throw new PatchError(
			`Failed to commit patch: ${asErrorMessage(error)}. ${rollbackMessage}`,
		);
	}

	return changes.map((change) => change.path.displayPath);
}
