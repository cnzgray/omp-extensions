import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import claudeRulesBridge, {
	buildDynamicBlock,
	discoverRules,
	matchForPath,
	rules,
	scanSubdirClaudeMds,
	subClaudeMds,
} from "../index";
import { createFakePi } from "./helpers/fake-pi";

let tmp: string;
let apiDir: string;

beforeEach(async () => {
	tmp = mkdtempSync(join(tmpdir(), "claude-rules-bridge-"));
	const rulesDir = join(tmp, ".claude", "rules");
	mkdirSync(rulesDir, { recursive: true });
	writeFileSync(join(rulesDir, "ts.md"), "---\nglobs: [\"**/*.ts\"]\n---\nUse TS rules.\n");
	apiDir = join(tmp, "packages", "api");
	mkdirSync(apiDir, { recursive: true });
	writeFileSync(join(apiDir, "CLAUDE.md"), "API package rules.\n");
	// ESM import bindings are read-only: mutate in place instead of reassigning
	rules.length = 0;
	rules.push(...(await discoverRules(tmp)));
	subClaudeMds.length = 0;
	const sub: typeof subClaudeMds = [];
	await scanSubdirClaudeMds(tmp, sub);
	subClaudeMds.push(...sub);
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("discovery", () => {
	it("discovers the scoped rule and the subdirectory CLAUDE.md", () => {
		expect(rules).toHaveLength(1);
		expect(rules[0].name).toBe("ts");
		expect(rules[0].globs).toEqual(["**/*.ts"]);
		expect(subClaudeMds).toHaveLength(1);
		expect(subClaudeMds[0].name).toBe(apiDir);
	});
});

describe("matchForPath", () => {
	it("matches rule globs and subdir CLAUDE.md scope for a file inside the api dir", () => {
		const hit = matchForPath(join(apiDir, "index.ts"), tmp);
		expect(hit).toHaveLength(2);
		expect(hit.map((m) => m.kind)).toEqual(["rule", "subclaude"]);
	});

	it("does not match files outside the scopes", () => {
		expect(matchForPath(join(tmp, "README.md"), tmp)).toHaveLength(0);
	});
});

describe("buildDynamicBlock", () => {
	it("carries both matched rule bodies", () => {
		const hit = matchForPath(join(apiDir, "index.ts"), tmp);
		const built = buildDynamicBlock(hit, "packages/api/index.ts");
		expect(built).not.toBeNull();
		expect(built!.block).toContain("Use TS rules.");
		expect(built!.block).toContain("API package rules.");
		expect(built!.included).toHaveLength(2);
	});
});

describe("session notification", () => {
	it("notifies rule counts after loading on session_start", async () => {
		const harness = createFakePi();
		claudeRulesBridge(harness.pi);
		const ctx = harness.makeCtx({ cwd: tmp });
		await harness.emit("session_start", { type: "session_start" }, ctx);
		expect(harness.notifications).toContainEqual({
			message: "[claude-rules] 1 rules, 1 subdir CLAUDE.md",
			level: "info",
		});
	});
});
