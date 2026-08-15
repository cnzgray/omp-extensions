/*
 * Ported from DeepSeek Harness
 * packages/fs/tool-str-replace-editor/src/index.ts at commit
 * 47f943859bef60e4160492346772ded9b24f765a.
 *
 * MIT License
 *
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const STR_REPLACE_EDITOR_NAME = "str_replace_editor";

export const STR_REPLACE_EDITOR_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim();

export const STR_REPLACE_EDITOR_WIRE_TOOL = {
	type: "function",
	function: {
		name: STR_REPLACE_EDITOR_NAME,
		description: STR_REPLACE_EDITOR_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					enum: ["view", "create", "str_replace", "insert"],
					description: "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
				},
				path: {
					type: "string",
					description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
				},
				file_text: {
					type: "string",
					description: "Required parameter of `create` command, with the content of the file to be created.",
				},
				insert_line: {
					type: "integer",
					description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
				},
				new_str: {
					type: "string",
					description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
				},
				old_str: {
					type: "string",
					description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
				},
				view_range: {
					type: "array",
					items: { type: "integer" },
					description: "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
				},
			},
			required: ["command", "path"],
		},
	},
} as const;

type EditorCommand = "view" | "create" | "str_replace" | "insert";

interface EditorParams {
	command: EditorCommand;
	path: string;
	file_text?: string;
	insert_line?: number;
	new_str?: string;
	old_str?: string;
	view_range?: number[];
}

interface SchemaLike {
	describe(description: string): SchemaLike;
	int(): SchemaLike;
	optional(): SchemaLike;
}

interface ZodLike {
	array(element: SchemaLike): SchemaLike;
	enum(values: readonly [string, ...string[]]): SchemaLike;
	number(): SchemaLike;
	object(shape: Record<string, SchemaLike>): unknown;
	string(): SchemaLike;
}

interface ExtensionContext {
	cwd: string;
}

interface EditorToolResult {
	content: Array<{ type: "text"; text: string }>;
}

interface EditorToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	loadMode: "essential";
	defaultInactive: boolean;
	approval: "write";
	execute(
		toolCallId: string,
		params: EditorParams,
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<EditorToolResult>;
}

interface ExtensionApi {
	zod: ZodLike;
	registerTool(definition: EditorToolDefinition): void;
}

export type EditorExtensionApi = ExtensionApi;

interface ResolvedTarget {
	workspace: string;
	path: string;
}
interface FileInfo {
	isDirectory(): boolean;
	isFile(): boolean;
}

interface ExistingTarget extends ResolvedTarget {
	canonicalWorkspace: string;
	ioPath: string;
	info: FileInfo;
}

const MAX_OUTPUT_CHARS = 16_000;
const TRUNCATED_MESSAGE = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

function maybeTruncate(content: string): string {
	if (content.length <= MAX_OUTPUT_CHARS) return content;
	return content.slice(0, MAX_OUTPUT_CHARS - TRUNCATED_MESSAGE.length) + TRUNCATED_MESSAGE;
}

function isWithin(root: string, candidate: string): boolean {
	const remainder = relative(root, candidate);
	return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function resolveTarget(cwd: string, path: string): ResolvedTarget {
	if (typeof path !== "string" || path.trim().length === 0) {
		throw new Error("path must be a non-empty string");
	}
	const workspace = resolve(cwd);
	const target = resolve(workspace, path);
	if (!isWithin(workspace, target)) {
		throw new Error(`The path ${path} is outside the working directory ${workspace}.`);
	}
	return { workspace, path: target };
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function statExisting(
	resolved: ResolvedTarget,
	command: "view" | "str_replace" | "insert",
): Promise<ExistingTarget> {
	let info: FileInfo;
	try {
		info = await stat(resolved.path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			throw new Error(`The path ${resolved.path} does not exist. Please provide a valid path.`);
		}
		throw error;
	}

	const [canonicalWorkspace, ioPath] = await Promise.all([
		realpath(resolved.workspace),
		realpath(resolved.path),
	]);
	if (!isWithin(canonicalWorkspace, ioPath)) {
		throw new Error(`The path ${resolved.path} resolves outside the working directory ${resolved.workspace}.`);
	}
	if (info.isDirectory() && command !== "view") {
		throw new Error(`The path ${resolved.path} is a directory and only the \`view\` command can be used on directories`);
	}
	return { ...resolved, canonicalWorkspace, ioPath, info };
}

function requiredForCommand(
	value: string | undefined,
	parameter: string,
	command: EditorCommand,
	allowEmpty = true,
): string {
	if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
	if (typeof value !== "string") throw new Error(`Parameter \`${parameter}\` must be a string for command: ${command}`);
	if (!allowEmpty && value.length === 0) {
		throw new Error(`Parameter \`${parameter}\` is empty for command: ${command}`);
	}
	return value;
}

function matchOffsets(content: string, search: string): number[] {
	const offsets: number[] = [];
	let offset = 0;
	while (true) {
		const match = content.indexOf(search, offset);
		if (match < 0) return offsets;
		offsets.push(match);
		offset = match + search.length;
	}
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
	let line = 1;
	let cursor = 0;
	return offsets.map((offset) => {
		while (cursor < offset) {
			if (content[cursor] === "\n") line += 1;
			cursor += 1;
		}
		return line;
	});
}

function formatFileView(path: string, content: string, viewRange?: number[]): string {
	const allLines = content.split("\n");
	let lines = allLines;
	let initialLine = 1;
	let finalLine: number | undefined;
	let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;

	if (viewRange !== undefined) {
		if (!Array.isArray(viewRange) || viewRange.length !== 2) {
			throw new Error("Invalid `view_range`. It should be a list of two integers.");
		}
		const [requestedInitialLine, requestedFinalLine] = viewRange;
		if (
			requestedInitialLine === undefined
			|| requestedFinalLine === undefined
			|| !viewRange.every(Number.isInteger)
		) {
			throw new Error("Invalid `view_range`. It should be a list of two integers.");
		}
		initialLine = requestedInitialLine;
		finalLine = requestedFinalLine;
		if (initialLine < 1 || initialLine > allLines.length) {
			throw new Error(
				`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
			);
		}
		if (finalLine > allLines.length) {
			throw new Error(
				`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
			);
		}
		if (finalLine !== -1 && finalLine < initialLine) {
			throw new Error(
				`Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
			);
		}
		lines = finalLine === -1
			? allLines.slice(initialLine - 1)
			: allLines.slice(initialLine - 1, finalLine);
		prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
	}

	const numbered = lines
		.map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`)
		.join("\n");
	return `${prompt}:\n${numbered}\n`;
}

async function listDirectory(target: ExistingTarget): Promise<string> {
	async function visit(ioDirectory: string, displayDirectory: string, depth: number): Promise<string[]> {
		const entries = await readdir(ioDirectory, { withFileTypes: true });
		const rows: string[] = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
			const displayPath = join(displayDirectory, entry.name);
			const ioPath = join(ioDirectory, entry.name);
			const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?";
			rows.push(`${type}\t${displayPath}`);
			if (entry.isDirectory() && depth < 2) {
				const canonicalChild = await realpath(ioPath);
				if (!isWithin(target.canonicalWorkspace, canonicalChild)) {
					throw new Error(`The path ${displayPath} resolves outside the working directory ${target.workspace}.`);
				}
				rows.push(...await visit(canonicalChild, displayPath, depth + 1));
			}
		}
		return rows;
	}

	const rows = [`d\t${target.path}`, ...await visit(target.ioPath, target.path, 1)];
	rows.sort((left, right) => {
		const leftPath = left.slice(left.indexOf("\t") + 1);
		const rightPath = right.slice(right.indexOf("\t") + 1);
		return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
	});
	return `Here're the files and directories up to 2 levels deep in ${target.path}, excluding hidden items, node_modules, and Python cache directories:\n${rows.join("\n")}\n\n`;
}

async function viewPath(cwd: string, path: string, viewRange: number[] | undefined): Promise<string> {
	const target = await statExisting(resolveTarget(cwd, path), "view");
	if (target.info.isDirectory()) {
		if (viewRange !== undefined) {
			throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
		}
		return listDirectory(target);
	}
	if (!target.info.isFile()) {
		throw new Error(`cannot view "${target.path}": not a regular file or directory`);
	}
	return formatFileView(target.path, await readFile(target.ioPath, "utf8"), viewRange);
}

async function createFile(cwd: string, path: string, fileText: string | undefined): Promise<string> {
	const content = requiredForCommand(fileText, "file_text", "create");
	const target = resolveTarget(cwd, path);
	try {
		await lstat(target.path);
		throw new Error(`File already exists at: ${target.path}. Cannot overwrite files using command \`create\`.`);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}

	let canonicalWorkspace: string;
	let canonicalParent: string;
	try {
		[canonicalWorkspace, canonicalParent] = await Promise.all([
			realpath(target.workspace),
			realpath(dirname(target.path)),
		]);
	} catch (error) {
		if (errorCode(error) === "ENOENT") {
			throw new Error(`The parent directory ${dirname(target.path)} does not exist.`);
		}
		throw error;
	}
	if (!isWithin(canonicalWorkspace, canonicalParent)) {
		throw new Error(`The path ${target.path} resolves outside the working directory ${target.workspace}.`);
	}
	if (!(await stat(canonicalParent)).isDirectory()) {
		throw new Error(`The parent path ${dirname(target.path)} is not a directory.`);
	}

	const ioPath = join(canonicalParent, basename(target.path));
	try {
		await writeFile(ioPath, content, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if (errorCode(error) === "EEXIST") {
			throw new Error(`File already exists at: ${target.path}. Cannot overwrite files using command \`create\`.`);
		}
		throw error;
	}
	return `New file created successfully at: ${target.path}`;
}

async function replaceInFile(
	cwd: string,
	path: string,
	oldStr: string | undefined,
	newStr: string | undefined,
): Promise<string> {
	const oldValue = requiredForCommand(oldStr, "old_str", "str_replace", false);
	const newValue = newStr === undefined ? "" : requiredForCommand(newStr, "new_str", "str_replace");
	const target = await statExisting(resolveTarget(cwd, path), "str_replace");
	if (!target.info.isFile()) {
		throw new Error(`cannot edit "${target.path}": not a regular file`);
	}

	const before = await readFile(target.ioPath, "utf8");
	const offsets = matchOffsets(before, oldValue);
	const offset = offsets[0];
	if (offset === undefined) {
		throw new Error(`No replacement was performed, old_str \`${oldValue}\` did not appear verbatim in ${target.path}.`);
	}
	if (offsets.length > 1) {
		const lines = lineNumbersAt(before, offsets);
		throw new Error(
			`No replacement was performed. Multiple occurrences of old_str \`${oldValue}\` in lines [${lines.join(", ")}]. Please ensure it is unique`,
		);
	}

	await writeFile(
		target.ioPath,
		before.slice(0, offset) + newValue + before.slice(offset + oldValue.length),
		"utf8",
	);
	return `The file ${target.path} has been edited successfully.`;
}

async function insertInFile(
	cwd: string,
	path: string,
	insertLine: number | undefined,
	newStr: string | undefined,
): Promise<string> {
	if (insertLine === undefined) throw new Error("Parameter `insert_line` is required for command: insert");
	const value = requiredForCommand(newStr, "new_str", "insert");
	const target = await statExisting(resolveTarget(cwd, path), "insert");
	if (!target.info.isFile()) {
		throw new Error(`cannot insert into "${target.path}": not a regular file`);
	}

	const before = await readFile(target.ioPath, "utf8");
	const lines = before.split("\n");
	if (!Number.isInteger(insertLine) || insertLine < 0 || insertLine > lines.length) {
		throw new Error(
			`Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`,
		);
	}
	const after = [
		...lines.slice(0, insertLine),
		...value.split("\n"),
		...lines.slice(insertLine),
	].join("\n");
	await writeFile(target.ioPath, after, "utf8");
	return `The file ${target.path} has been edited successfully.`;
}

async function executeEditor(params: EditorParams, cwd: string): Promise<string> {
	switch (params.command) {
		case "view":
			return viewPath(cwd, params.path, params.view_range);
		case "create":
			return createFile(cwd, params.path, params.file_text);
		case "str_replace":
			return replaceInFile(cwd, params.path, params.old_str, params.new_str);
		case "insert":
			return insertInFile(cwd, params.path, params.insert_line, params.new_str);
		default:
			throw new Error(`Unsupported command: ${String(params.command)}`);
	}
}

export function registerStrReplaceEditor(pi: ExtensionApi): void {
	const descriptions = STR_REPLACE_EDITOR_WIRE_TOOL.function.parameters.properties;
	const parameters = pi.zod.object({
		command: pi.zod.enum(["view", "create", "str_replace", "insert"])
			.describe(descriptions.command.description),
		path: pi.zod.string().describe(descriptions.path.description),
		file_text: pi.zod.string().optional().describe(descriptions.file_text.description),
		insert_line: pi.zod.number().int().optional().describe(descriptions.insert_line.description),
		new_str: pi.zod.string().optional().describe(descriptions.new_str.description),
		old_str: pi.zod.string().optional().describe(descriptions.old_str.description),
		view_range: pi.zod.array(pi.zod.number().int()).optional().describe(descriptions.view_range.description),
	});

	pi.registerTool({
		name: STR_REPLACE_EDITOR_NAME,
		label: "String Replace Editor",
		description: STR_REPLACE_EDITOR_DESCRIPTION,
		parameters,
		loadMode: "essential",
		defaultInactive: true,
		approval: "write",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return {
				content: [{ type: "text", text: maybeTruncate(await executeEditor(params, ctx.cwd)) }],
			};
		},
	});
}
