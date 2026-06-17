#!/usr/bin/env bash
set -eo pipefail

ok()  { printf '\033[0;32m✓\033[0m %s\n' "$*"; }
err() { printf '\033[0;31m✗\033[0m %s\n' "$*" >&2; exit 1; }
say() { printf '  %s\n' "$*"; }

printf '\n  Robin — free AI code review\n  ─────────────────────────────────────\n\n'

# Must be inside a GitHub repo
git rev-parse --git-dir > /dev/null 2>&1 || err "Not inside a git repository. Run this from your project root."

REMOTE=$(git remote get-url origin 2>/dev/null || true)
[[ "$REMOTE" == *"github.com"* ]] || err "No GitHub remote found. Robin works with GitHub repositories."

REPO=$(printf '%s' "$REMOTE" | sed -E 's|.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$|\1|')
say "Repository: $REPO"
printf '\n'

# One question
printf '  OpenRouter API key (free at openrouter.ai/keys): '
read -r API_KEY < /dev/tty
printf '\n'
[[ -n "$API_KEY" ]] || err "No key entered."

# Workflow file
mkdir -p .github/workflows
DEST=".github/workflows/robin.yml"

if [[ -f "$DEST" ]]; then
  say "$DEST already exists — skipping."
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd || pwd)"
  LOCAL="$SCRIPT_DIR/../templates/robin.yml"

  if [[ -f "$LOCAL" ]]; then
    cp "$LOCAL" "$DEST"
  else
    curl -fsSL "https://raw.githubusercontent.com/antongulin/robin/main/templates/robin.yml" -o "$DEST"
  fi
  ok "Created $DEST"
fi

# Set secret via gh CLI if available
if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
  if gh secret set LLM_API_KEY --repo "$REPO" --body "$API_KEY" 2>/dev/null; then
    ok "Secret LLM_API_KEY set on $REPO"
  else
    printf '\n'
    say "Could not set secret automatically. Set it manually:"
    say "→ https://github.com/$REPO/settings/secrets/actions/new"
    say "  Name:  LLM_API_KEY"
    say "  Value: (paste your key)"
  fi
else
  printf '\n'
  say "Set your API key as a GitHub secret:"
  say "→ https://github.com/$REPO/settings/secrets/actions/new"
  say "  Name:  LLM_API_KEY"
  say "  Value: (paste your key)"
fi

printf '\n  ─────────────────────────────────────\n'
ok "Done."
printf '\n'
say "Commit and push .github/workflows/robin.yml, then open a PR."
say "Robin reviews it automatically. Comment /review to re-trigger."
printf '\n'
