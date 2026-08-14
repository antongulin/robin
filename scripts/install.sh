#!/usr/bin/env bash
#
# Robin installer — adds the Robin code-review workflow to the current repo.
#
# From the root of the Git repository you want Robin to review:
#   curl -fsSL https://robinreview.dev/install.sh | bash
#
# It keeps one canonical .github/workflows/robin.yml. Historical Robin workflow
# variants are archived outside the workflows directory so they cannot trigger,
# then the companion skill is installed or updated globally. No sudo required.
# Override the action ref with ROBIN_REF=v1.
#
set -euo pipefail

REF="${ROBIN_REF:-main}"
WORKFLOW_PATH=".github/workflows/robin.yml"
WORKFLOW_DIR=".github/workflows"
ARCHIVE_DIR=".github/robin-workflow-archive"

info() { printf '\033[0;32m🏹 %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33m🏹 %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31m🏹 %s\033[0m\n' "$1" >&2; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "Not a git repository. cd into your repo and run this again."

cd "$(git rev-parse --show-toplevel)"

is_robin_workflow() {
  grep -Eiq '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*antongulin/(robin|universal-code-reviewer)(/\.github/workflows/review\.ya?ml)?@[^[:space:]#]+' "$1"
}

is_robin_source_repository() {
  [ -f package.json ] && grep -Eq '"name"[[:space:]]*:[[:space:]]*"robin-review"' package.json \
    && [ -f action.yml ] \
    && [ -f skills/robin/SKILL.md ] \
    && [ -f .github/workflows/self-test.yml ]
}

# Treat CRLF and LF workflow copies as equivalent across Git configurations.
files_equal() {
  cmp -s <(sed $'s/\r$//' "$1") <(sed $'s/\r$//' "$2")
}

# Locate the single Robin workflow customizations can be preserved from. The canonical
# path wins; otherwise exactly one recognized candidate qualifies (ambiguity preserves
# nothing). Sets ROBIN_WF_SOURCE (path or empty) and ROBIN_WF_COUNT.
scan_robin_workflows() {
  ROBIN_WF_SOURCE=""
  ROBIN_WF_COUNT=0
  if [ -f "$WORKFLOW_PATH" ] && is_robin_workflow "$WORKFLOW_PATH"; then
    ROBIN_WF_SOURCE="$WORKFLOW_PATH"
    ROBIN_WF_COUNT=1
    return 0
  fi
  [ -d "$WORKFLOW_DIR" ] || return 0
  while IFS= read -r candidate; do
    if is_robin_workflow "$candidate"; then
      ROBIN_WF_COUNT=$((ROBIN_WF_COUNT + 1))
      ROBIN_WF_SOURCE="$candidate"
    fi
  done < <(find "$WORKFLOW_DIR" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -print)
  if [ "$ROBIN_WF_COUNT" -gt 1 ]; then ROBIN_WF_SOURCE=""; fi
}
scan_robin_workflows

# Preserve an existing modern Robin ref unless ROBIN_REF explicitly overrides it.
if [ -z "${ROBIN_REF+x}" ]; then
  if [ "$ROBIN_WF_COUNT" -gt 1 ]; then
    warn "Multiple Robin workflows found; using default ref ($REF)."
  elif [ -n "$ROBIN_WF_SOURCE" ]; then
    # Preserve refs only from modern Robin workflows. Legacy Universal Code Reviewer
    # refs (including obsolete v0 tags) intentionally migrate to the current default.
    existing_ref="$(sed -nE 's|^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*antongulin/robin/\.github/workflows/review\.ya?ml@([A-Za-z0-9._/-]+).*|\2|p' "$ROBIN_WF_SOURCE" | head -n 1)"
    if [ -n "$existing_ref" ] && [ "$existing_ref" != "v0" ]; then REF="$existing_ref"; fi
  fi
fi

# Print the job-level `with:` block of a modern reusable-workflow consumer, re-indented
# to the canonical template's 4-space job level. Only a `with:` that is a sibling of the
# `uses: antongulin/robin/.github/workflows/review.yml@...` job key qualifies — a legacy
# step-level `with:` targets the direct action's inputs and must not be carried over.
# Blank lines inside the block are kept (trailing ones dropped); the `with:` key line is
# normalized, so a comment on it is not carried — comments on entry lines are.
extract_with_overrides() {
  sed $'s/\r$//' "$1" | awk '
    function ind(s) { return match(s, /[^ ]/) - 1 }
    function boundary(s, base) {
      return s !~ /^[[:space:]]*$/ && s !~ /^[[:space:]]*#/ && ind(s) < base
    }
    { lines[NR] = $0 }
    END {
      u = 0
      for (i = 1; i <= NR; i++)
        if (lines[i] ~ /^[[:space:]]*uses:[[:space:]]*antongulin\/robin\/\.github\/workflows\/review\.ya?ml@/) { u = i; base = ind(lines[i]); break }
      if (!u) exit
      # Bound the job block holding the Robin uses: key, so a sibling job listed
      # earlier in the file cannot donate its own with: block.
      start = 0
      for (i = u - 1; i >= 1; i--) if (boundary(lines[i], base)) { start = i; break }
      end = NR + 1
      for (i = u + 1; i <= NR; i++) if (boundary(lines[i], base)) { end = i; break }
      w = 0
      for (i = start + 1; i < end; i++)
        if (lines[i] ~ /^[[:space:]]*with:[[:space:]]*(#.*)?$/ && ind(lines[i]) == base) { w = i; break }
      if (!w) exit
      print "    with:"
      blanks = 0
      for (i = w + 1; i < end; i++) {
        if (lines[i] ~ /^[[:space:]]*$/) { blanks++; continue }
        d = ind(lines[i])
        if (d <= base) break
        while (blanks > 0) { print ""; blanks-- }
        printf "%" (4 + d - base) "s%s\n", "", substr(lines[i], d + 1)
      }
    }'
}

case "$REF" in
  *[!A-Za-z0-9._/-]*|'') die "Invalid ROBIN_REF: $REF" ;;
esac

tmp_workflow="$(mktemp)"
trap 'rm -f "$tmp_workflow"' EXIT
# Quoted heredoc: keeps ${{ secrets.* }} literal for GitHub Actions.
cat > "$tmp_workflow" <<'YAML'
# Generated by robin-review. Re-run `npx robin-review` to check for updates.
name: Robin

on:
  pull_request:
    types: [opened, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  actions: read
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
tmp_rendered="$(mktemp)"
tmp_with="$(mktemp)"
tmp_spliced=""
trap 'rm -f "$tmp_workflow" "$tmp_rendered" "$tmp_with" ${tmp_spliced:+"$tmp_spliced"}' EXIT
sed "s|@__REF__|@${REF}|" "$tmp_workflow" > "$tmp_rendered"

# Carry over the consumer's `with:` overrides (e.g. llm-temperature) so re-running the
# installer never silently reverts documented settings.
if [ -n "$ROBIN_WF_SOURCE" ]; then
  extract_with_overrides "$ROBIN_WF_SOURCE" > "$tmp_with"
  if [ -s "$tmp_with" ]; then
    tmp_spliced="$(mktemp)"
    awk -v wf="$tmp_with" '
      { print }
      /^    uses: antongulin\/robin\// && !done {
        while ((getline line < wf) > 0) print line
        done = 1
      }' "$tmp_rendered" > "$tmp_spliced"
    mv "$tmp_spliced" "$tmp_rendered"
    if ! files_equal "$ROBIN_WF_SOURCE" "$tmp_rendered"; then
      info "Preserved existing \`with:\` overrides from $ROBIN_WF_SOURCE."
    fi
  fi
fi

archive_workflow() {
  local source_path="$1" base_name destination suffix=1
  mkdir -p "$ARCHIVE_DIR"
  base_name="$(basename "$source_path")"
  destination="$ARCHIVE_DIR/${base_name}.disabled"
  while [ -f "$destination" ] && ! files_equal "$source_path" "$destination"; do
    destination="$ARCHIVE_DIR/${base_name}.${suffix}.disabled"
    suffix=$((suffix + 1))
  done
  if [ -f "$destination" ]; then
    rm -f "$source_path"
    info "Removed $source_path (identical copy already at $destination)."
  else
    mv "$source_path" "$destination"
    info "Archived $source_path → $destination (cannot trigger in this location)."
  fi
  ARCHIVED_WORKFLOW_COUNT=$((ARCHIVED_WORKFLOW_COUNT + 1))
}

WORKFLOW_CHANGED=0
ARCHIVED_WORKFLOW_COUNT=0
SOURCE_REPOSITORY=0
if is_robin_source_repository; then
  SOURCE_REPOSITORY=1
  warn "Robin source repository detected — leaving its self-test workflows untouched."
  if [ -f "$WORKFLOW_PATH" ] && is_robin_workflow "$WORKFLOW_PATH"; then
    warn "$WORKFLOW_PATH is a redundant consumer workflow; remove it instead of committing it here."
  fi
else
  if [ -f "$WORKFLOW_PATH" ] && ! is_robin_workflow "$WORKFLOW_PATH"; then
    die "$WORKFLOW_PATH exists but is not a Robin workflow. Move or rename it, then run again."
  fi

  canonical_current=0
  if [ -f "$WORKFLOW_PATH" ] && files_equal "$WORKFLOW_PATH" "$tmp_rendered"; then canonical_current=1; fi

  if [ -d "$WORKFLOW_DIR" ]; then
    while IFS= read -r candidate; do
      if is_robin_workflow "$candidate"; then
        if [ "$candidate" = "$WORKFLOW_PATH" ] && [ "$canonical_current" -eq 1 ]; then continue; fi
        archive_workflow "$candidate"
        WORKFLOW_CHANGED=1
      fi
    done < <(find "$WORKFLOW_DIR" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -print)
  fi

  if [ "$canonical_current" -eq 1 ]; then
    info "$WORKFLOW_PATH is already current."
  else
    mkdir -p "$WORKFLOW_DIR"
    mv "$tmp_rendered" "$WORKFLOW_PATH"
    info "Created canonical $WORKFLOW_PATH (ref: ${REF})."
    WORKFLOW_CHANGED=1
  fi
fi

# Install the companion chat skill so any coding agent can automatically drive Robin's
# review loop during ordinary PR work. Uses the cross-platform skills CLI to
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
    info "Robin chat skill installed (all agents). It activates automatically for PR work."
  else
    warn "Couldn't auto-install the skill. Run: npx skills add https://github.com/antongulin/robin --all --global"
  fi
}
install_skill

if [ "$SOURCE_REPOSITORY" -eq 1 ]; then
cat <<EOF

Robin's source repository already reviews itself through Self-Test.
The global companion skill was installed or updated; no consumer workflow is needed here.
EOF
else
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
if [ "$ARCHIVED_WORKFLOW_COUNT" -gt 0 ]; then
  printf '\nInspect .github/robin-workflow-archive, then remove it after confirming the migration.\n'
  printf 'Archived files cannot trigger GitHub Actions from there.\n'
fi
fi
