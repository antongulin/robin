# Robin — Publish / Improvement Plan

Local edits are safe to draft. Public GitHub metadata changes are **review-gated**.

## Local improvements (I can apply on a branch)

| # | Change | Why | Effort |
|---|---|---|---|
| 1 | **`.github/FUNDING.yml`** + README "Support / Services" section + author block | Monetization/support score 3→7; trust signal | S |
| 2 | **`llms.txt`** at repo root | LLM discoverability 6→8; AI-search citable | S |
| 3 | **`.github/ISSUE_TEMPLATE/`** (bug + feature) + **`pull_request_template.md`** | Surface hygiene; guides contributions | S |
| 4 | README **screenshot** of a real Robin review comment (above the fold) | README conversion 8→9 | M (needs an image) |
| 5 | **`skills/robin/evals/evals.json`** + README skill section | Skill publishing 5→8 — only if the skill ships as a product | M |

Suggested author block (from the brand reference):
```md
Built by [Anton Gulin](https://github.com/antongulin), AI Architect building AI
systems, agent workflows, and software automation. Need a custom AI agent skill or
automation? Visit [Anton.QA](https://www.anton.qa).
```

`.github/FUNDING.yml` (fill in real handles before enabling):
```yml
github: [antongulin]
# custom: ["https://www.anton.qa"]
```

## Review-gated GitHub actions (run after approval only)

1. `gh repo edit antongulin/robin --enable-wiki=false`  — drop the empty wiki
2. Description + topics update (see `github-metadata.md`)
3. Optional: `gh repo edit antongulin/robin --enable-discussions=true`

## Decisions (resolved)

- **Skill = internal companion**, not a skills.sh product. It now installs automatically
  with Robin: the one-line installer drops it into `~/.claude/skills/robin` when Claude
  Code is present, and the README documents it. No skills.sh badge or separate evals.
- **Funding: yes** — `.github/FUNDING.yml` points at GitHub Sponsors (`antongulin`) +
  Anton.QA; README has a Support section. ⚠️ The Sponsor button only renders once you
  enable GitHub Sponsors on github.com/sponsors/antongulin.
- **Screenshot:** deferred — Anton will share real Robin review screenshots; add to the
  README above the fold then.

## Applied (this branch)

- `.github/FUNDING.yml`, `llms.txt`, issue templates + config, `pull_request_template.md`
- README: "Robin in your editor" (bundled skill) + "Support" (sponsor + Anton.QA author block)
- `scripts/install.sh`: auto-installs the companion skill (best-effort, Claude Code)

## Not doing (preserve)

No rewrites of README quick-start, security docs, CI, or release automation — all strong.
