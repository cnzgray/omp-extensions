import { isRecord } from "./guards";
import { STR_REPLACE_EDITOR_WIRE_TOOL } from "./str-replace-editor";

export const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

export const BASH_DESCRIPTION = [
	"Run commands in a bash shell",
	"* When invoking this tool, the contents of the \"command\" parameter does NOT need to be XML-escaped.",
	"* You don't have access to the internet via this tool.",
	"* You do have access to a mirror of common linux and python packages via apt and pip.",
	"* State is persistent across command calls and discussions with the user.",
	"* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
	"* Please avoid commands that may produce a very large amount of output.",
	"* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.",
].join("\n");

export const BASH_WIRE_TOOL = {
	type: "function",
	function: {
		name: "bash",
		description: BASH_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "The bash command to run. Relative path is preferred in the command.",
				},
			},
			required: ["command"],
		},
	},
} as const;

export const ANCHOR_STATE_ENTRY = "deepseek-v4-anchor-state";

export type AnchorPhase = "eligible" | "promoted" | "ineligible";
export type SupportedProtocol = "openai-responses" | "anthropic-messages" | "openai-completions";

export interface ModelIdentity {
	id?: string;
	requestModelId?: string;
	name?: string;
	api?: string;
}

export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string };
}

interface WireFunctionTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

type JsonObject = Record<string, unknown>;

const ANCHOR_TOOL_NAMES: Record<string, true> = {
	bash: true,
	str_replace_editor: true,
};

function cloneSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(schema);
}

function wireFunctionTools(): WireFunctionTool[] {
	return [BASH_WIRE_TOOL, STR_REPLACE_EDITOR_WIRE_TOOL].map((tool) => ({
		type: "function",
		function: {
			name: tool.function.name,
			description: tool.function.description,
			parameters: cloneSchema(tool.function.parameters as Record<string, unknown>),
		},
	}));
}

function modelCandidate(value: string): string {
	const bare = value.slice(value.lastIndexOf("/") + 1).toLowerCase();
	return bare.replace(/[ _]+/g, "-");
}

export function isDeepSeekV4Pro(model: ModelIdentity | undefined): boolean {
	if (!model) return false;
	for (const value of [model.requestModelId, model.id]) {
		if (typeof value === "string" && /^deepseek-v4-pro(?:$|[-:])/.test(modelCandidate(value))) return true;
	}
	if (typeof model.name !== "string") return false;
	return /^deepseek-v4-pro(?:$|[-:])/.test(modelCandidate(model.name));
}

export function deriveAnchorPhase(entries: readonly SessionEntryLike[]): AnchorPhase {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== ANCHOR_STATE_ENTRY || !isRecord(entry.data)) continue;
		if (entry.data.phase === "eligible") return "eligible";
		if (entry.data.phase === "promoted") return "promoted";
	}
	return entries.some((entry) => entry.type === "message" && entry.message?.role === "assistant")
		? "ineligible"
		: "eligible";
}

export function resolveProtocol(api: string | undefined, payload: unknown): SupportedProtocol | undefined {
	if (
		api === "openai-responses" ||
		api === "openai-response" ||
		api === "azure-openai-responses" ||
		api === "openai-codex-responses"
	) {
		return "openai-responses";
	}
	if (api === "anthropic-messages" || api === "anthropic") return "anthropic-messages";
	if (api === "openai-completions") return "openai-completions";
	if (!isRecord(payload)) return undefined;
	// OpenRouter can dispatch either Responses or Chat Completions; the final
	// provider payload is authoritative when the catalog API is ambiguous.
	if (Array.isArray(payload.input)) return "openai-responses";
	if (Object.hasOwn(payload, "system") && Array.isArray(payload.messages)) return "anthropic-messages";
	if (Array.isArray(payload.messages)) return "openai-completions";
	return undefined;
}

function toolName(tool: unknown, protocol: SupportedProtocol): string | undefined {
	if (!isRecord(tool)) return undefined;
	if (protocol === "openai-completions") {
		return isRecord(tool.function) && typeof tool.function.name === "string" ? tool.function.name : undefined;
	}
	return typeof tool.name === "string" ? tool.name : undefined;
}

export function payloadHasBootstrapExecutors(payload: unknown, protocol: SupportedProtocol): boolean {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return false;
	const names = new Set(payload.tools.map((tool) => toolName(tool, protocol)).filter((name): name is string => !!name));
	return names.has("bash") && names.has("str_replace_editor");
}

function dropUnsupportedForcedToolChoice(payload: JsonObject): void {
	const choice = payload.tool_choice;
	if (!isRecord(choice)) return;
	const name =
		typeof choice.name === "string"
			? choice.name
			: isRecord(choice.function) && typeof choice.function.name === "string"
				? choice.function.name
				: undefined;
	if (name && !ANCHOR_TOOL_NAMES[name]) delete payload.tool_choice;
}

function rewriteOpenAIResponses(payload: JsonObject, tools: WireFunctionTool[]): void {
	const input = Array.isArray(payload.input) ? payload.input : [];
	let promptRole: "system" | "developer" | undefined;
	const kept = input.filter((item) => {
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) return true;
		promptRole ??= item.role;
		return false;
	});
	if (promptRole) {
		payload.input = [{ role: promptRole, content: MINIMAL_SYSTEM_PROMPT }, ...kept];
		delete payload.instructions;
	} else {
		payload.input = kept;
		payload.instructions = MINIMAL_SYSTEM_PROMPT;
	}
	payload.tools = tools.map((tool) => ({
		type: "function",
		name: tool.function.name,
		description: tool.function.description,
		parameters: cloneSchema(tool.function.parameters),
	}));
}

function rewriteAnthropic(payload: JsonObject, tools: WireFunctionTool[]): void {
	payload.system = [{ type: "text", text: MINIMAL_SYSTEM_PROMPT }];
	payload.tools = tools.map((tool) => ({
		name: tool.function.name,
		description: tool.function.description,
		input_schema: cloneSchema(tool.function.parameters),
		eager_input_streaming: true,
	}));
}

function rewriteOpenAICompletions(payload: JsonObject, tools: WireFunctionTool[]): void {
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	let promptRole: "system" | "developer" = "system";
	const kept = messages.filter((message) => {
		if (!isRecord(message) || (message.role !== "system" && message.role !== "developer")) return true;
		promptRole = message.role;
		return false;
	});
	payload.messages = [{ role: promptRole, content: MINIMAL_SYSTEM_PROMPT }, ...kept];
	payload.tools = tools;
}

/**
 * Rewrites the provider-owned request object in place. This is intentional:
 * OMP 17.3.x openai-completions observes onPayload synchronously but ignores a
 * replacement return value, while Responses and Anthropic accept both styles.
 */
export function rewriteAnchoredPayload(payload: unknown, protocol: SupportedProtocol): boolean {
	if (!isRecord(payload)) return false;
	const tools = wireFunctionTools();
	if (protocol === "openai-responses") rewriteOpenAIResponses(payload, tools);
	else if (protocol === "anthropic-messages") rewriteAnthropic(payload, tools);
	else rewriteOpenAICompletions(payload, tools);
	dropUnsupportedForcedToolChoice(payload);
	return true;
}
