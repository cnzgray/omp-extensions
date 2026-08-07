// @orca-managed-pi-extension
// ponytail — lazy senior dev mode for OMP.
//
// Why: Ponytail ships an equivalent runtime at
// .claude/plugins/cache/ponytail/ponytail/<v>/pi-extension/index.js, but that
// targets the upstream pi CLI's extension host, not OMP's. OMP auto-loads any
// @orca-managed-pi-extension-marked .ts file from ~/.omp/agent/extensions/.
//
// Why before_agent_start (not before_provider_request): OMP's extensions
// runner consumes the systemPrompt return value and applies it via
// agent.setSystemPrompt, which persists through the entire agent loop.
// No subsequent rebuild overwrites it (verified in omp source). The Claude
// Code pi-extension uses before_agent_start too — upstream pi has no
// before_provider_request hook, but OMP exposes both.
//
// Why reuse hooks/: the instruction text and config resolution are versioned
// alongside the skill bodies. Vendoring them by re-requiring keeps the OMP
// extension byte-identical with the Claude Code one at any ponytail version.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

type PonytailMode = 'off' | 'lite' | 'full' | 'ultra' | 'review'

interface PonytailConfig {
  DEFAULT_MODE: PonytailMode
  getDefaultMode: () => PonytailMode
  normalizeMode: (m: unknown) => PonytailMode | null
  normalizeConfigMode: (m: unknown) => PonytailMode | null
  normalizePersistedMode: (m: unknown) => PonytailMode | null
  isDeactivationCommand: (text: string) => boolean
  writeDefaultMode: (m: string) => PonytailMode | null
  getHideStatus?: () => boolean
}

interface PonytailInstructions {
  getPonytailInstructions: (mode: PonytailMode) => string
}

interface PonytailSessionEntry {
  type?: string
  customType?: string
  data?: { mode?: unknown }
}

interface PiUI {
  setStatus?: (name: string, text: string | undefined) => void
  setEditorText?: (text: string) => void
  theme?: {
    fg?: (color: string, text: string) => string
  }
  notify?: (message: string, level: string) => void
}

interface PiSessionManager {
  getBranch?: () => PonytailSessionEntry[]
  getEntries?: () => PonytailSessionEntry[]
}

interface PiContext {
  ui?: PiUI
  sessionManager?: PiSessionManager
  isIdle?: () => boolean
}

type CommandParsed =
  | { type: 'set-mode'; mode: PonytailMode }
  | { type: 'set-default'; mode: PonytailMode }
  | { type: 'status' }
  | { type: 'invalid'; reason: string; mode?: string }

function findPonytailRoot(): string | null {
  const bases: string[] = []
  if (process.env.PONYTAIL_INSTALL_PATH) bases.push(process.env.PONYTAIL_INSTALL_PATH)
  bases.push(path.join(os.homedir(), '.claude', 'plugins', 'cache', 'ponytail', 'ponytail'))

  for (const base of bases) {
    let versions: string[] = []
    try {
      versions = fs
        .readdirSync(base)
        .filter((d): d is string => /^\d+\.\d+\.\d+$/.test(d))
    } catch {
      continue
    }
    if (versions.length === 0) continue
    versions.sort().reverse()
    for (const v of versions) {
      const root = path.join(base, v)
      if (fs.existsSync(path.join(root, 'hooks', 'ponytail-config.js'))) {
        return root
      }
    }
  }
  // ponytail: vendored fallback — this package ships its own copy of the
  // hooks, so the extension works without a Claude Code marketplace install.
  // Real installs still win (newer instruction text/config), vendor is last.
  const vendored = path.join(import.meta.dir, 'vendor', 'ponytail')
  if (fs.existsSync(path.join(vendored, 'hooks', 'ponytail-config.js'))) {
    return vendored
  }
  return null
}

const ponytailRoot = findPonytailRoot()

if (!ponytailRoot) {
  // ponytail: silent skip rather than a hard failure on every OMP startup.
  // The skills are still loaded by OMP's skill scan; only the always-on
  // injection and slash command are unavailable.
  console.warn('ponytail: hooks/ not found under ~/.claude/plugins/cache; extension inactive.')
}

// ponytail: typing the require() result as the known vendor shape. The
// module's exports are a stable CJS interface owned by this same plugin
// family; the assignment is a typed bind, not an escape hatch.
const configModule: PonytailConfig = ponytailRoot
  ? (require(path.join(ponytailRoot, 'hooks', 'ponytail-config.js')) as PonytailConfig)
  : {
      DEFAULT_MODE: 'full',
      getDefaultMode: () => 'full',
      normalizeMode: () => null,
      normalizeConfigMode: () => null,
      normalizePersistedMode: () => null,
      isDeactivationCommand: () => false,
      writeDefaultMode: () => null,
      getHideStatus: () => false,
    }

const instructionsModule: PonytailInstructions = ponytailRoot
  ? (require(path.join(ponytailRoot, 'hooks', 'ponytail-instructions.js')) as PonytailInstructions)
  : {
      getPonytailInstructions: (mode) =>
        `PONYTAIL MODE ACTIVE — level: ${mode}. (ponytail hooks not loaded; install via Claude Code marketplace to restore full instructions.)`,
    }

const { DEFAULT_MODE, getDefaultMode, normalizeMode, normalizeConfigMode,
        normalizePersistedMode, isDeactivationCommand, writeDefaultMode } = configModule
// ponytail: getHideStatus landed after the 4.8.4-era hooks snapshots; stale
// installs degrade to "always show", same as upstream before #324.
const getHideStatus = configModule.getHideStatus ?? (() => false)
const { getPonytailInstructions } = instructionsModule



function resolveSessionMode(
  entries: PonytailSessionEntry[] | null | undefined,
  fallbackMode: PonytailMode,
): PonytailMode {
  const fallback = normalizePersistedMode(fallbackMode) || DEFAULT_MODE
  if (!Array.isArray(entries)) return fallback
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (entry?.type !== 'custom' || entry?.customType !== 'ponytail-mode') continue
    const mode = normalizePersistedMode(entry?.data?.mode)
    if (mode) return mode
  }
  return fallback
}

function parsePonytailCommand(text: string, defaultMode: PonytailMode): CommandParsed {
  const fallback = normalizePersistedMode(defaultMode) || DEFAULT_MODE
  const normalized = String(text || '').trim().toLowerCase()
  if (!normalized) {
    return { type: 'set-mode', mode: fallback === 'off' ? 'full' : fallback }
  }
  const parts = normalized.split(/\s+/)
  const primary = parts[0]
  const secondary = parts[1]
  if (primary === 'status') return { type: 'status' }
  if (primary === 'default') {
    const mode = normalizeConfigMode(secondary)
    return mode
      ? { type: 'set-default', mode }
      : { type: 'invalid', reason: 'invalid-default-mode' }
  }
  const mode = normalizeMode(primary)
  return mode
    ? { type: 'set-mode', mode }
    : { type: 'invalid', reason: 'invalid-mode', mode: primary }
}

// ponytail: level icons mirror the upstream pi-extension status bar
// (🌿/⚡/🔥); OMP's theme exposes the same color roles (accent/dim/muted/text),
// so the rendered string is byte-identical with Claude Code's.
const LEVEL_ICONS: Record<string, string> = { lite: '🌿', full: '⚡', ultra: '🔥' }

interface PiCommandDef {
  description: string
  handler: (args: string, ctx: PiContext | null) => Promise<void> | void
}

interface PiHost {
  registerCommand: (name: string, def: PiCommandDef) => void
  sendUserMessage: (message: string, opts?: { deliverAs?: string }) => void
  appendEntry: (type: string, data: unknown) => void
  on: (event: string, handler: (...args: unknown[]) => unknown) => void
}

export default function ponytailExtension(pi: PiHost) {
  let currentMode: PonytailMode = DEFAULT_MODE
  let configuredDefaultMode: PonytailMode = getDefaultMode()
  let hideStatus = getHideStatus()
  let isActive = false
  let lastCtx: PiContext | null = null

  function syncStatus(ctx: PiContext | null) {
    if (ctx) lastCtx = ctx
    const c = ctx || lastCtx
    // ponytail: hide the indicator but keep the ruleset active (#324).
    if (hideStatus) return
    const setStatus = c?.ui?.setStatus
    if (!setStatus) return
    // ponytail: try/catch guards against a theme proxy throwing before initTheme.
    let theme: PiUI['theme']
    try {
      theme = c.ui?.theme
      if (!theme?.fg) return
    } catch {
      return
    }
    if (currentMode === 'off') {
      setStatus('ponytail', '')
      return
    }
    const icon = LEVEL_ICONS[currentMode] || ''
    const label = currentMode.toUpperCase()
    const indicator = isActive ? theme.fg('accent', '●') : theme.fg('dim', '○')
    setStatus(
      'ponytail',
      indicator + ' 🐴 ' + theme.fg('muted', 'ponytail: ') + theme.fg('text', icon + ' ' + label),
    )
  }

  function setMode(mode: PonytailMode, ctx: PiContext | null): void {
    const normalized = normalizePersistedMode(mode)
    if (!normalized) return
    currentMode = normalized
    try {
      pi.appendEntry('ponytail-mode', { mode: normalized })
    } catch {
      // ponytail: appendEntry may be unavailable in some hosts; mode still
      // applies for the current session, just not persisted across restarts.
    }
    syncStatus(ctx)
    ctx?.ui?.notify?.(`Ponytail mode set to ${normalized}.`, 'info')
  }

  pi.registerCommand("ponytail", {
    description: "Set or report Ponytail mode",
    handler: async (args, ctx) => {
      const parsed = parsePonytailCommand(args || '', configuredDefaultMode)
      if (parsed.type === 'status') {
        ctx?.ui?.notify?.(
          `Ponytail: current ${currentMode} • default ${configuredDefaultMode}`,
          'info',
        )
        return
      }
      if (parsed.type === 'set-default') {
        const written = writeDefaultMode(parsed.mode)
        if (!written) return
        configuredDefaultMode = getDefaultMode()
        const message =
          configuredDefaultMode === written
            ? `Default Ponytail mode set to ${written}.`
            : `Saved default ${written}, but env override keeps default at ${configuredDefaultMode}.`
        ctx?.ui?.notify?.(message, 'info')
        return
      }
      if (parsed.type === 'set-mode') {
        setMode(parsed.mode, ctx)
        return
      }
      ctx?.ui?.notify?.('Unknown or unsupported /ponytail mode.', 'warning')
    },
  })

  // Deactivation by plain prompt ("stop ponytail" / "normal mode"), same as
  // the upstream pi-extension; extension-sourced inputs are ignored.
  pi.on('input', async (event: unknown) => {
    const e = event as { source?: string; text?: string } | undefined
    if (e?.source === 'extension') return
    if (currentMode !== 'off' && isDeactivationCommand(String(e?.text || ''))) {
      setMode('off', null)
    }
  })

  // Re-resolve the persisted mode whenever the active session changes
  // (switch/branch/tree), not just at session_start — each session stores
  // its own ponytail-mode entry.
  function adoptSession(rawCtx: unknown): void {
    const ctx = rawCtx as PiContext | undefined
    const entries = ctx?.sessionManager?.getBranch?.() || ctx?.sessionManager?.getEntries?.() || []
    configuredDefaultMode = getDefaultMode()
    hideStatus = getHideStatus()
    currentMode = resolveSessionMode(entries, configuredDefaultMode)
    syncStatus(ctx ?? null)
  }

  pi.on('session_start', (_rawEvent, rawCtx) => {
    // adoptSession() already pushes the mode to the status line; no popup.
    adoptSession(rawCtx)
  })

  for (const evt of ['session_switch', 'session_branch', 'session_tree']) {
    pi.on(evt, (_rawEvent, rawCtx) => {
      adoptSession(rawCtx)
    })
  }

  pi.on('agent_start', (_rawEvent, rawCtx) => {
    isActive = true
    syncStatus(rawCtx as PiContext | null)
  })

  pi.on('agent_end', (_rawEvent, rawCtx) => {
    isActive = false
    syncStatus(rawCtx as PiContext | null)
  })

  pi.on('before_agent_start', (rawEvent: unknown) => {
    const event = rawEvent as { systemPrompt: string[] } | undefined
    if (!currentMode || currentMode === 'off') return
    if (!event?.systemPrompt) return
    const block = getPonytailInstructions(currentMode)
    return { systemPrompt: [...event.systemPrompt, block] }
  })
}