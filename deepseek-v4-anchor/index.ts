import { isRecord } from "./guards";
import {
	ANCHOR_STATE_ENTRY,
	type AnchorPhase,
	deriveAnchorPhase,
	isDeepSeekV4Pro,
	payloadHasBootstrapExecutors,
	resolveProtocol,
	rewriteAnchoredPayload,
	type SessionEntryLike,
} from "./anchor";
import {
	type EditorExtensionApi,
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

export interface ExtensionApi extends EditorExtensionApi {
	logger: { warn: (message: string, details?: unknown) => void };
	setLabel: (label: string) => void;
	appendEntry: (customType: string, data?: unknown) => void;
	getActiveTools: () => string[];
	setActiveTools: (toolNames: string[]) => Promise<void>;
	on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void;
}

interface RuntimeState {
	phase: AnchorPhase;
	armed: boolean;
	requestObserved: boolean;
	notified: boolean;
}

const FALLBACK_SESSION_KEY = "<active-session>";


function entriesFor(ctx: ExtensionContext): SessionEntryLike[] {
	return ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
}

function sessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.() ?? FALLBACK_SESSION_KEY;
}

export default function deepSeekV4Anchor(pi: ExtensionApi): void {
	pi.setLabel("DeepSeek V4 Anchor");
	registerStrReplaceEditor(pi);

	const states = new Map<string, RuntimeState>();

	const adoptSession = (ctx: ExtensionContext): RuntimeState => {
		const state: RuntimeState = {
			phase: deriveAnchorPhase(entriesFor(ctx)),
			armed: false,
			requestObserved: false,
			notified: false,
		};
		states.set(sessionKey(ctx), state);
		return state;
	};

	const stateFor = (ctx: ExtensionContext): RuntimeState => states.get(sessionKey(ctx)) ?? adoptSession(ctx);

	const setEditorActive = async (active: boolean): Promise<void> => {
		const current = pi.getActiveTools();
		const hasEditor = current.includes(STR_REPLACE_EDITOR_NAME);
		if (active === hasEditor) return;
		await pi.setActiveTools(
			active ? [...current, STR_REPLACE_EDITOR_NAME] : current.filter((name) => name !== STR_REPLACE_EDITOR_NAME),
		);
	};

	const persistPhase = (phase: "eligible" | "promoted", reason: "assistant-message" | "compaction"): void => {
		pi.appendEntry(ANCHOR_STATE_ENTRY, { phase, reason, timestamp: Date.now() });
	};

	for (const eventName of ["session_start", "session_switch", "session_branch", "session_tree"]) {
		pi.on(eventName, (_event, ctx) => {
			adoptSession(ctx);
		});
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = stateFor(ctx);
		const target = isDeepSeekV4Pro(ctx.model);
		state.armed = target && state.phase === "eligible";
		state.requestObserved = false;
		await setEditorActive(target);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isRecord(event) || !("payload" in event)) return;
		const payload = event.payload;
		const state = stateFor(ctx);
		if (!state.armed || state.phase !== "eligible" || !isDeepSeekV4Pro(ctx.model)) return;
		const protocol = resolveProtocol(ctx.model?.api, payload);
		if (!protocol || !payloadHasBootstrapExecutors(payload, protocol)) {
			if (!state.notified) {
				state.notified = true;
				pi.logger.warn("deepseek-v4-anchor: bootstrap request was not rewritten because the provider payload did not expose bash and str_replace_editor");
			}
			return;
		}
		try {
			if (!rewriteAnchoredPayload(payload, protocol)) return;
			state.requestObserved = true;
			if (!state.notified) {
				state.notified = true;
				ctx.ui?.notify?.(`DeepSeek V4 anchor applied (${protocol})`, "info");
			}
			// Return the same mutated object. Responses/Anthropic consume the return;
			// openai-completions 17.3.x ignores it but sends this same object reference.
			return payload;
		} catch (error) {
			pi.logger.warn("deepseek-v4-anchor: provider payload rewrite failed; keeping the normal OMP request", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!isRecord(event) || !isRecord(event.message) || event.message.role !== "assistant") return;
		const state = stateFor(ctx);
		if (state.phase !== "eligible" || !state.requestObserved) return;
		state.phase = "promoted";
		state.armed = false;
		state.requestObserved = false;
		persistPhase("promoted", "assistant-message");
		ctx.ui?.notify?.("DeepSeek V4 anchor promoted — OMP system prompt and tools restored", "info");
	});

	const resetAfterCompaction = (ctx: ExtensionContext): void => {
		const state = stateFor(ctx);
		if (state.phase === "eligible" && !state.requestObserved) return;
		state.phase = "eligible";
		state.armed = false;
		state.requestObserved = false;
		state.notified = false;
		persistPhase("eligible", "compaction");
		ctx.ui?.notify?.("DeepSeek V4 anchor re-armed after compaction", "info");
	};

	pi.on("session_compact", (_event, ctx) => {
		resetAfterCompaction(ctx);
	});
	pi.on("auto_compaction_end", (event, ctx) => {
		if (!isRecord(event) || event.aborted === true || event.skipped === true) return;
		resetAfterCompaction(ctx);
	});
}
