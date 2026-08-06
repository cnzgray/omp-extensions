// Fake ExtensionAPI harness for unit-testing claude-rules-bridge without a
// running omp session. Pattern mirrors pi-rules' test/helpers/fake-pi.ts:
//   - registrations (on/registerTool/registerCommand) are captured, not executed
//   - emit() dispatches to all handlers for an event, chaining results
//     (a handler's return value becomes the next handler's event input,
//     mirroring the omp runner's merge semantics)
//   - makeCtx() builds a stub ExtensionContext; ui.notify records into the
//     harness, ui.setStatus records into a Map (last-write-wins per name)

import type { ExtensionApi, ExtensionContext } from "../../index";

export interface CapturedHandler {
	event: string;
	handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
}

export interface CapturedTool {
	definition: { name: string; description: string };
}

export interface CapturedCommand {
	name: string;
	options: { description?: string };
}

export interface CapturedNotification {
	message: string;
	level: string;
}

export interface CapturedStatus {
	name: string;
	text: string;
}

export interface FakePiHarness {
	pi: ExtensionApi;
	handlers: CapturedHandler[];
	tools: CapturedTool[];
	commands: CapturedCommand[];
	notifications: CapturedNotification[];
	/** Last text pushed to each named status line. */
	status: Map<string, string>;
	/** Dispatch an event to all registered handlers (Promise-aware, chained). */
	emit(eventName: string, event: unknown, ctx: ExtensionContext): Promise<unknown>;
	/** Build a stub ExtensionContext; ui methods record into the harness. */
	makeCtx(overrides?: Partial<ExtensionContext>): ExtensionContext;
}

export function createFakePi(): FakePiHarness {
	const handlers: CapturedHandler[] = [];
	const tools: CapturedTool[] = [];
	const commands: CapturedCommand[] = [];
	const notifications: CapturedNotification[] = [];
	const status = new Map<string, string>();

	const on = ((event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) => {
		handlers.push({ event, handler });
	}) as ExtensionApi["on"];

	const pi: ExtensionApi = {
		setLabel: () => {},
		zod: {
			object: () => ({}),
			string: () => ({ optional: () => ({}) }),
		} as unknown as ExtensionApi["zod"],
		on,
		registerTool: (def) => {
			tools.push({ definition: { name: def.name, description: def.description } });
		},
		registerCommand: (name, options) => {
			commands.push({ name, options: { description: options.description } });
		},
	};

	return {
		pi,
		handlers,
		tools,
		commands,
		notifications,
		status,
		async emit(eventName, event, ctx) {
			let current = event;
			for (const h of handlers) {
				if (h.event !== eventName) continue;
				const result = await h.handler(current, ctx);
				if (result !== undefined) current = result;
			}
			return current;
		},
		makeCtx(overrides = {}) {
			return {
				cwd: process.cwd(),
				ui: {
					notify: (message: string, level: string) => {
						notifications.push({ message, level });
					},
					setStatus: (name: string, text: string) => {
						if (text === "") status.delete(name);
						else status.set(name, text);
					},
				},
				...overrides,
			};
		},
	};
}