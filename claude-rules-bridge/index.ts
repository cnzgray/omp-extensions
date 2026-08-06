// Claude Code .claude/rules/ + CLAUDE.md bridge for omp.
//
// Two complementary mechanisms:
//
// 1. .claude/rules/*.md and *.mdc (Claude Code rule files)
//    Discovered from cwd (walked up to home) + ~/.claude/rules/. Frontmatter:
//      - paths | globs | applyTo  → file-match globs (merged)
//      - alwaysApply             → always inject regardless of cwd/files
//      - description             → metadata for /claude-rules listing
//    - alwaysApply rules → injected into the system prompt each agent loop.
//    - Path-scoped rules → injected dynamically on read/edit/write tool_result
//      when the touched file matches the globs.
//
// 2. CLAUDE.md files (Claude Code hierarchical memory)
//    Mirrors Claude Code semantics:
//    - System-prompt layer: at session start, every CLAUDE.md (and
//      .claude/CLAUDE.md) from the session cwd up to $HOME is collected and
//      injected once into the system prompt — the cwd's own CLAUDE.md lives
//      here, so it is in effect from the first agent turn, not on first file
//      touch.
//    - Dynamic layer: on every read/edit/write tool_result we walk UP from the
//      touched file's directory to $HOME and inject any CLAUDE.md not already
//      in the system-prompt layer. This covers CLAUDE.md deeper than cwd
//      (subdirectory memory) AND CLAUDE.md outside the cwd→home chain
//      (worktrees, sibling monorepo packages) — the old "recurse cwd down 3
//      levels" scan could do neither.
//
// Why before_agent_start (not before_provider_request):
//   OMP's extensions runner consumes the systemPrompt return value and
//   applies it via agent.setSystemPrompt, which persists through the entire
//   agent loop. No subsequent rebuild overwrites it (verified in omp source).
//   (Same rationale as claude-auto-memory.ts in this directory.)
//
// The xd://claude_rules device stays as an on-demand index/reader for
// anything the auto-match misses.
//
// Token cap: 12 KB per injected block (aligned with pi-rules).
// Only dependency: picomatch vendored at vendor/picomatch (glob matching,
// same options as pi-rules). Vendored because marketplace installs don't run
// dependency installation; picomatch is zero-dep pure JS.
// Frontmatter stays hand-rolled to avoid a yaml dependency.

import { readFile, readdir } from "node:fs/promises";
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

/** A discovered CLAUDE.md file. `name` is the directory it governs (absolute). */
export interface SubClaudeMd {
	name: string; // absolute directory path owning this CLAUDE.md
	filePath: string;
	body: string;
}

/** CLAUDE.md from cwd up to $HOME — injected into the system prompt once. */
export let hierClaudeMds: SubClaudeMd[] = [];
/** filePaths already in the system-prompt layer; dynamic injection skips them. */
export let systemPromptMdPaths: Set<string> = new Set();

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
		if (!/\.(md|mdc)$/.test(name)) continue;
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

/**
 * Walk `startDir` up to $HOME, returning the first CLAUDE.md found at each
 * level (checking `CLAUDE.md` then `.claude/CLAUDE.md`; first hit per directory
 * wins to avoid double-loading two variants of the same dir's memory).
 * Ordered deepest-first.
 */
export async function findClaudeMdsUpward(startDir: string): Promise<SubClaudeMd[]> {
	const out: SubClaudeMd[] = [];
	let dir = resolve(startDir);
	for (;;) {
		for (const candidate of [join(dir, "CLAUDE.md"), join(dir, ".claude", "CLAUDE.md")]) {
			let raw: string;
			try { raw = await readFile(candidate, "utf8"); } catch { continue; }
			if (!raw.trim()) continue;
			out.push({
				name: dir,
				filePath: candidate,
				body: raw.length > MAX_RULE_BYTES ? raw.slice(0, MAX_RULE_BYTES) + "\n\n[...truncated]" : raw,
			});
			break; // first hit per directory
		}
		if (dir === HOME) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

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

/** System-prompt block for the cwd→home CLAUDE.md hierarchy. */
function buildClaudeMdBlock(mds: SubClaudeMd[]): string {
	if (mds.length === 0) return "";
	const blocks: string[] = [];
	let used = 0;
	for (const m of mds) {
		const head = `<!-- claude-md: ${m.filePath} -->`;
		const piece = `${head}\n${m.body}`;
		if (used + piece.length > MAX_BYTES) break;
		blocks.push(piece);
		used += piece.length;
	}
	if (blocks.length === 0) return "";
	return [
		"## Project CLAUDE.md (cwd → home hierarchy)",
		"",
		"Claude Code CLAUDE.md files from the session cwd up to $HOME — in effect for the whole session. " +
			"Subdirectory CLAUDE.md deeper than cwd (or outside the cwd→home chain) is injected dynamically " +
			"when a file under it is read/edited.",
		"",
		blocks.join("\n\n---\n\n"),
	].join("\n");
}

/** CLAUDE.md files injected into tool results this session (dynamic layer), derived from the per-target dedupe keys. */
function injectedSubclaudePaths(): string[] {
	const ruleFilePaths = new Set(rules.map(r => r.filePath));
	const out = new Set<string>();
	for (const key of injectedKeys) {
		const fp = key.split("\0")[0];
		if (!ruleFilePaths.has(fp)) out.add(fp);
	}
	return [...out];
}
function buildIndexText(): string {
	const scoped = rules.filter(r => !r.alwaysApply && r.globs.length > 0);
	const lines: string[] = [];
	if (scoped.length > 0) {
		lines.push("## Project Rules Index (.claude/rules/)");
		lines.push(...scoped.map(r => `- ${r.name} — ${r.globs.join(", ")} — ${r.filePath}`));
	}
	if (hierClaudeMds.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("## CLAUDE.md (cwd → home, in system prompt)");
		lines.push(...hierClaudeMds.map(m => `- ${m.name} — ${m.filePath}`));
	}
	const dynInjected = injectedSubclaudePaths();
	if (dynInjected.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("## CLAUDE.md (dynamically injected into tool results this session)");
		lines.push(...dynInjected.map(fp => `- ${fp}`));
	} else {
		lines.push("");
		lines.push("Subdirectory CLAUDE.md (deeper than cwd, or outside the cwd→home chain) is injected dynamically on read/edit/write — no static index; discovered by walking up from the touched file.");
	}
	return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────────────────
// Dynamic injection (pi-rules style): path-scoped rules and CLAUDE.md files
// are appended to the result of any read/edit/write tool call whose target
// file matches. Content arrives exactly when the model touches a matching
// file — no model initiative required.
// ───────────────────────────────────────────────────────────────────────────

/** Per-session dedupe key: `${ruleFilePath}\0${absTargetPath}`. Reset on reload. */
export const injectedKeys = new Set<string>();

/** CLAUDE.md files toasted as "injected" this session; per-filePath dedupe so reading many files under one CLAUDE.md toasts once. */
export let notifiedInjectedMds: Set<string> = new Set();

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

/**
 * Matching rules + CLAUDE.md for an absolute target path.
 * - Path-scoped .claude/rules globs are matched against the cwd-relative path.
 * - CLAUDE.md is found by walking UP from the target file's directory to
 *   $HOME; any CLAUDE.md already in the system-prompt layer is skipped (it's
 *   already in effect, no need to repeat per file touch).
 */
export async function matchForPath(absPath: string, cwd: string): Promise<MatchedRule[]> {
	const rel = relative(cwd, absPath).split(sep).join("/");
	const base = basename(absPath);
	const out: MatchedRule[] = [];
	for (const r of rules) {
		if (r.alwaysApply || r.globs.length === 0) continue; // alwaysApply already in the system prompt
		if (matchesGlobs(r.globs, rel, base)) out.push({ filePath: r.filePath, body: r.body, kind: "rule" });
	}
	const upward = await findClaudeMdsUpward(dirname(absPath));
	for (const m of upward) {
		if (systemPromptMdPaths.has(m.filePath)) continue;
		out.push({ filePath: m.filePath, body: m.body, kind: "subclaude" });
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
	ctx: ExtensionContext,
): Promise<{ content: Array<{ type: string; text?: string }> } | undefined> {
	if (event.isError) return undefined;
	const cwd = ctx.cwd;
	const targets = extractTargetPaths(event, cwd);
	if (targets.length === 0) return undefined;
	const matched: MatchedRule[] = [];
	const keys: string[] = [];
	const seenRules = new Set<string>(); // one event, one injection per rule file (pi-rules seenRules)
	for (const t of targets) {
		for (const m of await matchForPath(t, cwd)) {
			if (seenRules.has(m.filePath)) continue;
			seenRules.add(m.filePath);
			const key = `${m.filePath}\0${t}`;
			if (injectedKeys.has(key)) continue;
			injectedKeys.add(key);
			matched.push(m);
			keys.push(key);
			// ponytail: toast once per CLAUDE.md when it's dynamically injected for the first time
			if (m.kind === "subclaude" && !notifiedInjectedMds.has(m.filePath)) {
				notifiedInjectedMds.add(m.filePath);
				ctx.ui.notify(`[claude-rules] injected: ${m.filePath}`, "info");
			}
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
	let notifiedCwd: string | undefined; // toast once per cwd per session (mirrors memory's per-path dedupe)

	const reload = async (ctx: ExtensionContext): Promise<void> => {
		try {
			rules = await discoverRules(ctx.cwd);
			hierClaudeMds = await findClaudeMdsUpward(ctx.cwd);
			systemPromptMdPaths = new Set(hierClaudeMds.map(m => m.filePath));
			injectedKeys.clear();
			notifiedInjectedMds = new Set();
			lastError = undefined;
			if (ctx.cwd !== notifiedCwd) {
				notifiedCwd = ctx.cwd;
				ctx.ui.notify(`[claude-rules] loaded: ${rules.length} rules, ${hierClaudeMds.length} CLAUDE.md`, "info");
			}
		} catch (e) {
			rules = [];
			hierClaudeMds = [];
			systemPromptMdPaths = new Set();
			lastError = (e as Error).message ?? String(e);
			ctx.ui.notify(`Claude rules load failed: ${lastError}`, "warning");
		}
	};

	pi.on("session_start", async (_e, ctx) => { await reload(ctx); });
	for (const evt of ["session_switch", "session_branch", "session_tree", "session_compact"] as const) {
		pi.on(evt, async (_e, ctx) => { await reload(ctx); });
	}

	pi.registerTool({
		name: "claude_rules",
		label: "Claude Rules",
		description:
			"List path-scoped .claude/rules rules and cwd→home CLAUDE.md files (no args), " +
			"or read one rule's full content (args: name). Matching rules and subdirectory " +
			"CLAUDE.md are auto-injected into read/edit/write tool results.",
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
			const sub = hierClaudeMds.find(m => m.name === name || m.filePath === name);
			if (sub) {
				return { content: [{ type: "text", text: `<!-- claude-md: ${sub.filePath} -->\n${sub.body}` }] };
			}
			const available = [...rules.map(r => r.name), ...hierClaudeMds.map(m => m.name)].join(", ") || "none";
			return { content: [{ type: "text", text: `Unknown rule: ${name}\nAvailable: ${available}\n(Subdirectory CLAUDE.md outside the cwd→home chain is injected dynamically, not indexed — read a file under it.)` }] };
		},
	});

	pi.on("before_agent_start", async (event) => {
		const parts: string[] = [];
		// only unconditional rules get injected; path-scoped ones are matched dynamically
		const always = buildBlock(rules.filter(r => r.alwaysApply));
		if (always) parts.push(always);
		const mdBlock = buildClaudeMdBlock(hierClaudeMds);
		if (mdBlock) parts.push(mdBlock);
		if (parts.length === 0) return;
		return { systemPrompt: [...event.systemPrompt, ...parts] };
	});

	pi.on("tool_result", (event, ctx) => handleToolResult(event, ctx));

	pi.registerCommand("claude-rules", {
		description: "List .claude/rules/ files and CLAUDE.md. Subcommand: reload",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim();
			if (sub === "reload") {
				await reload(ctx);
				return;
			}
		if (rules.length === 0 && hierClaudeMds.length === 0) {
			const probe = await probeDirs(ctx.cwd);
			ctx.ui.notify(
				`Claude rules: none • cwd ${ctx.cwd}\n` +
				`scanned: ${probe.scanned.join(", ") || "(none)"}\n` +
				`home: ${probe.home}\n` +
				(lastError ? `error: ${lastError}` : "no .claude/rules/ in cwd walk-up or ~/.claude/rules/, and no CLAUDE.md from cwd→home"),
				"info",
			);
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
			...hierClaudeMds.map(m => `- ${m.name} (CLAUDE.md, system-prompt)\n  ${m.filePath}`),
			...injectedSubclaudePaths().map(fp => `- ${fp} (CLAUDE.md, dynamically injected)\n  ${fp}`),
		];
		ctx.ui.notify(
			`Claude rules: ${rules.length} rules • ${hierClaudeMds.length} CLAUDE.md (system-prompt) • ${injectedSubclaudePaths().length} injected\n` +
			lines.join("\n"),
			"info",
		);
		},
	});
}