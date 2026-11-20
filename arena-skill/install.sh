#!/usr/bin/env bash
# Install the Agnes video skill into an agent skills directory.
#
#   ./install.sh                 # auto-detect ~/.claude or ~/.codex or ~/.config/agent-skills
#   ./install.sh /path/to/skills # explicit target directory
#
# Safe to re-run: replaces only this skill's own directory. Never touches your
# API key: the key is read from the environment at run time.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="agnes-video"

usage() { sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then usage; exit 0; fi

detect_target() {
  if [[ -n "${1:-}" ]]; then printf '%s\n' "$1"; return; fi
  if [[ -d "$HOME/.claude" ]]; then printf '%s\n' "$HOME/.claude/skills"; return; fi
  if [[ -d "$HOME/.codex" ]]; then printf '%s\n' "$HOME/.codex/skills"; return; fi
  printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/agent-skills"
}

TARGET_ROOT="$(detect_target "${1:-}")"
DEST="$TARGET_ROOT/$SKILL_NAME"

echo "installing $SKILL_NAME"
echo "  from $SRC"
echo "  to   $DEST"

mkdir -p "$TARGET_ROOT"
rm -rf "$DEST"
mkdir -p "$DEST"

for item in SKILL.md plugin.json package.json .claude-plugin bin lib test README.md; do
  [[ -e "$SRC/$item" ]] && cp -R "$SRC/$item" "$DEST/"
done
chmod +x "$DEST/bin/agnes-video.mjs" 2>/dev/null || true

command -v node >/dev/null 2>&1 || { echo "!! node is not installed; the skill needs Node 18+"; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "!! node $NODE_MAJOR found; Node 18+ is required"; exit 1
fi

echo
echo "verify:"
echo "  node $DEST/bin/agnes-video.mjs doctor"
echo
echo "then export your key in the shell that runs generations:"
echo "  export AGNES_API_KEY='...'   # never commit it"
