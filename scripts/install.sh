#!/usr/bin/env bash
#
# Robin installer — adds the Robin code-review workflow to the current repo.
#
#   curl -fsSL https://robinreview.dev/install.sh | bash
#
# It only writes one file (.github/workflows/robin.yml) in your repo and prints
# the next steps. No sudo, no global installs, and it never overwrites an
# existing workflow. Override the action ref with ROBIN_REF=v1.
#
set -euo pipefail

REF="${ROBIN_REF:-main}"
WORKFLOW_PATH=".github/workflows/robin.yml"

info() { printf '\033[0;32m🏹 %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33m🏹 %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31m🏹 %s\033[0m\n' "$1" >&2; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "Not a git repository. cd into your repo and run this again."

cd "$(git rev-parse --show-toplevel)"

if [ -f "$WORKFLOW_PATH" ]; then
  warn "$WORKFLOW_PATH already exists — leaving it untouched."
else
  mkdir -p "$(dirname "$WORKFLOW_PATH")"
  # Quoted heredoc: keeps ${{ secrets.* }} literal for GitHub Actions.
  cat > "$WORKFLOW_PATH" <<'YAML'
name: Robin

on:
  pull_request:
    types: [opened, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@__REF__
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
YAML
  # Substitute the ref after writing so the heredoc stays fully literal.
  # Use a temp file (no .bak left behind) — portable across BSD and GNU sed.
  tmp_workflow="$(mktemp)"
  sed "s|@__REF__|@${REF}|" "$WORKFLOW_PATH" > "$tmp_workflow"
  mv "$tmp_workflow" "$WORKFLOW_PATH"
  info "Created $WORKFLOW_PATH (ref: ${REF})"
fi

# Install the companion chat skill so any coding agent can drive Robin's PR review
# loop from plain chat ("review with Robin"). Uses the cross-platform skills CLI to
# install for every detected agent, globally. Best-effort — the GitHub Action works
# without it. Set ROBIN_SKILL=0 to skip.
install_skill() {
  [ "${ROBIN_SKILL:-1}" = "0" ] && return 0

  if ! command -v npx >/dev/null 2>&1; then
    warn "Skipping companion skill — Node.js/npx not found."
    warn "Install it later: npx skills add https://github.com/antongulin/robin --all --global"
    return 0
  fi

  info "Installing the Robin chat skill for all coding agents…"
  # --agent '*' = every supported agent, --global = user-level (available everywhere).
  if npx -y skills add https://github.com/antongulin/robin --skill robin --agent '*' --global --yes >/dev/null 2>&1; then
    info "Robin chat skill installed (all agents). Say \"review with Robin\"."
  else
    warn "Couldn't auto-install the skill. Run: npx skills add https://github.com/antongulin/robin --all --global"
  fi
}
install_skill

cat <<EOF

Next — set three repository secrets (free OpenRouter shown):

  gh secret set LLM_API_KEY  --body "sk-or-..."                    # your OpenRouter key
  gh secret set LLM_BASE_URL --body "https://openrouter.ai/api/v1"
  gh secret set LLM_MODEL    --body "openrouter/free"

  (no gh CLI? add them at Settings → Secrets and variables → Actions)

Then commit and push:

  git add $WORKFLOW_PATH
  git commit -m "ci: add Robin code review"
  git push

Open a pull request and Robin will review it. Docs: https://robinreview.dev
EOF
