#!/usr/bin/env bash
# Sync vendored ponytail from the local Claude Code plugin cache.
# Run after upstream ponytail publishes a new version (and you updated it in
# Claude Code). Then review `git diff` for hook-interface changes, commit, push.
set -euo pipefail
src="${PONYTAIL_INSTALL_PATH:-$HOME/.claude/plugins/cache/ponytail/ponytail}"
v=$(ls "$src" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)
if [ -z "$v" ]; then
  echo "no local ponytail install found under $src" >&2
  exit 1
fi
root="$(cd "$(dirname "$0")/.." && pwd)/ponytail"
cp "$src/$v/hooks/ponytail-config.js" "$root/vendor/ponytail/hooks/"
cp "$src/$v/hooks/ponytail-instructions.js" "$root/vendor/ponytail/hooks/"
cp "$src/$v/skills/ponytail/SKILL.md" "$root/vendor/ponytail/skills/ponytail/SKILL.md"
for s in ponytail ponytail-audit ponytail-debt ponytail-gain ponytail-help ponytail-review; do
  cp "$src/$v/skills/$s/SKILL.md" "$root/skills/$s/SKILL.md"
done
echo "synced ponytail $v"
