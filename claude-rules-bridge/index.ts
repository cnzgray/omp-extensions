// Claude Code .claude/rules/ bridge for omp.
//
// Discovers .claude/rules/*.md and *.mdc (Claude Code format) from cwd
// (walked up to home) and from ~/.claude/rules/, then injects matching
// rules into the provider request payload. Single source of truth for
// rule content — files under .claude/rules/ remain editable from either
// Claude Code or omp sessions.
//
// Why before_agent_start (not before_provider_request):
//   OMP's extensions runner consumes the systemPrompt return value and
//   applies it via agent.setSystemPrompt, which persists through the entire
//   agent loop. No subsequent rebuild overwrites it (verified in omp source).
//   (Same rationale as claude-auto-memory.ts in this directory.)
//
// Frontmatter fields read:
//   - paths | globs | applyTo  → file-match globs (merged)
//   - alwaysApply              → always inject regardless of cwd/files
//   - description              → metadata for /claude-rules listing
//
// Injection philosophy (pi-rules style dynamic injection — models don't
// reliably read xd:// devices on demand; omp itself keeps web_search etc.
// top-level for exactly this reason, issue #5973):
//   - alwaysApply rules → full content injected into the system prompt each
//     agent loop (unconditional rules, like omp's sticky RULES.md).
//   - Path-scoped rules + subdirectory CLAUDE.md → injected dynamically: on
//     every read/edit/write tool_result we extract the target file path,
//     match it against rule globs / directory scopes, and append matching
//     rule bodies to that tool's result. The rule arrives exactly when the
//     model touches a matching file — zero model initiative required.
//     (Same mechanism as the pi-rules extension: tool_result event.)
//   - The xd://claude_rules device stays as an on-demand index/reader for
//     anything the auto-match misses.
//
// Token cap: 12 KB for the alwaysApply block (aligned with pi-rules).
// Only dependency: picomatch vendored at vendor/picomatch (glob matching,
// same options as pi-rules). Vendored because marketplace installs don't run
// dependency installation; picomatch is zero-dep pure JS.
// Frontmatter stays hand-rolled to avoid a yaml dependency.

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import picomatch from "./vendor/picomatch/index.js";

const MAX_BYTES = 12_000;
const MAX_RULE_BYTES = 6_000; // ponytail: per-rule ceiling so one giant file can't dominate

interface Rule {
	name: string;
	filePath: string;
	body: string;
	globs: string[];
	alwaysApply: boolean;
	description: string;
}

export interface ExtensionContext {
	cwd: string;
	ui: { notify(msg: string, level: string): void };
}

export interface ExtensionApi {
	setLabel(label: string): void;
	zod: {
		object: (shape: Record<string, unknown>) => unknown;
		string: () => { optional: () => unknown };
	};
	on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
	on(event: "session_switch" | "session_branch" | "session_tree" | "session_compact", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
	on(
		event: "before_agent_start",
		handler: (
			event: { type: "before_agent_start"; systemPrompt: string[] },
			ctx: ExtensionContext,
		) => Promise<{ systemPrompt?: string[] } | void>,
	): void;
	on(
		event: "tool_result",
		handler: (
			event: {
				toolName: string;
				input: Record<string, unknown>;
				content: Array<{ type: string; text?: string }>;
				isError: boolean;
				details?: unknown;
			},
			ctx: ExtensionContext,
		) => Promise<{ content: Array<{ type: string; text?: string }> } | void>,
	): void;
	registerTool(def: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute(
			toolCallId: string,
			params: { name?: string },
			signal: AbortSignal | undefined,
			onUpdate: unknown,
			ctx: ExtensionContext,
		): Promise<{ content: { type: "text"; text: string }[] }>;
	}): void;
	registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void;
}

// per-process session state (mirrors claude-auto-memory.ts pattern); exported
// for tests (vitest, see test/)
export let rules: Rule[] = [];

/** Subdirectory CLAUDE.md files (not in .claude/rules/), indexed by their directory scope. */
export interface SubClaudeMd {
	name: string; // directory relative to cwd, e.g. "packages/api"
	filePath: string;
	body: string;
}
export let subClaudeMds: SubClaudeMd[] = [];

const HOME = homedir();

function toArray(v: unknown): string[] {
	if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
	if (typeof v === "string" && v.length) return [v];
	return [];
}
function parseFrontmatter(yaml: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const lines = yaml.split("\n");
	let i = 0;
	while (i < lines.length) {
		const m = lines[i].match(/^([\w-]+)\s*:\s*(.*)$/);
		if (!m) { i++; continue; }
		const [, k, raw] = m;
		const v = raw.trim();
		if (v === "") {
			const items: string[] = [];
			let j = i + 1;
			while (j < lines.length) {
				const it = lines[j].match(/^\s*-\s*(.*)$/);
				if (!it) break;
				items.push(it[1].trim().replace(/^["']|["']$/g, ""));
				j++;
			}
			out[k] = items.length > 0 ? items : "";
			i = j;
			continue;
		}
		if (v === "true") out[k] = true;
		else if (v === "false") out[k] = false;
		else if (v.startsWith("[") && v.endsWith("]")) out[k] = v.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
		else out[k] = v.replace(/^["']|["']$/g, "");
		i++;
	}
	return out;
}

async function parseRule(filePath: string): Promise<Rule | null> {
	let raw: string;
	try { raw = await readFile(filePath, "utf8"); } catch { return null; }
	const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	let fm: Record<string, unknown> = {};
	let body = raw;
	if (m) {
		fm = parseFrontmatter(m[1]);
		body = m[2].trim();
	}
	const globs = [
		...toArray(fm.paths),
		...toArray(fm.globs),
		...toArray(fm.applyTo),
	];
	return {
		name: basename(filePath).replace(/\.(md|mdc)$/, ""),
		filePath,
		body: body.length > MAX_RULE_BYTES ? body.slice(0, MAX_RULE_BYTES) + "\n\n[...truncated]" : body,
		globs,
		alwaysApply: fm.alwaysApply === true,
		description: typeof fm.description === "string" ? fm.description : "",
	};
}

async function scanRulesDir(dir: string, out: Rule[], seen: Set<string>): Promise<void> {
	if (!existsSync(dir)) return;
	let entries: string[];
	try { entries = await readdir(dir); } catch { return; }
	for (const name of entries) {
		if (!name.endsWith(".md") && !name.endsWith(".mdc")) continue;
		const fp = join(dir, name);
		if (seen.has(fp)) continue;
		seen.add(fp);
		const r = await parseRule(fp);
		if (r) out.push(r);
	}
}

/** Walk cwd up to HOME + scan user-home ~/.claude/rules/. */
export async function discoverRules(cwd: string): Promise<Rule[]> {
	const out: Rule[] = [];
	const seen = new Set<string>();
	let dir = resolve(cwd);
	for (;;) {
		await scanRulesDir(join(dir, ".claude", "rules"), out, seen);
		const parent = dirname(dir);
		if (parent === dir || dir === HOME) break;
		dir = parent;
	}
	await scanRulesDir(join(HOME, ".claude", "rules"), out, seen);
	return out;
}

/** Recurse cwd subdirectories (check dirs ≤ 3 levels deep, skipping hidden/build dirs) for CLAUDE.md files. */
export async function scanSubdirClaudeMds(cwd: string, out: SubClaudeMd[], depth = 0): Promise<void> {
	if (depth >= 3) return;
	let entries: string[];
	try { entries = await readdir(cwd); } catch { return; }
	for (const name of entries) {
		if (name.startsWith(".")) continue; // .git, node_modules (hidden), .claude itself
		if (SKIP_DIRS.has(name)) continue;
		const fp = join(cwd, name);
		let st;
		try { st = await stat(fp); } catch { continue; }
		if (!st.isDirectory()) continue;
		for (const candidate of [join(fp, "CLAUDE.md"), join(fp, ".claude", "CLAUDE.md")]) {
			try {
				const raw = await readFile(candidate, "utf8");
				if (!raw.trim()) continue;
				out.push({
					name: fp,
					filePath: candidate,
					body: raw.length > MAX_RULE_BYTES ? raw.slice(0, MAX_RULE_BYTES) + "\n\n[...truncated]" : raw,
				});
			} catch {
				// no CLAUDE.md at this candidate
			}
		}
		await scanSubdirClaudeMds(fp, out, depth + 1);
	}
}

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".nuxt", "coverage", "target", "out"]);

async function probeDirs(cwd: string): Promise<{ scanned: string[]; home: string }> {
	const scanned: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		scanned.push(join(dir, ".claude", "rules"));
		const parent = dirname(dir);
		if (parent === dir || dir === HOME) break;
		dir = parent;
	}
	scanned.push(join(HOME, ".claude", "rules"));
	return { scanned, home: HOME };
}

function selectRules(): Rule[] {
	// only unconditional rules get injected; path-scoped ones are indexed instead
	return rules.filter(r => r.alwaysApply);
}

function buildBlock(matched: Rule[]): string {
	if (matched.length === 0) return "";
	const blocks: string[] = [];
	let used = 0;
	for (const r of matched) {
		const head = `<!-- claude-rules: ${r.filePath} -->`;
		const piece = `${head}\n${r.body}`;
		if (used + piece.length > MAX_BYTES) break;
		blocks.push(piece);
		used += piece.length;
	}
	if (blocks.length === 0) return "";
	return [
		"## Project Rules (always-applied from .claude/rules/)",
		"",
		"Rules below are unconditionally in effect. Source of truth: `<repo>/.claude/rules/*.md`.",
		"",
		blocks.join("\n\n---\n\n"),
	].join("\n");
}

/** Path-scoped rules index text (name + globs + file path), served by the xd:// tool. */
function buildIndexText(): string {
	const scoped = rules.filter(r => !r.alwaysApply && r.globs.length > 0);
	const lines: string[] = [];
	if (scoped.length > 0) {
		lines.push("## Project Rules Index (.claude/rules/)");
		lines.push(...scoped.map(r => `- ${r.name} — ${r.globs.join(", ")} — ${r.filePath}`));
	}
	if (subClaudeMds.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("## Subdirectory CLAUDE.md");
		lines.push("Applies to files under its directory. Read before editing there:");
		lines.push(...subClaudeMds.map(m => `- ${m.name} — ${m.filePath}`));
	}
	if (lines.length === 0) return "No path-scoped rules or subdirectory CLAUDE.md files loaded.";
	return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Dynamic injection (pi-rules style): path-scoped rules and subdirectory
// CLAUDE.md files are appended to the result of any read/edit/write tool
// call whose target file matches. Rule content arrives exactly when the
// model touches a matching file — no model initiative required.
// ───────────────────────────────────────────────────────────────────────────

/** Per-session dedupe key: `${ruleFilePath}\0${absTargetPath}`. Reset on reload. */
export const injectedKeys = new Set<string>();

const TRACKED_TOOLS: Record<string, true> = { read: true, edit: true, write: true };

/** Read-tool selector suffix, e.g. `src/foo.ts:50-200`, `:raw`, `:5-16,960-973`. */
const READ_SEL_RE = /:(?:\d+(?:-\d+|\+\d+)?(?:,\d+(?:-\d+|\+\d+)?)*|raw|conflicts)$/;

/**
 * Clean a raw tool-input path: strip BOM, hashline `¶` prefix + `#tag`
 * (write.ts's own unwrap), and read-tool selectors. Returns undefined for
 * internal/web URLs. `details.*` paths from the tool itself are already
 * clean and skip this.
 */
function cleanPath(raw: string): string | undefined {
	let p = raw;
	if (p.startsWith("\uFEFF")) p = p.slice(1);
	if (p.startsWith("¶")) p = p.replace(/^¶+/, "");
	p = p.replace(/#[0-9a-fA-F]{4}$/, "");
	if (p.includes("://")) return undefined;
	p = p.replace(READ_SEL_RE, "");
	return p.length > 0 ? p : undefined;
}

/** Absolute target paths from a tool_result event (skips internal/web URLs). */
function extractTargetPaths(
	event: { toolName: string; input: Record<string, unknown>; details?: unknown },
	cwd: string,
): string[] {
	if (!(event.toolName in TRACKED_TOOLS)) return [];
	const out: string[] = [];
	const addClean = (p: unknown): void => {
		if (typeof p !== "string") return;
		const clean = cleanPath(p);
		if (!clean) return;
		out.push(resolve(cwd, clean));
	};
	// Tool-returned details paths are resolved absolute paths — use as-is.
	const addAbsolute = (p: unknown): void => {
		if (typeof p === "string" && p.length > 0) out.push(p);
	};
	if (event.toolName !== "write") {
		const d = event.details as { resolvedPath?: unknown; path?: unknown } | undefined;
		addAbsolute(d?.resolvedPath);
		addAbsolute(d?.path);
	}
	addClean(event.input.path);
	if (Array.isArray(event.input.paths)) {
		for (const p of event.input.paths) addClean(p);
	}
	return [...new Set(out)];
}

interface MatchedRule {
	filePath: string;
	body: string;
	kind: "rule" | "subclaude";
}

/** Rules whose globs / directory scope match the absolute target path. */
export function matchForPath(absPath: string, cwd: string): MatchedRule[] {
	const rel = relative(cwd, absPath).split(sep).join("/");
	const base = basename(absPath);
	const out: MatchedRule[] = [];
	for (const r of rules) {
		if (r.alwaysApply || r.globs.length === 0) continue; // alwaysApply already in the system prompt
		if (matchesGlobs(r.globs, rel, base)) out.push({ filePath: r.filePath, body: r.body, kind: "rule" });
	}
	for (const m of subClaudeMds) {
		if (absPath === m.name || absPath.startsWith(m.name + sep)) {
			out.push({ filePath: m.filePath, body: m.body, kind: "subclaude" });
		}
	}
	return out;
}

/** One appended text block with the matched rules, capped at MAX_BYTES. */
export function buildDynamicBlock(
	matched: MatchedRule[],
	targetRel: string,
): { block: string; included: MatchedRule[] } | null {
	const blocks: string[] = [];
	const included: MatchedRule[] = [];
	let used = 0;
	for (const m of matched) {
		const marker = m.kind === "subclaude" ? "claude-md" : "claude-rules";
		const piece = `<!-- ${marker}: ${m.filePath} -->\n${m.body}`;
		if (used + piece.length > MAX_BYTES) break;
		blocks.push(piece);
		included.push(m);
		used += piece.length;
	}
	if (blocks.length === 0) return null;
	return {
		block: ["## Project Rules (matched for " + targetRel + ")", "", blocks.join("\n\n---\n\n")].join("\n"),
		included,
	};
}

// ── Glob matching (picomatch, same options as pi-rules) ───────────────────
// Matched against the cwd-relative path and the basename (`**/*.ts` matches
// `a.ts` at the root; `*.md` applies to md files at any depth).

const GLOB_OPTIONS = { bash: true, dot: true } as const;

export function matchesGlobs(globs: string[], relPath: string, base: string): boolean {
	let positive = false;
	for (const g of globs) {
		const neg = g.startsWith("!");
		const isMatch = picomatch(neg ? g.slice(1) : g, GLOB_OPTIONS);
		if (isMatch(relPath) || isMatch(base)) {
			if (neg) return false;
			positive = true;
		}
	}
	return positive;
}

/** Append matched rules to a read/edit/write tool result (deduped per session). */
export async function handleToolResult(
	event: {
		toolName: string;
		input: Record<string, unknown>;
		content: Array<{ type: string; text?: string }>;
		isError: boolean;
		details?: unknown;
	},
	cwd: string,
): Promise<{ content: Array<{ type: string; text?: string }> } | undefined> {
	if (event.isError) return undefined;
	const targets = extractTargetPaths(event, cwd);
	if (targets.length === 0) return undefined;
	const matched: MatchedRule[] = [];
	const keys: string[] = [];
	const seenRules = new Set<string>(); // one event, one injection per rule file (pi-rules seenRules)
	for (const t of targets) {
		for (const m of matchForPath(t, cwd)) {
			if (seenRules.has(m.filePath)) continue;
			seenRules.add(m.filePath);
			const key = `${m.filePath}\0${t}`;
			if (injectedKeys.has(key)) continue;
			injectedKeys.add(key);
			matched.push(m);
			keys.push(key);
		}
	}
	if (matched.length === 0) return undefined;
	const built = buildDynamicBlock(matched, relative(cwd, targets[0]));
	if (!built) {
		for (const k of keys) injectedKeys.delete(k);
		return undefined;
	}
	return { content: [...event.content, { type: "text", text: built.block }] };
}

let lastError: string | undefined;

export default function claudeRulesBridge(pi: ExtensionApi): void {
	const reload = async (cwd: string, ui?: ExtensionContext["ui"]): Promise<void> => {
		try {
			rules = await discoverRules(cwd);
			const sub: SubClaudeMd[] = [];
			await scanSubdirClaudeMds(cwd, sub);
			subClaudeMds = sub;
			injectedKeys.clear();
			lastError = undefined;
			if (ui && (rules.length > 0 || subClaudeMds.length > 0)) {
				ui.notify(`[claude-rules] ${rules.length} rules, ${subClaudeMds.length} subdir CLAUDE.md`, "info");
			}
		} catch (e) {
			rules = [];
			subClaudeMds = [];
			lastError = (e as Error).message ?? String(e);
			ui?.notify(`[claude-rules] load failed: ${lastError}`, "error");
		}
	};

	pi.on("session_start", async (_e, ctx) => { await reload(ctx.cwd, ctx.ui); });
	for (const evt of ["session_switch", "session_branch", "session_tree", "session_compact"] as const) {
		pi.on(evt, async (_e, ctx) => { await reload(ctx.cwd, ctx.ui); });
	}

	pi.registerTool({
		name: "claude_rules",
		label: "Claude Rules",
		description:
			"List path-scoped .claude/rules rules and subdirectory CLAUDE.md files (no args), " +
			"or read one rule's full content (args: name). Matching rules are auto-injected " +
			"into read/edit/write tool results.",
		parameters: pi.zod.object({ name: pi.zod.string().optional() }),
		async execute(_toolCallId, params) {
			const name = params?.name?.trim();
			if (!name) {
				return { content: [{ type: "text", text: buildIndexText() }] };
			}
			const rule = rules.find(r => r.name === name);
			if (rule) {
				return { content: [{ type: "text", text: `<!-- claude-rules: ${rule.filePath} -->\n${rule.body}` }] };
			}
			const sub = subClaudeMds.find(m => m.name === name);
			if (sub) {
				return { content: [{ type: "text", text: `<!-- claude-md: ${sub.filePath} -->\n${sub.body}` }] };
			}
			const available = [...rules.map(r => r.name), ...subClaudeMds.map(m => m.name)].join(", ") || "none";
			return { content: [{ type: "text", text: `Unknown rule: ${name}\nAvailable: ${available}` }] };
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (rules.length === 0) return;
		const always = buildBlock(selectRules());
		if (!always) return;
		return { systemPrompt: [...event.systemPrompt, always] };
	});

	pi.on("tool_result", (event, ctx) => handleToolResult(event, ctx.cwd));

	pi.registerCommand("claude-rules", {
		description: "List .claude/rules/ files. Subcommand: reload",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim();
			if (sub === "reload") {
				await reload(ctx.cwd, ctx.ui);
				return;
			}
			if (rules.length === 0) {
				const probe = await probeDirs(ctx.cwd);
				ctx.ui.notify(`[claude-rules] no rules loaded\ncwd: ${ctx.cwd}\nscanned: ${probe.scanned.join(", ") || "(none)"}\nhome: ${probe.home}\n${lastError ? `error: ${lastError}` : "no .claude/rules/ in cwd walk-up or ~/.claude/rules/"}`, "info");
				return;
			}
			const lines = [
				...rules.map(r => {
					const flags = [
						r.alwaysApply ? "alwaysApply" : null,
						r.globs.length ? `globs=[${r.globs.join(",")}]` : null,
					].filter(Boolean).join(" ");
					return `- ${r.name}  ${flags}\n  ${r.filePath}`;
				}),
				...subClaudeMds.map(m => `- ${m.name} (CLAUDE.md)\n  ${m.filePath}`),
			];
			ctx.ui.notify(`[claude-rules] ${rules.length} rules, ${subClaudeMds.length} subdir CLAUDE.md:\n${lines.join("\n")}`, "info");
		},
	});
}
