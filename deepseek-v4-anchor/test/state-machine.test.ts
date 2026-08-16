import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../str-replace-editor", () => ({
	STR_REPLACE_EDITOR_NAME: "str_replace_editor",
	STR_REPLACE_EDITOR_DESCRIPTION: "editor description",
	STR_REPLACE_EDITOR_WIRE_TOOL: {
		type: "function",
		function: {
			name: "str_replace_editor",
			description: "editor description",
			parameters: {
				type: "object",
				properties: { command: { type: "string" }, path: { type: "string" } },
				required: ["command", "path"],
			},
		},
	},
	registerStrReplaceEditor: vi.fn(),
}));

import {
	ANCHOR_STATE_ENTRY,
	BOOTSTRAP_TOOL_NAMES,
	COMPACTION_TOOL_NAMES,
	DEV_TOOL_SEARCH_NAME,
	MINIMAL_SYSTEM_PROMPT,
	RESIDENT_TOOL_NAMES,
} from "../anchor";
import deepSeekV4Anchor, { type ExtensionApi, type ExtensionContext } from "../index";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface TestEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role: string };
}

interface CapturedTool {
	name: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: string; text: string }> }>;
}

function fakeSchema() {
	const schema = {
		describe: () => schema,
		int: () => schema,
		optional: () => schema,
	};
	return schema;
}

function responseTool(name: string) {
	return { type: "function", name, description: name, parameters: { type: "object", properties: {} } };
}

const configuredToolNames = [
	"bash",
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"todo",
	"ask",
	"web_search",
	"subagent",
	"str_replace_editor",
	DEV_TOOL_SEARCH_NAME,
];

function createHarness(initialEntries: TestEntry[] = []) {
	const handlers = new Map<string, Handler[]>();
	const registeredTools = new Map<string, CapturedTool>();
	const entries = [...initialEntries];
	const warnings: string[] = [];
	let activeTools = ["bash", "read"];
	const pi: ExtensionApi = {
		zod: {
			array: () => fakeSchema(),
			enum: () => fakeSchema(),
			number: () => fakeSchema(),
			object: () => fakeSchema(),
			string: () => fakeSchema(),
		} as ExtensionApi["zod"],
		logger: { warn: (message: string) => warnings.push(message) },
		setLabel: vi.fn(),
		registerTool(definition) {
			const tool = definition as unknown as CapturedTool;
			registeredTools.set(tool.name, tool);
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools: () => [...activeTools],
		getAllTools: () => configuredToolNames.map((name) => ({ name, description: `${name} capability` })),
		async setActiveTools(toolNames: string[]) {
			activeTools = [...toolNames];
		},
		on(event: string, handler: Handler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	};
	const ctx: ExtensionContext = {
		cwd: "/workspace",
		model: { id: "deepseek-v4-pro", api: "openai-responses" },
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => entries,
		},
		ui: { notify: vi.fn() },
	};
	deepSeekV4Anchor(pi);
	return {
		ctx,
		entries,
		warnings,
		activeTools: () => activeTools,
		tool(name: string) {
			const tool = registeredTools.get(name);
			if (!tool) throw new Error(`Tool not registered: ${name}`);
			return tool;
		},
		async emit(eventName: string, event: unknown) {
			let result: unknown;
			for (const handler of handlers.get(eventName) ?? []) {
				const next = await handler(event, ctx);
				if (next !== undefined) result = next;
			}
			return result;
		},
	};
}

interface ResponsesPayload {
	model: string;
	instructions: string;
	input: Array<{ role: string; content: string }>;
	tools: Array<{ type: string; name: string; description: string; parameters: Record<string, unknown> }>;
}

function responsesPayload(): ResponsesPayload {
	return {
		model: "deepseek-v4-pro",
		instructions: "normal OMP prompt",
		input: [{ role: "user", content: "fix it" }],
		tools: configuredToolNames.map(responseTool),
	};
}

function names(payload: ResponsesPayload): string[] {
	return payload.tools.map((tool) => tool.name);
}

describe("extension state machine", () => {
	beforeEach(() => vi.clearAllMocks());

	it("anchors request #1 and uses the resident catalog from request #2", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("before_agent_start", { type: "before_agent_start" });
		expect(harness.activeTools()).toEqual(expect.arrayContaining(["str_replace_editor", DEV_TOOL_SEARCH_NAME]));

		const first = responsesPayload();
		expect(await harness.emit("before_provider_request", { type: "before_provider_request", payload: first })).toBe(first);
		expect(first.instructions).toBe(MINIMAL_SYSTEM_PROMPT);
		expect(names(first)).toEqual(BOOTSTRAP_TOOL_NAMES);

		await harness.emit("message_end", { type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
		expect(entriesWithType(harness.entries, ANCHOR_STATE_ENTRY).at(-1)?.data).toMatchObject({ phase: "promoted" });

		const second = responsesPayload();
		expect(await harness.emit("before_provider_request", { type: "before_provider_request", payload: second })).toBe(second);
		expect(second.instructions.startsWith(MINIMAL_SYSTEM_PROMPT)).toBe(true);
		expect(second.instructions).toContain("normal OMP prompt");
		expect(names(second)).toEqual(RESIDENT_TOOL_NAMES);

		expect(await harness.emit("tool_call", { type: "tool_call", toolName: "web_search" })).toMatchObject({ block: true });
		expect(await harness.emit("tool_call", { type: "tool_call", toolName: DEV_TOOL_SEARCH_NAME })).toBeUndefined();
	});

	it("unlocks tools durably through dev_tool_search", async () => {
		const harness = createHarness([
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { phase: "promoted" } },
		]);
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("before_agent_start", { type: "before_agent_start" });
		const result = await harness.tool(DEV_TOOL_SEARCH_NAME).execute(
			"tool-call",
			{ query: "web", toolNames: ["web_search"] },
			undefined,
			undefined,
			harness.ctx,
		);
		expect(result.content[0]?.text).toContain("Unlocked for the next request: web_search");
		expect(harness.activeTools()).toContain("web_search");
		expect(entriesWithType(harness.entries, ANCHOR_STATE_ENTRY).at(-1)?.data).toMatchObject({
			kind: "tool-unlock",
			toolNames: ["web_search"],
		});

		await harness.emit("session_switch", { type: "session_switch" });
		await harness.emit("before_agent_start", { type: "before_agent_start" });
		const payload = responsesPayload();
		await harness.emit("before_provider_request", { type: "before_provider_request", payload });
		expect(names(payload)).toEqual([...RESIDENT_TOOL_NAMES, "web_search"]);
	});

	it("does not retrofit an existing conversation", async () => {
		const harness = createHarness([{ type: "message", message: { role: "assistant" } }]);
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("before_agent_start", { type: "before_agent_start" });
		const payload = responsesPayload();
		await harness.emit("before_provider_request", { type: "before_provider_request", payload });
		expect(payload.instructions).toBe("normal OMP prompt");
		expect(harness.activeTools()).not.toContain(DEV_TOOL_SEARCH_NAME);
	});

	it("uses a controlled core catalog after compaction, then returns to resident", async () => {
		const harness = createHarness([
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { phase: "promoted" } },
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { kind: "tool-unlock", toolNames: ["web_search"] } },
		]);
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("session_compact", { type: "session_compact" });
		await harness.emit("before_agent_start", { type: "before_agent_start" });
		const controlled = responsesPayload();
		await harness.emit("before_provider_request", { type: "before_provider_request", payload: controlled });
		expect(controlled.instructions).toBe(MINIMAL_SYSTEM_PROMPT);
		expect(names(controlled)).toEqual(COMPACTION_TOOL_NAMES);

		await harness.emit("message_end", { type: "message_end", message: { role: "assistant" } });
		const promoted = responsesPayload();
		await harness.emit("before_provider_request", { type: "before_provider_request", payload: promoted });
		expect(names(promoted)).toEqual([...RESIDENT_TOOL_NAMES, "web_search"]);
	});

	it("does not reset on aborted auto compaction", async () => {
		const harness = createHarness([
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { phase: "promoted" } },
		]);
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("auto_compaction_end", { type: "auto_compaction_end", aborted: true });
		await harness.emit("before_agent_start", { type: "before_agent_start" });
		const payload = responsesPayload();
		await harness.emit("before_provider_request", { type: "before_provider_request", payload });
		expect(names(payload)).toEqual(RESIDENT_TOOL_NAMES);
	});

	it("leaves unsupported provider protocols unchanged and warns once", async () => {
		const harness = createHarness();
		harness.ctx.model = { id: "deepseek-v4-pro", api: "anthropic-messages" };
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("before_agent_start", { type: "before_agent_start" });
		const payload = responsesPayload();
		await harness.emit("before_provider_request", { type: "before_provider_request", payload });
		expect(payload.instructions).toBe("normal OMP prompt");
		expect(harness.activeTools()).not.toContain("str_replace_editor");
		expect(harness.activeTools()).not.toContain(DEV_TOOL_SEARCH_NAME);
		expect(harness.warnings).toHaveLength(1);
	});

	it("deactivates extension tools when the selected model is not V4 Pro", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("before_agent_start", { type: "before_agent_start" });
		harness.ctx.model = { id: "claude-sonnet-4-6", api: "anthropic-messages" };
		await harness.emit("before_agent_start", { type: "before_agent_start" });
		expect(harness.activeTools()).not.toContain("str_replace_editor");
		expect(harness.activeTools()).not.toContain(DEV_TOOL_SEARCH_NAME);
	});
});

function entriesWithType(entries: TestEntry[], customType: string): TestEntry[] {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === customType);
}
