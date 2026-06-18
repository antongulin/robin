# Robin — GitHub Metadata Plan

> All `gh` commands here are **review-gated** — run after approval only.

## Current (at audit)

- **Description:** "Robin - free AI code reviews for every PR. BYOK, works with OpenRouter free tier. Auto-reviews on open, /robin or /review on demand. No quotas." (good, < 350 chars)
- **Homepage:** https://www.robinreview.dev ✓
- **Topics (19):** ai-code-review, artificial-intelligence, automation, bot, byok, ci-cd, claude, code-review, developer-tools, devtools, free, github-actions, llm, open-source, openai, openrouter, pull-request, pull-request-review, robin
- **Wiki:** enabled but empty · **Discussions:** off · **Issues:** on

## Recommended changes

**Description** — minor tighten to lead with the keyword + the wedge:
> Free AI code reviews on every pull request. Bring your own key (OpenRouter free tier works), runs in your repo as a GitHub Action — no quotas, no per-seat fees. `/robin` to review.

**Topics** — current set is strong. Optional swap: drop the vague `free`/`devtools`
duplication, add competitive/discovery terms `coderabbit-alternative`,
`ai-pr-review`, `code-review-bot` (GitHub cap is 20).

**Disable the empty wiki** (surface hygiene):
```bash
# Run after review only
gh repo edit antongulin/robin --enable-wiki=false
```

**Optional — enable Discussions** for a free OSS support channel:
```bash
# Run after review only
gh repo edit antongulin/robin --enable-discussions=true
```

**Description update:**
```bash
# Run after review only
gh repo edit antongulin/robin \
  --description "Free AI code reviews on every pull request. Bring your own key (OpenRouter free tier works), runs in your repo as a GitHub Action — no quotas, no per-seat fees." \
  --add-topic coderabbit-alternative --add-topic ai-pr-review --add-topic code-review-bot
```

## Skill overlay (skills/robin) — internal companion, auto-installed

The skill ships with Robin and installs automatically via the one-line installer (and is
documented in the README). Not marketed as a standalone skills.sh product.

- Install (all agents, global): `npx skills add https://github.com/antongulin/robin --all --global`
- Verified: the skills CLI resolves `skills/robin/` from the repo ("Found 1 skill: robin").
- skills.sh listing is telemetry-driven; it will appear after real installs. No badge needed
  unless we later decide to promote it as a standalone pack.
