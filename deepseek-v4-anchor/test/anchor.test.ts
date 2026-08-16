import { describe, expect, it } from "vitest";

import {
	ANCHOR_STATE_ENTRY,
	BOOTSTRAP_TOOL_NAMES,
	BASH_DESCRIPTION,
	COMPACTION_TOOL_NAMES,
	DEV_TOOL_SEARCH_NAME,
	deriveAnchorState,
	isDeepSeekV4Pro,
	isOpenAIResponsesRequest,
	MINIMAL_SYSTEM_PROMPT,
	payloadHasBootstrapExecutors,
	RESIDENT_TOOL_NAMES,
	rewriteControlledPayload,
	rewritePromotedPayload,
} from "../anchor";
import { STR_REPLACE_EDITOR_DESCRIPTION } from "../str-replace-editor";

function responseTool(name: string, description = name) {
	return { type: "function", name, description, parameters: { type: "object", properties: {} } };
}

function toolNames(payload: { tools: Array<Record<string, unknown>> }): string[] {
	return payload.tools.map((tool) => String(tool.name));
}

describe("model matching", () => {
	it.each([
		"deepseek-v4-pro",
		"deepseek/deepseek-v4-pro",
		"deepseek-ai/DeepSeek-V4-Pro",
		"deepseek-v4-pro-0813",
		"deepseek-v4-pro:preview",
	])("matches %s", (id) => {
		expect(isDeepSeekV4Pro({ id })).toBe(true);
	});

	it("rejects Flash and older DeepSeek models", () => {
		expect(isDeepSeekV4Pro({ id: "deepseek-v4-flash" })).toBe(false);
		expect(isDeepSeekV4Pro({ id: "deepseek-r1" })).toBe(false);
	});
});

describe("durable anchor reconstruction", () => {
	it("anchors a session with no assistant history", () => {
		expect(deriveAnchorState([{ type: "message", message: { role: "user" } }])).toEqual({
			phase: "eligible",
			postCompaction: false,
			unlockedTools: [],
		});
	});

	it("does not retroactively anchor an existing conversation", () => {
		expect(deriveAnchorState([{ type: "message", message: { role: "assistant" } }]).phase).toBe("ineligible");
	});

	it("restores the latest phase, compaction boundary, and durable unlocks", () => {
		const entries = [
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { phase: "promoted" } },
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { kind: "tool-unlock", toolNames: ["web_search"] } },
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { phase: "eligible", reason: "compaction" } },
		];
		expect(deriveAnchorState(entries)).toEqual({
			phase: "eligible",
			postCompaction: true,
			unlockedTools: ["web_search"],
		});
	});
});

describe("OpenAI Responses payload control", () => {
	it("rewrites the bootstrap request in place", () => {
		const payload = {
			model: "deepseek-v4-pro",
			instructions: "full OMP prompt",
			input: [{ role: "user", content: "fix it" }],
			tools: [responseTool("bash", "normal bash"), responseTool("read"), responseTool("str_replace_editor")],
			tool_choice: { type: "function", name: "read" },
		};
		const original = payload;
		expect(isOpenAIResponsesRequest("openai-responses", payload)).toBe(true);
		expect(payloadHasBootstrapExecutors(payload)).toBe(true);
		expect(rewriteControlledPayload(payload)).toBe(true);
		expect(payload).toBe(original);
		expect(payload.instructions).toBe(MINIMAL_SYSTEM_PROMPT);
		expect(payload.input).toEqual([{ role: "user", content: "fix it" }]);
		expect(toolNames(payload)).toEqual(BOOTSTRAP_TOOL_NAMES);
		expect(payload.tools[0].description).toBe(BASH_DESCRIPTION);
		expect(payload.tools[1].description).toBe(STR_REPLACE_EDITOR_DESCRIPTION);
		expect(payload).not.toHaveProperty("tool_choice");
	});

	it("preserves a Responses developer-role transport", () => {
		const payload = {
			input: [
				{ role: "developer", content: "full OMP prompt" },
				{ role: "user", content: "fix it" },
			],
			tools: [responseTool("bash"), responseTool("str_replace_editor")],
		};
		rewriteControlledPayload(payload);
		expect(payload.input[0]).toEqual({ role: "developer", content: MINIMAL_SYSTEM_PROMPT });
		expect(payload).not.toHaveProperty("instructions");
	});

	it("keeps a persona-first prompt and the resident catalog after promotion", () => {
		const payload = {
			instructions: "normal OMP prompt",
			input: [{ role: "user", content: "continue" }],
			tools: [
				responseTool("read"),
				responseTool("bash", "normal bash"),
				responseTool(DEV_TOOL_SEARCH_NAME),
				responseTool("web_search"),
				responseTool("str_replace_editor", "normal editor"),
			],
		};
		expect(rewritePromotedPayload(payload, [...RESIDENT_TOOL_NAMES, "web_search"])).toBe(true);
		expect(payload.instructions.startsWith(MINIMAL_SYSTEM_PROMPT)).toBe(true);
		expect(payload.instructions).toContain("normal OMP prompt");
		expect(toolNames(payload)).toEqual([...RESIDENT_TOOL_NAMES, "web_search"]);
		expect(payload.tools[0].description).toBe(BASH_DESCRIPTION);
		expect(payload.tools[1].description).toBe(STR_REPLACE_EDITOR_DESCRIPTION);
	});

	it("uses the controlled core catalog after compaction", () => {
		const payload = {
			instructions: "normal OMP prompt",
			input: [{ role: "user", content: "continue" }],
			tools: COMPACTION_TOOL_NAMES.map((name) => responseTool(name)),
		};
		expect(rewriteControlledPayload(payload, COMPACTION_TOOL_NAMES)).toBe(true);
		expect(payload.instructions).toBe(MINIMAL_SYSTEM_PROMPT);
		expect(toolNames(payload)).toEqual(COMPACTION_TOOL_NAMES);
	});

	it("rejects non-Responses transports as behavioral anchors", () => {
		expect(isOpenAIResponsesRequest("anthropic-messages", { messages: [] })).toBe(false);
		expect(isOpenAIResponsesRequest("openai-completions", { messages: [] })).toBe(false);
		expect(isOpenAIResponsesRequest(undefined, { input: [] })).toBe(true);
	});
});
