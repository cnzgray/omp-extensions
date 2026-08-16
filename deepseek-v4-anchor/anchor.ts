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

export const DEV_TOOL_SEARCH_NAME = "dev_tool_search";
export const BOOTSTRAP_TOOL_NAMES = ["bash", "str_replace_editor"] as const;
export const RESIDENT_TOOL_NAMES = [...BOOTSTRAP_TOOL_NAMES, DEV_TOOL_SEARCH_NAME] as const;
export const COMPACTION_TOOL_NAMES = [
	...BOOTSTRAP_TOOL_NAMES,
	"read",
	"write",
	"edit",
	"glob",
	"grep",
	"todo",
	"ask",
] as const;

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

export interface AnchorSnapshot {
	phase: AnchorPhase;
	postCompaction: boolean;
	unlockedTools: string[];
}

type JsonObject = Record<string, unknown>;

const OPENAI_RESPONSES_APIS: Record<string, true> = {
	"openai-responses": true,
	"openai-response": true,
	"azure-openai-responses": true,
	"openai-codex-responses": true,
};

const RESIDENT_SYSTEM_GUIDANCE = [
	"The visible tool catalog is intentionally small.",
	`Use ${DEV_TOOL_SEARCH_NAME} to discover and unlock additional OMP tools; unlocked tools appear on the next model request.`,
	"The harness and workspace instructions below remain authoritative.",
].join(" ");

function cloneSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return structuredClone(schema);
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

export function deriveAnchorState(entries: readonly SessionEntryLike[]): AnchorSnapshot {
	let phase: AnchorPhase | undefined;
	let postCompaction = false;
	const unlockedTools = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ANCHOR_STATE_ENTRY || !isRecord(entry.data)) continue;
		if (entry.data.kind === "tool-unlock" && Array.isArray(entry.data.toolNames)) {
			for (const name of entry.data.toolNames) {
				if (typeof name === "string" && name.length > 0) unlockedTools.add(name);
			}
		}
		if (entry.data.phase === "eligible") {
			phase = "eligible";
			postCompaction = entry.data.reason === "compaction";
		} else if (entry.data.phase === "promoted") {
			phase = "promoted";
			postCompaction = false;
		}
	}

	phase ??= entries.some((entry) => entry.type === "message" && entry.message?.role === "assistant")
		? "ineligible"
		: "eligible";
	return { phase, postCompaction, unlockedTools: [...unlockedTools] };
}

export function isOpenAIResponsesRequest(api: string | undefined, payload: unknown): boolean {
	if (typeof api === "string") return api in OPENAI_RESPONSES_APIS;
	return isRecord(payload) && Array.isArray(payload.input) && !Array.isArray(payload.messages);
}

function responseToolName(tool: unknown): string | undefined {
	return isRecord(tool) && typeof tool.name === "string" ? tool.name : undefined;
}

export function payloadHasBootstrapExecutors(payload: unknown): boolean {
	if (!isRecord(payload) || !Array.isArray(payload.tools)) return false;
	const names = new Set(payload.tools.map(responseToolName).filter((name): name is string => !!name));
	return names.has("bash") && names.has("str_replace_editor");
}

function bootstrapWireTool(name: "bash" | "str_replace_editor"): JsonObject {
	const tool = name === "bash" ? BASH_WIRE_TOOL : STR_REPLACE_EDITOR_WIRE_TOOL;
	return {
		type: "function",
		name: tool.function.name,
		description: tool.function.description,
		parameters: cloneSchema(tool.function.parameters as Record<string, unknown>),
	};
}

function promptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function currentResponsePrompt(payload: JsonObject): string {
	const parts: string[] = [];
	if (typeof payload.instructions === "string") parts.push(payload.instructions);
	if (Array.isArray(payload.input)) {
		for (const item of payload.input) {
			if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) continue;
			const text = promptText(item.content);
			if (text.length > 0) parts.push(text);
		}
	}
	return [...new Set(parts)].join("\n\n");
}

function writeResponsePrompt(payload: JsonObject, text: string): void {
	const input = Array.isArray(payload.input) ? payload.input : [];
	let promptRole: "system" | "developer" | undefined;
	const kept = input.filter((item) => {
		if (!isRecord(item) || (item.role !== "system" && item.role !== "developer")) return true;
		promptRole ??= item.role;
		return false;
	});
	if (promptRole) {
		payload.input = [{ role: promptRole, content: text }, ...kept];
		delete payload.instructions;
	} else {
		payload.input = kept;
		payload.instructions = text;
	}
}

function dropUnsupportedForcedToolChoice(payload: JsonObject, allowedNames: ReadonlySet<string>): void {
	const choice = payload.tool_choice;
	if (!isRecord(choice)) return;
	const name =
		typeof choice.name === "string"
			? choice.name
			: isRecord(choice.function) && typeof choice.function.name === "string"
				? choice.function.name
				: undefined;
	if (name && !allowedNames.has(name)) delete payload.tool_choice;
}

function rewriteResponseTools(payload: JsonObject, toolNames: readonly string[]): boolean {
	if (!Array.isArray(payload.tools)) return false;
	const available = new Map<string, unknown>();
	for (const tool of payload.tools) {
		const name = responseToolName(tool);
		if (name) available.set(name, tool);
	}
	if (!available.has("bash") || !available.has("str_replace_editor")) return false;

	const orderedNames = [...new Set(toolNames)];
	payload.tools = orderedNames.flatMap((name) => {
		if (name === "bash" || name === "str_replace_editor") return [bootstrapWireTool(name)];
		const tool = available.get(name);
		return tool === undefined ? [] : [tool];
	});
	dropUnsupportedForcedToolChoice(payload, new Set(orderedNames));
	return true;
}

export function promotedSystemPrompt(originalPrompt: string): string {
	let remainder = originalPrompt.trim();
	if (remainder.startsWith(MINIMAL_SYSTEM_PROMPT)) remainder = remainder.slice(MINIMAL_SYSTEM_PROMPT.length).trim();
	if (remainder.startsWith(RESIDENT_SYSTEM_GUIDANCE)) remainder = remainder.slice(RESIDENT_SYSTEM_GUIDANCE.length).trim();
	return [MINIMAL_SYSTEM_PROMPT, RESIDENT_SYSTEM_GUIDANCE, remainder].filter(Boolean).join("\n\n");
}

export function rewriteControlledPayload(payload: unknown, toolNames: readonly string[] = BOOTSTRAP_TOOL_NAMES): boolean {
	if (!isRecord(payload) || !rewriteResponseTools(payload, toolNames)) return false;
	writeResponsePrompt(payload, MINIMAL_SYSTEM_PROMPT);
	return true;
}

export function rewritePromotedPayload(payload: unknown, toolNames: readonly string[]): boolean {
	if (!isRecord(payload)) return false;
	const originalPrompt = currentResponsePrompt(payload);
	if (!rewriteResponseTools(payload, toolNames)) return false;
	writeResponsePrompt(payload, promotedSystemPrompt(originalPrompt));
	return true;
}
