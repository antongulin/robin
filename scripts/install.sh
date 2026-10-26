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

info() { printf '\033[0;32mRobin: %s\033[0m\n' "$1"; }
warn() { printf '\033[0;33mRobin: %s\033[0m\n' "$1"; }
die()  { printf '\033[0;31mRobin: %s\033[0m\n' "$1" >&2; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "Not a git repository. cd into your repo and run this again."

cd "$(git rev-parse --show-toplevel)"

# Line-aligned structural view, matching the standalone npm reader. Hide comments
# and literal/folded scalar payload, including explicitly indented data tabs.
workflow_structure() {
  sed $'s/\r$//' "$1" | awk '
    function ind(s) { match(s, /[^ ]/); return RSTART ? RSTART - 1 : length(s) }
    BEGIN { scalar_base = -1; single = sprintf("%c", 39) }
    {
      d = ind($0)
      if (scalar_base >= 0) {
        if ($0 ~ /^[[:space:]]*$/) { print ""; next }
        if (!scalar_indent && d > scalar_base) scalar_indent = d
        if (scalar_indent && d >= scalar_indent) { print ""; next }
        scalar_base = -1
      }
      quote = ""; code = $0
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (quote != "") {
          if (quote == "\"" && c == "\\") i++
          else if (c == quote) {
            if (quote == single && substr($0, i + 1, 1) == single) i++
            else quote = ""
          }
        } else if (c == "\"" || c == single) quote = c
        else if (c == "#" && (i == 1 || substr($0, i - 1, 1) ~ /[[:space:]]/)) { code = substr($0, 1, i - 1); break }
      }
      if (code ~ /: *[|>]([1-9][+-]?|[+-][1-9]?)? *$/) {
        scalar_base = d
        if (match(code, /^ *- +/)) scalar_base = RLENGTH
        header = code; sub(/^.*[|>]/, "", header)
        scalar_indent = match(header, /[1-9]/) ? scalar_base + substr(header, RSTART, 1) : 0
      }
      print code
    }'
}

is_robin_workflow() {
  workflow_structure "$1" | grep -Ei '^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*antongulin/(robin|universal-code-reviewer)(/\.github/workflows/review\.ya?ml)?@[^[:space:]#]+' >/dev/null
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
# path wins; otherwise exactly one recognized candidate qualifies. Modern ambiguity
# is handled by the no-write preflight below. Sets ROBIN_WF_SOURCE (path or empty) and ROBIN_WF_COUNT.
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

# Custom identity can depend on steps, jobs and inherited secrets. Preserve the whole
# workflow set rather than rebuilding a partial configuration or adding a duplicate.
CUSTOM_IDENTITY=0
if [ -d "$WORKFLOW_DIR" ]; then
  while IFS= read -r candidate; do
    if grep -Eiq 'antongulin/robin(/\.github/workflows/review\.ya?ml)?@' "$candidate" \
      && { tr '\r\n' '  ' < "$candidate" | LC_ALL=C grep -Eq "(^|[^[:alnum:]_])(ROBIN_TOKEN|github-token)[\"']?[[:space:]]*:|(^|[^[:alnum:]_])secrets[\"']?[[:space:]]*:[[:space:]]*[\"']?inherit([^[:alnum:]_]|$)|uses:[[:space:]]*actions/create-github-app-token@"; }; then
      CUSTOM_IDENTITY=1
    fi
  done < <(find "$WORKFLOW_DIR" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -print)
fi

# Preserve an existing modern Robin ref unless ROBIN_REF explicitly overrides it.
if [ -z "${ROBIN_REF+x}" ]; then
  if [ "$ROBIN_WF_COUNT" -gt 1 ]; then
    warn "Multiple Robin workflows found; using default ref ($REF)."
  elif [ -n "$ROBIN_WF_SOURCE" ]; then
    # Preserve refs only from modern Robin workflows. Legacy Universal Code Reviewer
    # refs (including obsolete v0 tags) intentionally migrate to the current default.
    existing_ref="$(workflow_structure "$ROBIN_WF_SOURCE" | sed -nE 's|^[[:space:]]*(-[[:space:]]*)?uses:[[:space:]]*antongulin/robin/\.github/workflows/review\.ya?ml@([A-Za-z0-9._/-]+).*|\2|p' | head -n 1)"
    if [ -n "$existing_ref" ] && [ "$existing_ref" != "v0" ]; then REF="$existing_ref"; fi
  fi
fi

# Like the standalone npm reader, accept ordinary block YAML only. Exit 2 before
# archival when settings cannot be preserved safely; never guess a donor or drop inputs.
DEFAULT_RUNNER=$(cat <<'YAML'
      runner: ${{ github.repository_owner == 'antongulin' && '"ubicloud-standard-2"' || '"ubuntu-latest"' }}
YAML
)
extract_with_overrides() {
  # mode 1 detects modern calls; mode 2 checks an explicit runner after validation.
  awk -v runner="$DEFAULT_RUNNER" -v ref="$REF" -v mode="${2:-0}" '
    function ind(s) { match(s, /[^ ]/); return RSTART ? RSTART - 1 : length(s) }
    function content(s) { return s !~ /^[[:space:]]*(#|$)/ }
    function pads(n, s) { s = ""; while (n-- > 0) s = s " "; return s }
    NR == FNR { structure[FNR] = $0; next }
    { sub(/\r$/, ""); lines[FNR] = $0; count = FNR }
    END {
      for (i = 1; i <= count; i++) {
        if (content(structure[i]) && structure[i] ~ /^ *\t/) bad = 1
        if (match(structure[i], /(^|[{},])[ \t]*(-[ \t]*)?["\047]?uses["\047]?[ \t]*:/)) {
          value = substr(structure[i], RSTART + RLENGTH); sub(/^[ \t]*/, "", value)
          found = value ~ /antongulin\/robin\/\.github\/workflows\/review\.ya?ml@/
          # Check only continuations of an unsupported uses value, not siblings.
          if (!found && (value == "" || value ~ /^["\047|>&*!]/)) {
            for (j = i + 1; j <= count; j++) {
              continuation = value ~ /^[|>]/ ? lines[j] : structure[j]
              if (continuation ~ /^[[:space:]]*$/) continue
              if (ind(lines[j]) <= ind(lines[i])) break
              if (continuation ~ /antongulin\/robin\/\.github\/workflows\/review\.ya?ml@/) { found = 1; break }
            }
          }
          if (found) { u = i; refs++ }
        }
      }
      if (mode == 1) exit !refs
      if (!refs) {
        if (mode == 2) exit 1
        if (ref == "main") { print "    with:"; print runner }
        exit
      }
      if (bad || refs != 1 || lines[u] !~ /^ +uses: *antongulin\/robin\/\.github\/workflows\/review\.ya?ml@[A-Za-z0-9._\/-]+ *(#.*)?$/) exit 2
      base = ind(lines[u])
      start = u - 1
      while (start > 0 && (!content(lines[start]) || ind(lines[start]) >= base)) start--
      end = u + 1
      while (end <= count && (!content(lines[end]) || ind(lines[end]) >= base)) end++
      if (!start || lines[start] !~ /^ +[A-Za-z0-9_-]+: *(#.*)?$/) exit 2
      parent = start - 1
      while (parent > 0 && (!content(lines[parent]) || ind(lines[parent]) >= ind(lines[start]))) parent--
      if (!parent || lines[parent] !~ /^jobs: *(#.*)?$/) exit 2
      for (i = start + 1; i < end; i++) {
        if (!content(lines[i]) || ind(lines[i]) != base) continue
        if (lines[i] !~ /^ *[A-Za-z0-9_-]+:/) exit 2
        if (lines[i] ~ /^ *with:/) { w = i; nw++ }
      }
      if (nw > 1 || (w && lines[w] !~ /^ *with: *(#.*)?$/)) exit 2
      if (!w) {
        if (mode == 2) exit 1
        if (ref == "main") { print "    with:"; print runner }
        exit
      }
      stop = w + 1
      while (stop < end && (!content(structure[stop]) || ind(structure[stop]) > base)) stop++
      last = stop - 1
      # Do not trim trailing blanks/comments: they can be literal |+ scalar data.
      entry_indent = 999999
      for (i = w + 1; i <= last; i++)
        if (content(structure[i]) && ind(structure[i]) < entry_indent) entry_indent = ind(structure[i])
      if (entry_indent == 999999) entry_indent = base + 2
      for (i = w + 1; i <= last; i++) {
        if (content(structure[i]) && substr(structure[i], ind(structure[i]) + 1) ~ /^[&*!]/) exit 2
        if (!content(structure[i]) || ind(structure[i]) != entry_indent) continue
        entry = substr(structure[i], entry_indent + 1)
        if (entry !~ /^[A-Za-z0-9_-]+:([[:space:]]|$)/) exit 2
        key = entry; sub(/:.*/, "", key)
        if (seen[key]++) exit 2
        value = entry; sub(/^[^:]+:[[:space:]]*/, "", value)
        if (value ~ /^[&*!{[]/) exit 2
        keys++
      }
      if (mode == 2) exit !seen["runner"]
      if (!keys && ref != "main") exit
      print "    " substr(lines[w], base + 1)
      for (i = w + 1; i <= last; i++) {
        if (lines[i] == "") { print ""; continue }
        d = ind(lines[i]); p = 4 + d - base; if (p < 0) p = 0
        print pads(p) substr(lines[i], d + 1)
      }
      if (!seen["runner"] && ref == "main") print pads(4 + entry_indent - base) substr(runner, 7)
    }' <(workflow_structure "$1") "$1"
}

has_modern_caller() { extract_with_overrides "$1" 1 >/dev/null; }

# Preflight the complete workflow set before any rename/write. A canonical donor wins;
# without one, multiple modern candidates are ambiguous even with ROBIN_REF specified.
PRESERVATION_ERROR=0
if [ -d "$WORKFLOW_DIR" ]; then
  while IFS= read -r candidate; do
    if has_modern_caller "$candidate"; then
      if ! is_robin_workflow "$candidate" || ! extract_with_overrides "$candidate" >/dev/null; then
        PRESERVATION_ERROR=1
      fi
      if [ "$ROBIN_WF_COUNT" -gt 1 ] && [ -z "$ROBIN_WF_SOURCE" ]; then PRESERVATION_ERROR=1; fi
    fi
  done < <(find "$WORKFLOW_DIR" -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) -print)
fi

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

# Merge into one with mapping. The template has no with key here; this splice
# supplies preserved entries, adding a missing runner only for effective main.
if [ "$PRESERVATION_ERROR" -eq 0 ]; then
  if [ -n "$ROBIN_WF_SOURCE" ]; then
    extract_with_overrides "$ROBIN_WF_SOURCE" > "$tmp_with"
  elif [ "$REF" = "main" ]; then
    printf '    with:\n%s\n' "$DEFAULT_RUNNER" > "$tmp_with"
  fi
  tmp_spliced="$(mktemp)"
  awk -v wf="$tmp_with" '
    { print }
    /^    uses: antongulin\/robin\// && !done {
      while ((getline line < wf) > 0) print line
      done = 1
    }' "$tmp_rendered" > "$tmp_spliced"
  mv "$tmp_spliced" "$tmp_rendered"
  if [ -n "$ROBIN_WF_SOURCE" ] && ! files_equal "$ROBIN_WF_SOURCE" "$tmp_rendered"; then
    info "Preserved existing \`with:\` overrides from $ROBIN_WF_SOURCE."
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
elif [ "$CUSTOM_IDENTITY" -eq 1 ]; then
  warn "Preserved custom identity workflows; no workflow files were changed or archived."
  warn "Update workflow refs/settings manually, including any requested ROBIN_REF override."
elif [ "$PRESERVATION_ERROR" -eq 1 ]; then
  warn "Preserved workflows: unsupported customization or ambiguous modern donors; no workflow files were changed or archived. Update settings manually."
else
  if [ "$REF" != "main" ] && { [ -z "$ROBIN_WF_SOURCE" ] || ! extract_with_overrides "$ROBIN_WF_SOURCE" 2 >/dev/null; }; then
    warn "Ref $REF was not given a runner input; check its declared inputs and repair the pin/runner routing manually."
  fi
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
elif [ "$CUSTOM_IDENTITY" -eq 1 ]; then
  info "Keep your existing token setup. Docs: https://github.com/antongulin/robin/blob/main/docs/ADVANCED.md#custom-review-identity"
elif [ "$PRESERVATION_ERROR" -eq 1 ]; then
  info "Review the existing workflow settings manually before rerunning the installer."
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
