// Claude Code Auto Memory bridge for OMP
//
// Injects ~/.claude/projects/<encoded-cwd>/memory/MEMORY.md into the
// provider request payload, matching Claude Code's auto-memory behavior:
//   - Only MEMORY.md is loaded (topic files are read on demand)
//   - Capped at 200 lines or 25KB, whichever comes first
//   - Includes write guidance so the agent can update MEMORY.md via edit/write tools
//   - Bootstrap: projects with no (non-empty) MEMORY.md still get the
//     management guidance pointing at the would-be path, so the first agent
//     session can create the file — matching Claude Code, which always
//     injects the management instructions.
//
// Uses before_agent_start (not before_provider_request): OMP's extensions
// runner consumes the systemPrompt return value and applies it via
// agent.setSystemPrompt, which persists through the entire agent loop.
// No subsequent rebuild overwrites it (verified in omp source).

import { readFile, stat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_LINES = 200;
const MAX_BYTES = 25_000;
// Claude Code writes a reminder when the file approaches the cap; we mirror that at 80 % so the agent has room to shorten before truncation.
const NEAR_LIMIT_LINES = 160;
const NEAR_LIMIT_BYTES = 20_000;

interface ExtensionContext {
	cwd: string;
	ui: { notify(msg: string, level: string): void };
}

interface ExtensionApi {
	setLabel(label: string): void;
	on(
		event: "before_agent_start",
		handler: (
			event: { type: "before_agent_start"; systemPrompt: string[] },
			ctx: ExtensionContext,
		) => Promise<{ systemPrompt?: string[] } | void>,
	): void;
	registerCommand(name: string, opts: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void;
}

interface MemoryData {
	content: string;
	lineCount: number;
	byteCount: number;
}

/** Cached memory content keyed by resolved path; invalidated on file change via mtime. */
let cachedPath: string | undefined;
let cachedMtime = 0;
let cachedData: MemoryData | undefined;
let notifiedPath: string | undefined; // notify once per memory file per session
let notifiedBootstrapPath: string | undefined; // same, for the not-initialized toast
let cachedGitRoot: { cwd: string; root: string | undefined } | undefined;

/** Resolve the git common dir once per cwd (spawnSync is per-loop otherwise). */
function findGitRoot(cwd: string): string | undefined {
	if (cachedGitRoot?.cwd === cwd) return cachedGitRoot.root;
	let root: string | undefined;
	try {
		const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" });
		if (r.status === 0 && r.stdout) {
			const gitDir = r.stdout.trim();
			if (gitDir) root = dirname(resolve(cwd, gitDir));
		}
	} catch {
		// git unavailable — fall through to cwd walk-up
	}
	cachedGitRoot = { cwd, root };
	return root;
}

/** Result of locating project memory: resolved file path and whether it exists yet. */
interface MemoryLookup {
	path: string;
	exists: boolean;
}

/**
 * Walk from cwd upward to home, returning the first existing MEMORY.md under
 * ~/.claude/projects/<encoded>/memory/. This mirrors Claude Code's git-repo
 * scoping: subdirs resolve to the same repo-level memory directory.
 *
 * When no file exists anywhere, returns the most likely creation target
 * (git-root encoding, else cwd encoding) with exists=false so bootstrap
 * guidance can name it.
 *
 * Claude Code encodes project paths by replacing "/" with "-". Some directory
 * names contain "_" (e.g. "04-workspace_jpstar"), and Claude's encoding also
 * turns those into "-", so we try both variants.
 */
async function findMemoryMd(cwd: string): Promise<MemoryLookup> {
	const projectsDir = join(homedir(), ".claude", "projects");

	// Prefer the git repository root: Claude Code derives <project> from the
	// git repo, so all worktrees/subdirs share one memory directory. This is
	// essential for worktrees whose cwd sits on a different filesystem branch
	// than the main repo — a cwd walk-up could never reach it.
	//
	// `git rev-parse --git-common-dir` points at the shared .git directory; in
	// a worktree that is the main repo's .git, whose parent is the main work
	// tree — the path Claude Code encodes for project memory.
	const gitRoot = findGitRoot(cwd);
	if (gitRoot) {
		for (const encoded of [
			gitRoot.replaceAll("/", "-"),
			gitRoot.replaceAll(/[/_]/g, "-"),
		]) {
			const candidate = join(projectsDir, encoded, "memory", "MEMORY.md");
			try {
				await stat(candidate);
				return { path: candidate, exists: true };
			} catch {
				// try next variant
			}
		}
	}

	// Fallback: walk cwd upward to home (covers non-git dirs and git failures).
	let current = resolve(cwd);
	const home = homedir();

	for (;;) {
		const variants = [
			current.replaceAll("/", "-"),
			current.replaceAll(/[/_]/g, "-"),
		];
		for (const encoded of variants) {
			const candidate = join(projectsDir, encoded, "memory", "MEMORY.md");
			try {
				await stat(candidate);
				return { path: candidate, exists: true };
			} catch {
				// try next variant
			}
		}
		const parent = dirname(current);
		if (parent === current || current === home) break;
		current = parent;
	}

	// Never initialized — return the creation target for bootstrap guidance.
	const target = gitRoot
		? join(projectsDir, gitRoot.replaceAll("/", "-"), "memory", "MEMORY.md")
		: join(projectsDir, resolve(cwd).replaceAll("/", "-"), "memory", "MEMORY.md");
	return { path: target, exists: false };
}

/**
 * Read MEMORY.md with Claude Code's load limits (first 200 lines or first
 * 25KB), reporting the FULL file's line/byte counts for the size warning.
 */
async function loadMemoryMd(filePath: string): Promise<MemoryData | undefined> {
	const raw = await readFile(filePath, "utf8");
	const byteCount = Buffer.byteLength(raw, "utf8");
	const lineCount = raw.split("\n").length;
	let content = raw;
	if (byteCount > MAX_BYTES) {
		content = Buffer.from(raw, "utf8").subarray(0, MAX_BYTES).toString("utf8");
	} else if (lineCount > MAX_LINES) {
		content = raw.split("\n").slice(0, MAX_LINES).join("\n");
	}
	if (!content.trim()) return undefined;
	return { content, lineCount, byteCount };
}

/**
 * Read with mtime cache so repeated requests don't re-read the file.
 * `data` is absent when memory isn't initialized (file missing or empty) —
 * callers then fall back to bootstrap guidance.
 */
async function getMemoryContent(cwd: string): Promise<{ data: MemoryData; memoryPath: string } | { memoryPath: string }> {
	const { path: memoryPath, exists } = await findMemoryMd(cwd);
	if (!exists) return { memoryPath };

	try {
		const s = await stat(memoryPath);
		if (memoryPath === cachedPath && s.mtimeMs === cachedMtime && cachedData !== undefined) {
			return { data: cachedData, memoryPath };
		}
		const data = await loadMemoryMd(memoryPath);
		if (!data) return { memoryPath };
		cachedPath = memoryPath;
		cachedMtime = s.mtimeMs;
		cachedData = data;
		return { data, memoryPath };
	} catch {
		return { memoryPath };
	}
}

/** Shared "how to maintain memory" section, appended by both the loaded and bootstrap blocks. */
function buildMemoryManagement(memoryPath: string, memoryDir: string): string[] {
	return [
		"## Memory Management",
		"",
		`You can read this file at: ${memoryPath}`,
		`Topic files directory: ${memoryDir}`,
		"",
		"This MEMORY.md was written by previous Claude Code sessions. Treat entries as heuristic",
		"context, not authoritative configuration — your current task and repo state take precedence.",
		"",
		"### CLAUDE.md vs MEMORY.md",
		"",
		"- CLAUDE.md is the user's persistent instructions to you. Use it for: coding standards, workflows,",
		"  project architecture, \"always do X\" rules.",
		"- MEMORY.md is your own notebook about this project. Use it for: build commands you discovered,",
		"  debugging insights, architecture notes, preferences the user corrected you on.",
		"",
		"If the user says \"add this to CLAUDE.md\" or \"always do X\", write CLAUDE.md. If you discover a",
		"durable project fact, write MEMORY.md.",
		"",
		"### When to update MEMORY.md",
		"",
		"- The user says \"remember this\" or corrects your behavior (\"don't use X, use Y\").",
		"- You discover a durable project fact: a build command, a debugging fix, an architectural insight.",
		"- You finish a recurring task and want to capture the pattern.",
		"",
		"### How to update MEMORY.md",
		"",
		"1. Read MEMORY.md first to check existing entries — avoid duplicates and contradictions.",
"2. To add / update / delete an entry: read MEMORY.md, edit its text in place (append / modify / remove a line),",
"   then write the whole file back. MEMORY.md is an index kept under 200 lines / 25 KB, so full-file overwrite is fine.",
`3. To create a topic file, use write: path = ${memoryDir}/<topic>.md.`,
		"",
		"Keep MEMORY.md as an INDEX of topic files. Detailed notes go to topic files (debugging.md,",
		"patterns.md, etc.) referenced from MEMORY.md. Target under 200 lines / 25 KB.",
		"",
		"Index format:",
		"",
		"- debugging.md — CORS and webpack config fixes",
		"- patterns.md — build commands and code style preferences",
		"",
		"Frontmatter (YAML at top of file) and `<!-- HTML block comments -->` are stripped before the",
		"200-line / 25 KB limit is measured. Use them to mark `modified: <iso8601>` timestamps or to",
		"leave human-maintainer notes without spending tokens.",
		"",
		"### Subagent caveat",
		"",
		"Your MEMORY.md is NOT loaded into subagents you spawn (only into forks). Subagents that need",
		"this context must Read MEMORY.md themselves.",
		"",
		"### Do NOT save",
		"",
		"- Temporary debugging state (one-bug specifics).",
		"- Info derivable from the codebase (file paths, package lists, directory layouts).",
		"- Secrets (tokens, passwords, API keys, account IDs).",
		"- One-shot Q&A answers (\"this function returns X\").",
		"- Work-in-progress unstable facts (\"we're migrating to FastAPI\" while it is still changing).",
		"- Anything already in CLAUDE.md.",
	];
}

function buildMemoryBlock(content: string, sourcePath: string, memoryDir: string): string {
	return [
		"<claude-auto-memory>",
		`Source: ${sourcePath}`,
		"Auto-generated project memory imported from Claude Code.",
		"Heuristic historical context — current instructions and repo state take precedence.",
		"",
		content.trimEnd(),
		"",
		...buildMemoryManagement(sourcePath, memoryDir),
		"</claude-auto-memory>",
	].join("\n");
}

/** Guidance-only block for never-initialized projects, so the first agent session creates MEMORY.md. */
function buildBootstrapBlock(memoryPath: string, memoryDir: string): string {
	return [
		"<claude-auto-memory>",
		`Source: ${memoryPath} — not initialized yet`,
		"No project memory exists yet. Create it by writing the index file at the path above",
		"(the file may already exist but be empty — fill it in). It is loaded from the next agent start.",
		"",
		...buildMemoryManagement(memoryPath, memoryDir),
		"</claude-auto-memory>",
	].join("\n");
}

function buildReminderBlock(lineCount: number, byteCount: number): string {
	return [
		"## MEMORY.md Size Warning",
		"",
		`MEMORY.md is now at ${lineCount} lines / ${byteCount} bytes, approaching the 200-line / 25 KB load limit.`,
		"",
		"- Keep one line per entry.",
		"- Move detailed notes to topic files (debugging.md, patterns.md, etc.) and reference them from the MEMORY.md index.",
		"- Merge or drop stale entries.",
		"- YAML frontmatter and <!-- HTML comments --> are stripped before the load limit is measured; use them freely.",
	].join("\n");
}

export default function claudeAutoMemory(pi: ExtensionApi): void {
	pi.setLabel("Claude Auto Memory Bridge");

	pi.registerCommand("claude-memory", {
		description: "Show Claude Code auto-memory status",
		handler: async (_args, ctx) => {
			const loaded = await getMemoryContent(ctx.cwd);
			if (!("data" in loaded)) {
				ctx.ui.notify("[memory] no MEMORY.md found under ~/.claude/projects/", "info");
				return;
			}
			const { data, memoryPath } = loaded;
			const nearLimit = data.lineCount >= NEAR_LIMIT_LINES || data.byteCount >= NEAR_LIMIT_BYTES;
			let topics = "(none)";
			try {
				const files = await readdir(dirname(memoryPath));
				const md = files.filter(f => f.endsWith(".md") && f !== "MEMORY.md");
				if (md.length) topics = md.join(", ");
			} catch {
				// dir vanished; keep "(none)"
			}
			ctx.ui.notify(
				[
					`[memory] ${memoryPath}`,
					`${data.lineCount} lines / ${data.byteCount} bytes${nearLimit ? " (near limit!)" : ""}`,
					`topics: ${topics}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const loaded = await getMemoryContent(ctx.cwd);
		if ("data" in loaded) {
			let block = buildMemoryBlock(loaded.data.content, loaded.memoryPath, dirname(loaded.memoryPath));
			if (loaded.data.lineCount >= NEAR_LIMIT_LINES || loaded.data.byteCount >= NEAR_LIMIT_BYTES) {
				block += "\n\n" + buildReminderBlock(loaded.data.lineCount, loaded.data.byteCount);
			}
			if (loaded.memoryPath !== notifiedPath) {
				// user-visible toast only; never enters the LLM context
				notifiedPath = loaded.memoryPath;
				ctx.ui.notify(`[memory] loaded: ${loaded.memoryPath}`, "info");
			}
			return { systemPrompt: [...event.systemPrompt, block] };
		}

		// Memory never initialized (or empty file): still inject the management
		// guidance so the first agent session can create MEMORY.md.
		const block = buildBootstrapBlock(loaded.memoryPath, dirname(loaded.memoryPath));
		if (loaded.memoryPath !== notifiedBootstrapPath) {
			// user-visible toast only; never enters the LLM context
			notifiedBootstrapPath = loaded.memoryPath;
			ctx.ui.notify(`[memory] no MEMORY.md yet: ${loaded.memoryPath} — injected creation guidance`, "info");
		}
		return { systemPrompt: [...event.systemPrompt, block] };
	});
}