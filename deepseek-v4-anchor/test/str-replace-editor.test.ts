import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	type EditorExtensionApi,
	registerStrReplaceEditor,
	STR_REPLACE_EDITOR_DESCRIPTION,
	STR_REPLACE_EDITOR_NAME,
	STR_REPLACE_EDITOR_WIRE_TOOL,
} from "../str-replace-editor";

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

interface CapturedTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	loadMode: string;
	defaultInactive: boolean;
	approval: string;
	execute(
		toolCallId: string,
		params: EditorParams,
		signal: unknown,
		onUpdate: unknown,
		ctx: { cwd: string },
	): Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface FakeSchema {
	describe(description: string): FakeSchema;
	int(): FakeSchema;
	optional(): FakeSchema;
}

const EXPECTED_DESCRIPTION = [
	"Custom editing tool for viewing, creating and editing files",
	"* State is persistent across command calls and discussions with the user",
	"* If `path` is a file, `view` displays the result of applying `cat -n`. If `path` is a directory, `view` lists non-hidden files and directories up to 2 levels deep",
	"* The `create` command cannot be used if the specified `path` already exists as a file",
	"* If a `command` generates a long output, it will be truncated and marked with `<response clipped>`",
	"",
	"Notes for using the `str_replace` command:",
	"* The `old_str` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!",
	"* If the `old_str` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in `old_str` to make it unique",
	"* The `new_str` parameter should contain the edited lines that should replace the `old_str`",
].join("\n");
const CLIPPED_MARKER = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";
const roots: string[] = [];

function fakeSchema(): FakeSchema {
	const schema: FakeSchema = {
		describe: () => schema,
		int: () => schema,
		optional: () => schema,
	};
	return schema;
}

function captureEditor(): CapturedTool {
	let captured: CapturedTool | undefined;
	const pi: EditorExtensionApi = {
		zod: {
			array: (_element: unknown) => fakeSchema(),
			enum: (_values: readonly string[]) => fakeSchema(),
			number: () => fakeSchema(),
			object: (_shape: Record<string, unknown>) => fakeSchema(),
			string: () => fakeSchema(),
		},
		registerTool(definition) {
			// Test double boundary: keep a structural snapshot of the registered definition.
			captured = definition as unknown as CapturedTool;
		},
	};
	registerStrReplaceEditor(pi);
	if (!captured) throw new Error("str_replace_editor was not registered");
	return captured;
}

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "deepseek-v4-anchor-editor-"));
	roots.push(root);
	return root;
}

async function execute(cwd: string, params: EditorParams): Promise<string> {
	const result = await captureEditor().execute("test-call", params, undefined, undefined, { cwd });
	if (result.content.length !== 1 || result.content[0]?.type !== "text") {
		throw new Error("str_replace_editor returned an invalid result");
	}
	return result.content[0].text;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("str_replace_editor protocol", () => {
	it("pins the Minimal preset name, description, and ordered JSON Schema", () => {
		expect(STR_REPLACE_EDITOR_NAME).toBe("str_replace_editor");
		expect(STR_REPLACE_EDITOR_DESCRIPTION).toBe(EXPECTED_DESCRIPTION);
		expect(Object.keys(STR_REPLACE_EDITOR_WIRE_TOOL)).toEqual(["type", "function"]);
		expect(Object.keys(STR_REPLACE_EDITOR_WIRE_TOOL.function)).toEqual([
			"name",
			"description",
			"parameters",
		]);
		expect(STR_REPLACE_EDITOR_WIRE_TOOL).not.toHaveProperty("strict");
		expect(STR_REPLACE_EDITOR_WIRE_TOOL.function).not.toHaveProperty("strict");
		expect(STR_REPLACE_EDITOR_WIRE_TOOL.type).toBe("function");
		expect(STR_REPLACE_EDITOR_WIRE_TOOL.function.name).toBe(STR_REPLACE_EDITOR_NAME);
		expect(STR_REPLACE_EDITOR_WIRE_TOOL.function.description).toBe(EXPECTED_DESCRIPTION);

		const parameters = STR_REPLACE_EDITOR_WIRE_TOOL.function.parameters;
		expect(parameters.type).toBe("object");
		expect(Object.keys(parameters.properties)).toEqual([
			"command",
			"path",
			"file_text",
			"insert_line",
			"new_str",
			"old_str",
			"view_range",
		]);
		expect(parameters.required).toEqual(["command", "path"]);
		expect(parameters.properties.command.enum).toEqual(["view", "create", "str_replace", "insert"]);
		expect(parameters.properties.insert_line.type).toBe("integer");
		expect(parameters.properties.view_range.items).toEqual({ type: "integer" });
	});

	it("registers the required OMP metadata", () => {
		const tool = captureEditor();
		expect(tool).toMatchObject({
			name: "str_replace_editor",
			label: "String Replace Editor",
			description: EXPECTED_DESCRIPTION,
			loadMode: "essential",
			defaultInactive: true,
			approval: "write",
		});
		expect(tool).not.toHaveProperty("strict");
	});
});

describe("str_replace_editor filesystem behavior", () => {
	it("resolves relative and absolute paths inside cwd and rejects both escape forms", async () => {
		const container = await makeRoot();
		const cwd = join(container, "workspace");
		const inside = join(cwd, "inside.txt");
		const outside = join(container, "outside.txt");
		await mkdir(cwd);
		await writeFile(inside, "inside", "utf8");
		await writeFile(outside, "outside", "utf8");

		expect(await execute(cwd, { command: "view", path: "inside.txt" })).toContain("     1  inside");
		expect(await execute(cwd, { command: "view", path: inside })).toContain("     1  inside");
		await expect(execute(cwd, { command: "view", path: "../outside.txt" }))
			.rejects.toThrow("outside the working directory");
		await expect(execute(cwd, { command: "view", path: outside }))
			.rejects.toThrow("outside the working directory");
	});

	it("views files with canonical cat -n style line numbers", async () => {
		const cwd = await makeRoot();
		const path = join(cwd, "lines.txt");
		await writeFile(path, "one\ntwo\nthree", "utf8");

		expect(await execute(cwd, { command: "view", path: "lines.txt" })).toBe([
			`Here's the content of ${path} with line numbers (which has a total of 3 lines):`,
			"     1  one",
			"     2  two",
			"     3  three",
			"",
		].join("\n"));
		expect(await execute(cwd, { command: "view", path: "lines.txt", view_range: [2, -1] })).toBe([
			`Here's the content of ${path} with line numbers (which has a total of 3 lines) with view_range=[2, -1]:`,
			"     2  two",
			"     3  three",
			"",
		].join("\n"));
	});

	it("creates a file once and refuses to overwrite it", async () => {
		const cwd = await makeRoot();
		const path = join(cwd, "created.txt");
		expect(await execute(cwd, {
			command: "create",
			path: "created.txt",
			file_text: "first",
		})).toBe(`New file created successfully at: ${path}`);
		expect(await readFile(path, "utf8")).toBe("first");

		await expect(execute(cwd, {
			command: "create",
			path,
			file_text: "second",
		})).rejects.toThrow("Cannot overwrite files using command `create`");
		expect(await readFile(path, "utf8")).toBe("first");
	});

	it("performs one literal replacement and permits deletion", async () => {
		const cwd = await makeRoot();
		const path = join(cwd, "unique.txt");
		await writeFile(path, "before OLD after", "utf8");

		expect(await execute(cwd, {
			command: "str_replace",
			path: "unique.txt",
			old_str: "OLD",
			new_str: "$&|$`|$'|$$",
		})).toBe(`The file ${path} has been edited successfully.`);
		expect(await readFile(path, "utf8")).toBe("before $&|$`|$'|$$ after");
		await execute(cwd, {
			command: "str_replace",
			path,
			old_str: " after",
		});
		expect(await readFile(path, "utf8")).toBe("before $&|$`|$'|$$");
	});

	it("rejects an empty or non-unique old_str without changing the file", async () => {
		const cwd = await makeRoot();
		const path = join(cwd, "ambiguous.txt");
		await writeFile(path, "same\nother\nsame", "utf8");

		await expect(execute(cwd, {
			command: "str_replace",
			path,
			old_str: "same",
			new_str: "changed",
		})).rejects.toThrow("Multiple occurrences of old_str `same` in lines [1, 3]");
		await expect(execute(cwd, {
			command: "str_replace",
			path,
			old_str: "",
			new_str: "changed",
		})).rejects.toThrow("Parameter `old_str` is empty");
		expect(await readFile(path, "utf8")).toBe("same\nother\nsame");
	});

	it("inserts after 1-based lines, treats zero as the file head, and rejects out-of-range lines", async () => {
		const cwd = await makeRoot();
		const path = join(cwd, "insert.txt");
		await writeFile(path, "one\ntwo", "utf8");

		await execute(cwd, { command: "insert", path, insert_line: 0, new_str: "head" });
		expect(await readFile(path, "utf8")).toBe("head\none\ntwo");
		await execute(cwd, { command: "insert", path, insert_line: 2, new_str: "middle" });
		expect(await readFile(path, "utf8")).toBe("head\none\nmiddle\ntwo");
		await execute(cwd, { command: "insert", path, insert_line: 4, new_str: "tail" });
		expect(await readFile(path, "utf8")).toBe("head\none\nmiddle\ntwo\ntail");
		await expect(execute(cwd, { command: "insert", path, insert_line: -1, new_str: "bad" }))
			.rejects.toThrow("Invalid `insert_line` parameter");
		await expect(execute(cwd, { command: "insert", path, insert_line: 99, new_str: "bad" }))
			.rejects.toThrow("Invalid `insert_line` parameter");
	});

	it("lists visible directory entries only through depth two", async () => {
		const cwd = await makeRoot();
		const tree = join(cwd, "tree");
		await mkdir(join(tree, "nested", "third"), { recursive: true });
		await mkdir(join(tree, "node_modules", "package"), { recursive: true });
		await writeFile(join(tree, "visible.txt"), "visible", "utf8");
		await writeFile(join(tree, ".hidden.txt"), "hidden", "utf8");
		await writeFile(join(tree, "nested", "child.txt"), "child", "utf8");
		await writeFile(join(tree, "nested", ".hidden-child.txt"), "hidden", "utf8");
		await writeFile(join(tree, "nested", "third", "too-deep.txt"), "deep", "utf8");
		await writeFile(join(tree, "node_modules", "package", "index.js"), "dependency", "utf8");

		const output = await execute(cwd, { command: "view", path: "tree" });
		expect(output).toContain(`d\t${tree}`);
		expect(output).toContain(`f\t${join(tree, "visible.txt")}`);
		expect(output).toContain(`f\t${join(tree, "nested", "child.txt")}`);
		expect(output).not.toContain(".hidden.txt");
		expect(output).not.toContain(".hidden-child.txt");
		expect(output).not.toContain("too-deep.txt");
		expect(output).not.toContain(join(tree, "node_modules"));
	});

	it("clips long output to 16000 characters with the upstream marker", async () => {
		const cwd = await makeRoot();
		await writeFile(join(cwd, "large.txt"), "x".repeat(20_000), "utf8");

		const output = await execute(cwd, { command: "view", path: "large.txt" });
		expect(output).toHaveLength(16_000);
		expect(output.endsWith(CLIPPED_MARKER)).toBe(true);
	});
});
