import { isRecord } from "./guards";
import {
	ANCHOR_STATE_ENTRY,
	type AnchorPhase,
	BOOTSTRAP_TOOL_NAMES,
	COMPACTION_TOOL_NAMES,
	DEV_TOOL_SEARCH_NAME,
	deriveAnchorState,
	isDeepSeekV4Pro,
	isOpenAIResponsesRequest,
	payloadHasBootstrapExecutors,
	RESIDENT_TOOL_NAMES,
	rewriteControlledPayload,
	rewritePromotedPayload,
	type SessionEntryLike,
} from "./anchor";
import {
	type EditorExtensionApi,
	type EditorToolDefinition,
	registerStrReplaceEditor,
	STR_REPLACE_EDITOR_NAME,
} from "./str-replace-editor";

interface ModelLike {
	id?: string;
	requestModelId?: string;
	name?: string;
	api?: string;
}

interface SessionManagerLike {
	getSessionId?: () => string | null;
	getSessionFile?: () => string | undefined;
	getBranch?: () => SessionEntryLike[];
	getEntries?: () => SessionEntryLike[];
}

export interface ExtensionContext {
	cwd: string;
	model?: ModelLike;
	sessionManager: SessionManagerLike;
	ui?: {
		notify?: (message: string, level: "info" | "warning" | "error") => void;
	};
}

interface ToolInfoLike {
	name: string;
	description: string;
}

interface DiscoveryToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	loadMode: "essential";
	defaultInactive: boolean;
	approval: "read";
	execute(
		toolCallId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

export interface ExtensionApi extends Omit<EditorExtensionApi, "registerTool"> {
	logger: { warn: (message: string, details?: unknown) => void };
	setLabel: (label: string) => void;
	registerTool: (definition: EditorToolDefinition | DiscoveryToolDefinition) => void;
	appendEntry: (customType: string, data?: unknown) => void;
	getActiveTools: () => string[];
	getAllTools: () => ToolInfoLike[];
	setActiveTools: (toolNames: string[]) => Promise<void>;
	on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
}

interface RuntimeState {
	phase: AnchorPhase;
	postCompaction: boolean;
	unlockedTools: Set<string>;
	requestObserved: boolean;
	lastWireTools: Set<string>;
	anchorNotified: boolean;
	protocolWarned: boolean;
	payloadWarned: boolean;
}

const FALLBACK_SESSION_KEY = "<active-session>";
const MAX_DISCOVERY_RESULTS = 25;

function entriesFor(ctx: ExtensionContext): SessionEntryLike[] {
	return ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
}

function sessionKey(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getSessionId?.();
	if (id) return id;
	return ctx.sessionManager.getSessionFile?.() || FALLBACK_SESSION_KEY;
}

function allowedToolNames(state: RuntimeState): string[] {
	if (state.phase === "promoted") return [...RESIDENT_TOOL_NAMES, ...state.unlockedTools];
	if (state.phase === "eligible" && state.postCompaction) return [...COMPACTION_TOOL_NAMES];
	return state.phase === "eligible" ? [...BOOTSTRAP_TOOL_NAMES] : [];
}

export default function deepSeekV4Anchor(pi: ExtensionApi): void {
	pi.setLabel("DeepSeek V4 Anchor");
	registerStrReplaceEditor(pi);

	const states = new Map<string, RuntimeState>();

	const adoptSession = (ctx: ExtensionContext): RuntimeState => {
		const restored = deriveAnchorState(entriesFor(ctx));
		const state: RuntimeState = {
			phase: restored.phase,
			postCompaction: restored.postCompaction,
			unlockedTools: new Set(restored.unlockedTools),
			requestObserved: false,
			lastWireTools: new Set(),
			anchorNotified: false,
			protocolWarned: false,
			payloadWarned: false,
		};
		states.set(sessionKey(ctx), state);
		return state;
	};

	const stateFor = (ctx: ExtensionContext): RuntimeState => states.get(sessionKey(ctx)) ?? adoptSession(ctx);

	const activateTools = async (toolNames: readonly string[]): Promise<void> => {
		const current = pi.getActiveTools();
		const next = [...current];
		for (const name of toolNames) {
			if (!next.includes(name)) next.push(name);
		}
		if (next.length !== current.length) await pi.setActiveTools(next);
	};

	const syncExtensionTools = async (target: boolean, state: RuntimeState): Promise<void> => {
		const current = pi.getActiveTools();
		const customToolsEnabled = target && state.phase !== "ineligible";
		const next = current.filter(
			(name) => customToolsEnabled || (name !== STR_REPLACE_EDITOR_NAME && name !== DEV_TOOL_SEARCH_NAME),
		);
		if (customToolsEnabled) {
			for (const name of [STR_REPLACE_EDITOR_NAME, DEV_TOOL_SEARCH_NAME, ...state.unlockedTools]) {
				if (!next.includes(name)) next.push(name);
			}
		}
		if (next.length === current.length && next.every((name, index) => name === current[index])) return;
		await pi.setActiveTools(next);
	};

	const persistPhase = (phase: "eligible" | "promoted", reason: "assistant-message" | "compaction"): void => {
		pi.appendEntry(ANCHOR_STATE_ENTRY, { phase, reason, timestamp: Date.now() });
	};

	const persistUnlock = (toolNames: readonly string[]): void => {
		pi.appendEntry(ANCHOR_STATE_ENTRY, { kind: "tool-unlock", toolNames: [...toolNames], timestamp: Date.now() });
	};

	const discoveryTool: DiscoveryToolDefinition = {
		name: DEV_TOOL_SEARCH_NAME,
		label: "Tool Search",
		description: [
			"Discover and unlock OMP tools that are not in the resident catalog.",
			"Search by capability, then pass exact toolNames to expose them on the next model request.",
			"Common examples: read loads files and skill:// resources; write invokes xd:// devices; web_search retrieves internet sources; task delegates work.",
		].join(" "),
		parameters: pi.zod.object({
			query: pi.zod.string().optional().describe("Capability keywords, for example web, subagent, or image."),
			toolNames: pi.zod.array(pi.zod.string()).optional().describe("Exact configured tool names to unlock."),
		}),
		loadMode: "essential",
		defaultInactive: true,
		approval: "read",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			if (!isDeepSeekV4Pro(ctx.model) || state.phase !== "promoted") {
				return {
					content: [{ type: "text", text: "Tool discovery is available only in a promoted DeepSeek V4 Pro session." }],
					isError: true,
				};
			}

			const allTools = pi.getAllTools().filter((tool) => tool.name !== DEV_TOOL_SEARCH_NAME);
			const availableByName = new Map(allTools.map((tool) => [tool.name, tool]));
			const input = isRecord(params) ? params : {};
			const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
			const requested = Array.isArray(input.toolNames)
				? [...new Set(input.toolNames.filter((name): name is string => typeof name === "string" && name.length > 0))]
				: [];
			const unknown = requested.filter((name) => !availableByName.has(name));
			const newlyUnlocked = requested.filter(
				(name) =>
					availableByName.has(name) &&
					!RESIDENT_TOOL_NAMES.some((residentName) => residentName === name) &&
					!state.unlockedTools.has(name),
			);
			if (newlyUnlocked.length > 0) {
				await activateTools(newlyUnlocked);
				for (const name of newlyUnlocked) state.unlockedTools.add(name);
				persistUnlock(newlyUnlocked);
			}

			const lines: string[] = [];
			if (newlyUnlocked.length > 0) lines.push(`Unlocked for the next request: ${newlyUnlocked.join(", ")}`);
			if (unknown.length > 0) lines.push(`Unknown tool names: ${unknown.join(", ")}`);
			if (query.length > 0) {
				const tokens = query.split(/[^a-z0-9_]+/).filter(Boolean);
				const hiddenNames = new Set(allowedToolNames(state));
				const matches = allTools
					.filter((tool) => !hiddenNames.has(tool.name))
					.filter((tool) => {
						const haystack = `${tool.name} ${tool.description}`.toLowerCase();
						return tokens.every((token) => haystack.includes(token));
					})
					.slice(0, MAX_DISCOVERY_RESULTS);
				if (matches.length === 0) {
					lines.push(`No tools match "${query}".`);
				} else {
					lines.push(`Matching tools (${matches.length}):`);
					for (const tool of matches) lines.push(`- ${tool.name}: ${tool.description.split("\n")[0].slice(0, 120)}`);
					lines.push(`Unlock with ${DEV_TOOL_SEARCH_NAME}({"toolNames":["<exact name>"]}).`);
				}
			}
			if (lines.length === 0) lines.push("Provide query to search or toolNames to unlock configured tools.");
			return { content: [{ type: "text", text: lines.join("\n") }] };
		},
	};
	pi.registerTool(discoveryTool);

	for (const eventName of ["session_start", "session_switch", "session_branch", "session_tree"]) {
		pi.on(eventName, (_event, ctx) => {
			adoptSession(ctx);
		});
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = stateFor(ctx);
		state.requestObserved = false;
		state.lastWireTools.clear();
		if (state.phase === "eligible") state.anchorNotified = false;
		const target = isDeepSeekV4Pro(ctx.model);
		const supported = ctx.model?.api === undefined || isOpenAIResponsesRequest(ctx.model.api, undefined);
		await syncExtensionTools(target && supported, state);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isRecord(event) || !("payload" in event)) return;
		const payload = event.payload;
		const state = stateFor(ctx);
		state.lastWireTools.clear();
		if (!isDeepSeekV4Pro(ctx.model) || state.phase === "ineligible") return;
		if (!isOpenAIResponsesRequest(ctx.model?.api, payload)) {
			if (!state.protocolWarned) {
				state.protocolWarned = true;
				pi.logger.warn("deepseek-v4-anchor: behavioral anchoring requires the OpenAI Responses protocol; request left unchanged", {
					api: ctx.model?.api,
				});
			}
			return;
		}
		if (!payloadHasBootstrapExecutors(payload)) {
			if (!state.payloadWarned) {
				state.payloadWarned = true;
				pi.logger.warn("deepseek-v4-anchor: request was not rewritten because the provider payload did not expose bash and str_replace_editor");
			}
			return;
		}

		const toolNames = allowedToolNames(state);
		try {
			const rewritten =
				state.phase === "promoted"
					? rewritePromotedPayload(payload, toolNames)
					: rewriteControlledPayload(payload, toolNames);
			if (!rewritten) return;
			state.lastWireTools = new Set(toolNames);
			if (state.phase === "eligible") {
				state.requestObserved = true;
				if (!state.anchorNotified) {
					state.anchorNotified = true;
					ctx.ui?.notify?.(
						state.postCompaction ? "DeepSeek V4 controlled compaction request applied" : "DeepSeek V4 anchor applied (openai-responses)",
						"info",
					);
				}
			}
			return payload;
		} catch (error) {
			pi.logger.warn("deepseek-v4-anchor: provider payload rewrite failed; keeping the normal OMP request", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (!isRecord(event) || typeof event.toolName !== "string") return;
		const state = stateFor(ctx);
		if (!isDeepSeekV4Pro(ctx.model) || state.lastWireTools.size === 0 || state.lastWireTools.has(event.toolName)) return;
		return { block: true, reason: `DeepSeek V4 controlled catalog does not expose ${event.toolName}. Use ${DEV_TOOL_SEARCH_NAME} after promotion.` };
	});

	pi.on("message_end", (event, ctx) => {
		if (!isRecord(event) || !isRecord(event.message) || event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted" || event.message.stopReason === "error") return;
		const state = stateFor(ctx);
		if (state.phase !== "eligible" || !state.requestObserved) return;
		state.phase = "promoted";
		state.postCompaction = false;
		state.requestObserved = false;
		persistPhase("promoted", "assistant-message");
		ctx.ui?.notify?.("DeepSeek V4 anchor promoted — resident tools active", "info");
	});

	const resetAfterCompaction = (ctx: ExtensionContext): void => {
		const state = stateFor(ctx);
		if (state.phase === "eligible" && state.postCompaction && !state.requestObserved) return;
		state.phase = "eligible";
		state.postCompaction = true;
		state.requestObserved = false;
		state.lastWireTools.clear();
		state.anchorNotified = false;
		persistPhase("eligible", "compaction");
		ctx.ui?.notify?.("DeepSeek V4 controlled epoch armed after compaction", "info");
	};

	pi.on("session_compact", (_event, ctx) => {
		resetAfterCompaction(ctx);
	});
	pi.on("auto_compaction_end", (event, ctx) => {
		if (!isRecord(event) || event.aborted === true || event.skipped === true) return;
		resetAfterCompaction(ctx);
	});
}
