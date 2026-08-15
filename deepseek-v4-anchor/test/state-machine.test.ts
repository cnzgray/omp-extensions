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

import { ANCHOR_STATE_ENTRY, MINIMAL_SYSTEM_PROMPT } from "../anchor";
import deepSeekV4Anchor, { type ExtensionApi, type ExtensionContext } from "../index";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface TestEntry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role: string };
}


function createHarness(initialEntries: TestEntry[] = []) {
	const handlers = new Map<string, Handler[]>();
	const entries = [...initialEntries];
	const warnings: string[] = [];
	let activeTools = ["bash", "read"];
	const pi: ExtensionApi = {
		// Test double boundary: the editor module is mocked, so the schema builder
		// is never exercised — an empty object satisfies the structural contract.
		zod: {} as ExtensionApi["zod"],
		logger: { warn: (message: string) => warnings.push(message) },
		setLabel: vi.fn(),
		registerTool: vi.fn(),
		appendEntry(customType: string, data?: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools: () => [...activeTools],
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

function responsesPayload() {
	return {
		model: "deepseek-v4-pro",
		instructions: "normal OMP prompt",
		input: [{ role: "user", content: "fix it" }],
		tools: [
			{ type: "function", name: "bash", description: "normal bash", parameters: {} },
			{ type: "function", name: "read", description: "read", parameters: {} },
			{ type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
		],
	};
}

describe("extension state machine", () => {
	beforeEach(() => vi.clearAllMocks());

	it("anchors request #1, promotes durably, and leaves request #2 untouched", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: ["normal"] });
		expect(harness.activeTools()).toContain("str_replace_editor");

		const first = responsesPayload();
		const returned = await harness.emit("before_provider_request", { type: "before_provider_request", payload: first });
		expect(returned).toBe(first);
		expect(first.instructions).toBe(MINIMAL_SYSTEM_PROMPT);
		expect(first.tools.map((tool) => tool.name)).toEqual(["bash", "str_replace_editor"]);
		expect(harness.ctx.ui?.notify).toHaveBeenCalledWith(
			expect.stringContaining("anchor applied"),
			"info",
		);

		await harness.emit("message_end", { type: "message_end", message: { role: "assistant" } });
		expect(entriesWithType(harness.entries, ANCHOR_STATE_ENTRY).at(-1)?.data).toMatchObject({ phase: "promoted" });
		expect(harness.ctx.ui?.notify).toHaveBeenCalledWith(
			expect.stringContaining("promoted"),
			"info",
		);

		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: ["normal"] });
		const second = responsesPayload();
		expect(await harness.emit("before_provider_request", { type: "before_provider_request", payload: second })).toBeUndefined();
		expect(second.instructions).toBe("normal OMP prompt");
		expect(second.tools).toHaveLength(3);
	});

	it("does not anchor an existing conversation", async () => {
		const harness = createHarness([{ type: "message", message: { role: "assistant" } }]);
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: ["normal"] });
		const payload = responsesPayload();
		await harness.emit("before_provider_request", { type: "before_provider_request", payload });
		expect(payload.instructions).toBe("normal OMP prompt");
	});

	it("starts a new anchor epoch after successful compaction", async () => {
		const harness = createHarness([
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { phase: "promoted" } },
		]);
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("session_compact", { type: "session_compact" });
		expect(harness.ctx.ui?.notify).toHaveBeenCalledWith(
			expect.stringContaining("re-armed"),
			"info",
		);
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: ["normal"] });
		const payload = responsesPayload();
		await harness.emit("before_provider_request", { type: "before_provider_request", payload });
		expect(payload.instructions).toBe(MINIMAL_SYSTEM_PROMPT);
		expect(entriesWithType(harness.entries, ANCHOR_STATE_ENTRY).at(-1)?.data).toMatchObject({ phase: "eligible" });
	});

	it("does not reset on aborted auto compaction", async () => {
		const harness = createHarness([
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { phase: "promoted" } },
		]);
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("auto_compaction_end", { type: "auto_compaction_end", aborted: true });
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: ["normal"] });
		const payload = responsesPayload();
		await harness.emit("before_provider_request", { type: "before_provider_request", payload });
		expect(payload.instructions).toBe("normal OMP prompt");
	});

	it("deactivates the editor when the selected model is not V4 Pro", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { type: "session_start" });
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: ["normal"] });
		harness.ctx.model = { id: "claude-sonnet-4-6", api: "anthropic-messages" };
		await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: ["normal"] });
		expect(harness.activeTools()).not.toContain("str_replace_editor");
	});
});

function entriesWithType(entries: TestEntry[], customType: string): TestEntry[] {
	return entries.filter((entry) => entry.type === "custom" && entry.customType === customType);
}
