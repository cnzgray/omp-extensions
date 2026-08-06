import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import claudeRulesBridge, { type ExtensionContext, injectedKeys } from "../index";
import { createFakePi, type FakePiHarness } from "./helpers/fake-pi";

interface TextPart {
	type: string;
	text?: string;
}

interface ToolResultMutation {
	content: TextPart[];
}

function injectedText(result: unknown): string {
	const mutation = result as ToolResultMutation;
	expect(mutation.content.length).toBeGreaterThan(1);
	return mutation.content[1]?.text ?? "";
}

/** Handler returned undefined (no injection): emit returns the original event. */
function expectUnchanged(result: unknown, event: Record<string, unknown>): void {
	expect(result).toBe(event);
	expect((event.content as TextPart[])).toHaveLength(1);
}

function makeReadEvent(path: string, details?: Record<string, unknown>): Record<string, unknown> {
	return {
		toolName: "read",
		isError: false,
		input: { path },
		details,
		content: [{ type: "text", text: "the file" }],
	};
}

let tmp: string;
let apiDir: string;
let harness: FakePiHarness;
let ctx: ExtensionContext;

beforeEach(async () => {
	tmp = mkdtempSync(join(tmpdir(), "claude-rules-bridge-"));
	const rulesDir = join(tmp, ".claude", "rules");
	mkdirSync(rulesDir, { recursive: true });
	writeFileSync(join(rulesDir, "ts.md"), "---\nglobs: [\"**/*.ts\"]\n---\nUse TS rules.\n");
	writeFileSync(join(tmp, "CLAUDE.md"), "Root project memory.\n");
	apiDir = join(tmp, "packages", "api");
	mkdirSync(apiDir, { recursive: true });
	writeFileSync(join(apiDir, "CLAUDE.md"), "API package rules.\n");

	harness = createFakePi();
	claudeRulesBridge(harness.pi);
	ctx = harness.makeCtx({ cwd: tmp });
	// session_start drives reload(), which discovers rules + the cwd→home
	// CLAUDE.md hierarchy and seeds systemPromptMdPaths (used to dedupe the
	// dynamic layer against the system-prompt layer).
	await harness.emit("session_start", { type: "session_start" }, ctx);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("tool_result injection (via fake pi)", () => {
	it("appends matched rules + subdir CLAUDE.md to the first touch of a matching file", async () => {
		const result = await harness.emit(
			"tool_result",
			makeReadEvent("packages/api/index.ts:50-200", { resolvedPath: join(apiDir, "index.ts") }),
			ctx,
		);
		const text = injectedText(result);
		expect(text).toContain("Use TS rules.");
		expect(text).toContain("API package rules.");
	});

	it("dedupes repeated touches of the same file", async () => {
		const event = makeReadEvent("packages/api/index.ts:50-200", { resolvedPath: join(apiDir, "index.ts") });
		await harness.emit("tool_result", event, ctx);
		const second = await harness.emit("tool_result", event, ctx);
		expectUnchanged(second, event);
	});

	it("skips error results", async () => {
		const event = { ...makeReadEvent("packages/api/index.ts"), isError: true };
		const result = await harness.emit("tool_result", event, ctx);
		expectUnchanged(result, event);
	});

	it("cleans read selectors when details are missing", async () => {
		const result = await harness.emit(
			"tool_result",
			makeReadEvent("packages/api/index.ts:raw", undefined),
			ctx,
		);
		expect(injectedText(result)).toContain("Use TS rules.");
	});

	it("matches hashline-headed write paths (write has no details)", async () => {
		const result = await harness.emit("tool_result", {
			toolName: "write",
			isError: false,
			input: { path: "¶packages/api/index.ts#beef", content: "x" },
			details: undefined,
			content: [{ type: "text", text: "written" }],
		}, ctx);
		expect(injectedText(result)).toContain("Use TS rules.");
	});

	it("never treats internal URLs as file targets", async () => {
		const event = makeReadEvent("skill://some-skill", undefined);
		const result = await harness.emit("tool_result", event, ctx);
		expectUnchanged(result, event);
	});

	it("injects each rule body once for a multi-file edit event", async () => {
		const result = await harness.emit("tool_result", {
			toolName: "edit",
			isError: false,
			input: { paths: ["packages/api/index.ts", "packages/api/util.ts"] },
			details: undefined,
			content: [{ type: "text", text: "edited" }],
		}, ctx);
		const text = injectedText(result);
		expect(text.match(/Use TS rules\./g)).toHaveLength(1);
		expect(text.match(/API package rules\./g)).toHaveLength(1);
	});

	it("does not re-inject a CLAUDE.md already in the system-prompt layer (cwd's own)", async () => {
		// README.md matches no glob; upward walk reaches tmp/CLAUDE.md which
		// reload() placed in the system-prompt layer → skipped → no injection.
		const event = makeReadEvent("README.md", undefined);
		const result = await harness.emit("tool_result", event, ctx);
		expectUnchanged(result, event);
	});

	it("clears dedupe state on session_compact (reload resets injectedKeys)", async () => {
		const event = makeReadEvent("packages/api/index.ts:50-200", { resolvedPath: join(apiDir, "index.ts") });
		await harness.emit("tool_result", event, ctx);
		expect(injectedKeys.size).toBeGreaterThan(0);
		await harness.emit("session_compact", { type: "session_compact" }, ctx);
		expect(injectedKeys.size).toBe(0);
		// after reload, the same file can be injected again
		const second = await harness.emit("tool_result", event, ctx);
		expect(injectedText(second)).toContain("API package rules.");
	});

	it("toasts once per CLAUDE.md on first dynamic injection, not on sibling files", async () => {
		await harness.emit("tool_result", makeReadEvent("packages/api/index.ts", { resolvedPath: join(apiDir, "index.ts") }), ctx);
		expect(harness.notifications.some(n => n.message === `[claude-rules] injected: ${join(apiDir, "CLAUDE.md")}`)).toBe(true);
		// a different file under the same CLAUDE.md dir injects again (new target key) but does NOT re-toast
		const before = harness.notifications.length;
		await harness.emit("tool_result", makeReadEvent("packages/api/util.ts", { resolvedPath: join(apiDir, "util.ts") }), ctx);
		expect(harness.notifications.slice(before).some(n => n.message.startsWith("[claude-rules] injected:"))).toBe(false);
	});

	it("does not toast for path-scoped .claude/rules injections (only CLAUDE.md)", async () => {
		await harness.emit("tool_result", makeReadEvent("packages/api/index.ts", { resolvedPath: join(apiDir, "index.ts") }), ctx);
		// the only injected toast is the api CLAUDE.md; the ts.md rule injection must NOT toast
		expect(harness.notifications.filter(n => n.message.startsWith("[claude-rules] injected:"))).toHaveLength(1);
	});
});