import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import claudeRulesBridge, {
	discoverRules,
	rules,
	scanSubdirClaudeMds,
	subClaudeMds,
	type ExtensionContext,
} from "../index";
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
	apiDir = join(tmp, "packages", "api");
	mkdirSync(apiDir, { recursive: true });
	writeFileSync(join(apiDir, "CLAUDE.md"), "API package rules.\n");
	rules.length = 0;
	rules.push(...(await discoverRules(tmp)));
	subClaudeMds.length = 0;
	const sub: typeof subClaudeMds = [];
	await scanSubdirClaudeMds(tmp, sub);
	subClaudeMds.push(...sub);

	harness = createFakePi();
	claudeRulesBridge(harness.pi);
	ctx = harness.makeCtx({ cwd: tmp });
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("tool_result injection (via fake pi)", () => {
	it("appends matched rules to the first touch of a matching file", async () => {
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
});
