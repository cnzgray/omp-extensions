import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import claudeRulesBridge, {
	buildDynamicBlock,
	discoverRules,
	findClaudeMdsUpward,
	hierClaudeMds,
	matchForPath,
	rules,
	systemPromptMdPaths,
} from "../index";
import { createFakePi } from "./helpers/fake-pi";

let tmp: string;
let apiDir: string;

beforeEach(async () => {
	tmp = mkdtempSync(join(tmpdir(), "claude-rules-bridge-"));
	const rulesDir = join(tmp, ".claude", "rules");
	mkdirSync(rulesDir, { recursive: true });
	writeFileSync(join(rulesDir, "ts.md"), "---\nglobs: [\"**/*.ts\"]\n---\nUse TS rules.\n");
	writeFileSync(join(tmp, "CLAUDE.md"), "Root project memory.\n");
	apiDir = join(tmp, "packages", "api");
	mkdirSync(apiDir, { recursive: true });
	writeFileSync(join(apiDir, "CLAUDE.md"), "API package rules.\n");
	// ESM import bindings are read-only: mutate in place instead of reassigning
	rules.length = 0;
	rules.push(...(await discoverRules(tmp)));
	const mds = await findClaudeMdsUpward(tmp);
	hierClaudeMds.length = 0;
	hierClaudeMds.push(...mds);
	systemPromptMdPaths.clear();
	for (const m of mds) systemPromptMdPaths.add(m.filePath);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("discovery", () => {
	it("discovers the scoped rule and the cwd→home CLAUDE.md", () => {
		expect(rules).toHaveLength(1);
		expect(rules[0].name).toBe("ts");
		expect(rules[0].globs).toEqual(["**/*.ts"]);
		expect(hierClaudeMds).toHaveLength(1);
		expect(hierClaudeMds[0].name).toBe(tmp);
		expect(hierClaudeMds[0].filePath).toBe(join(tmp, "CLAUDE.md"));
	});
});

describe("matchForPath", () => {
	it("matches rule globs and walks up to the api dir's CLAUDE.md (not in system prompt)", async () => {
		const hit = await matchForPath(join(apiDir, "index.ts"), tmp);
		expect(hit).toHaveLength(2);
		expect(hit.map((m) => m.kind)).toEqual(["rule", "subclaude"]);
		expect(hit.find((m) => m.kind === "subclaude")?.filePath).toBe(join(apiDir, "CLAUDE.md"));
	});

	it("does not match files outside the scopes", async () => {
		expect(await matchForPath(join(tmp, "README.md"), tmp)).toHaveLength(0);
	});

	it("does not re-inject a CLAUDE.md already in the system-prompt layer", async () => {
		// README.md matches nothing; upward walk hits tmp/CLAUDE.md which IS in
		// systemPromptMdPaths → skipped → empty.
		expect(await matchForPath(join(tmp, "README.md"), tmp)).toHaveLength(0);
		expect(systemPromptMdPaths.has(join(tmp, "CLAUDE.md"))).toBe(true);
	});
});

describe("buildDynamicBlock", () => {
	it("carries both matched rule bodies", async () => {
		const hit = await matchForPath(join(apiDir, "index.ts"), tmp);
		const built = buildDynamicBlock(hit, "packages/api/index.ts");
		expect(built).not.toBeNull();
		expect(built!.block).toContain("Use TS rules.");
		expect(built!.block).toContain("API package rules.");
		expect(built!.included).toHaveLength(2);
	});
});

describe("load notify", () => {
	it("toasts loaded counts on session_start (no status bar)", async () => {
		const harness = createFakePi();
		claudeRulesBridge(harness.pi);
		const ctx = harness.makeCtx({ cwd: tmp });
		await harness.emit("session_start", { type: "session_start" }, ctx);
		expect(harness.notifications).toContainEqual({
			message: "[claude-rules] loaded: 1 rules, 1 CLAUDE.md",
			level: "info",
		});
	});

	it("dedupes the loaded toast across same-cwd reloads (session_compact)", async () => {
		const harness = createFakePi();
		claudeRulesBridge(harness.pi);
		const ctx = harness.makeCtx({ cwd: tmp });
		await harness.emit("session_start", { type: "session_start" }, ctx);
		const firstCount = harness.notifications.length;
		await harness.emit("session_compact", { type: "session_compact" }, ctx);
		expect(harness.notifications.length).toBe(firstCount); // same cwd → no repeat toast
	});

	it("still toasts when nothing is loaded", async () => {
		const empty = mkdtempSync(join(tmpdir(), "claude-rules-empty-"));
		try {
			const harness = createFakePi();
			claudeRulesBridge(harness.pi);
			const ctx = harness.makeCtx({ cwd: empty });
			await harness.emit("session_start", { type: "session_start" }, ctx);
			expect(harness.notifications).toContainEqual({
				message: "[claude-rules] loaded: 0 rules, 0 CLAUDE.md",
				level: "info",
			});
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});
});