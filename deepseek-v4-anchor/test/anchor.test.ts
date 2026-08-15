import { describe, expect, it } from "vitest";

import {
	ANCHOR_STATE_ENTRY,
	BASH_DESCRIPTION,
	deriveAnchorPhase,
	isDeepSeekV4Pro,
	MINIMAL_SYSTEM_PROMPT,
	payloadHasBootstrapExecutors,
	resolveProtocol,
	rewriteAnchoredPayload,
} from "../anchor";
import { STR_REPLACE_EDITOR_DESCRIPTION } from "../str-replace-editor";

const extraFunctionTool = {
	type: "function",
	function: { name: "read", description: "read", parameters: { type: "object", properties: {} } },
};
const bootstrapFunctionTools = [
	{ type: "function", function: { name: "bash", description: "old bash", parameters: {} } },
	{ type: "function", function: { name: "str_replace_editor", description: "old editor", parameters: {} } },
	extraFunctionTool,
];

function toolNames(payload: { tools: Array<Record<string, unknown>> }, nested: boolean): string[] {
	return payload.tools.map((tool) => {
		if (!nested) return String(tool.name);
		const fn = tool.function as Record<string, unknown>;
		return String(fn.name);
	});
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

describe("durable phase reconstruction", () => {
	it("anchors a session with no assistant history", () => {
		expect(deriveAnchorPhase([{ type: "message", message: { role: "user" } }])).toBe("eligible");
	});

	it("does not retroactively anchor an existing conversation", () => {
		expect(deriveAnchorPhase([{ type: "message", message: { role: "assistant" } }])).toBe("ineligible");
	});

	it("uses the latest durable marker", () => {
		const entries = [
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { phase: "promoted" } },
			{ type: "custom", customType: ANCHOR_STATE_ENTRY, data: { phase: "eligible" } },
		];
		expect(deriveAnchorPhase(entries)).toBe("eligible");
	});
});

describe("provider payload anchoring", () => {
	it("rewrites OpenAI Responses in place", () => {
		const payload = {
			model: "deepseek-v4-pro",
			instructions: "full OMP prompt",
			input: [{ role: "user", content: "fix it" }],
			tools: [
				{ type: "function", name: "bash", description: "normal bash", parameters: {} },
				{ type: "function", name: "str_replace_editor", description: "editor", parameters: {} },
				{ type: "function", name: "read", description: "read", parameters: {} },
			],
			tool_choice: { type: "function", name: "read" },
		};
		const original = payload;
		expect(resolveProtocol("openai-responses", payload)).toBe("openai-responses");
		expect(payloadHasBootstrapExecutors(payload, "openai-responses")).toBe(true);
		expect(rewriteAnchoredPayload(payload, "openai-responses")).toBe(true);
		expect(payload).toBe(original);
		expect(payload.instructions).toBe(MINIMAL_SYSTEM_PROMPT);
		expect(payload.input).toEqual([{ role: "user", content: "fix it" }]);
		expect(toolNames(payload, false)).toEqual(["bash", "str_replace_editor"]);
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
			tools: [
				{ type: "function", name: "bash" },
				{ type: "function", name: "str_replace_editor" },
			],
		};
		rewriteAnchoredPayload(payload, "openai-responses");
		expect(payload.input[0]).toEqual({ role: "developer", content: MINIMAL_SYSTEM_PROMPT });
		expect(payload).not.toHaveProperty("instructions");
	});

	it("rewrites Anthropic system blocks and tool schemas", () => {
		const payload = {
			model: "deepseek-v4-pro",
			messages: [{ role: "user", content: "fix it" }],
			system: [{ type: "text", text: "full OMP prompt" }],
			tools: [
				{ name: "bash", description: "old", input_schema: {} },
				{ name: "str_replace_editor", description: "old", input_schema: {} },
				{ name: "read", description: "old", input_schema: {} },
			],
		};
		expect(resolveProtocol("anthropic-messages", payload)).toBe("anthropic-messages");
		expect(payloadHasBootstrapExecutors(payload, "anthropic-messages")).toBe(true);
		rewriteAnchoredPayload(payload, "anthropic-messages");
		expect(payload.system).toEqual([{ type: "text", text: MINIMAL_SYSTEM_PROMPT }]);
		expect(toolNames(payload, false)).toEqual(["bash", "str_replace_editor"]);
		expect(payload.tools[0].input_schema).toMatchObject({ type: "object", required: ["command"] });
	});

	it("rewrites Chat Completions synchronously on the original object", () => {
		const payload = {
			model: "deepseek-v4-pro",
			messages: [
				{ role: "system", content: "base" },
				{ role: "developer", content: "plugin addition" },
				{ role: "user", content: "fix it" },
			],
			tools: structuredClone(bootstrapFunctionTools),
		};
		expect(resolveProtocol("openai-completions", payload)).toBe("openai-completions");
		expect(payloadHasBootstrapExecutors(payload, "openai-completions")).toBe(true);
		rewriteAnchoredPayload(payload, "openai-completions");
		expect(payload.messages).toEqual([
			{ role: "developer", content: MINIMAL_SYSTEM_PROMPT },
			{ role: "user", content: "fix it" },
		]);
		expect(toolNames(payload, true)).toEqual(["bash", "str_replace_editor"]);
	});
});
