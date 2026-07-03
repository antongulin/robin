#!/usr/bin/env bash
#
# Robin skill updater — pulls the latest Robin companion skill into every coding
# agent on this machine (Claude Code, Cursor, Copilot, Windsurf, …).
#
#   bash scripts/update.sh
#
# It only touches the globally-installed `robin` skill via the cross-platform
# skills CLI (https://skills.sh) — the same command the installer uses, which
# knows each agent's skill directory so we don't hard-code any paths here.
# No sudo, no repo changes. The update applies the next time an agent loads the
# skill, not to a run already in progress.
#
set -euo pipefail

REPO_URL="https://github.com/antongulin/robin"

info() { printf '\033[0;32m🏹 %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31m🏹 %s\033[0m\n' "$1" >&2; exit 1; }

command -v npx >/dev/null 2>&1 \
  || die "npx (Node.js) not found — install Node, then re-run, or: npx -y skills add $REPO_URL --skill robin --agent '*' --global --yes"

info "Updating the Robin skill across all coding agents…"
# `skills add` is idempotent — re-adding upgrades an existing install in place.
if npx -y skills add "$REPO_URL" --skill robin --agent '*' --global --yes; then
  info "Done. The new version applies on the next skill run."
else
  die "Update failed. Try manually: npx -y skills add $REPO_URL --skill robin --agent '*' --global --yes"
fi
