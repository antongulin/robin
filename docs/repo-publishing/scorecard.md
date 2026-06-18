# Robin — Repo Readiness Scorecard

Generated via the `repo-publishing-system` skill. Repo type: **public tool repo
(GitHub Action)** with a light **skill overlay** (`skills/robin/`).

State at audit: PUBLIC · v1.4.0 · 2★ · MIT (detected) · homepage robinreview.dev ·
19 topics · issues on · wiki on (empty) · discussions off · secret scan clean.

## Scores (0–10)

| Area | Score | Evidence / blocker |
|---|---|---|
| GitHub SEO / search | **9** | Specific description, 19 topics, homepage set, v1.4.0 release, keyword-rich README. |
| README conversion | **8** | Strong value prop, one-line install, 3-step setup, provider table, troubleshooting. Missing: a real screenshot of a Robin review. |
| LLM discoverability | **6** | Structured headings + AGENTS.md + "For AI coding agents" block. **No `llms.txt`.** |
| Agent readiness | **8** | AGENTS.md with verified commands, do-not-use rules, secrets table, minimal workflow. |
| Skill publishing (overlay) | **5** | `skills/robin/SKILL.md` valid with references, but **no evals**, not surfaced in README, no skills.sh badge/install path. |
| Trust / maintenance | **8** | MIT, CHANGELOG, automated releases, SECURITY, CONTRIBUTING, CI self-test. Missing: issue templates. |
| Monetization / support | **3** | **No author block, no `FUNDING.yml`, no support CTA.** Biggest gap. |
| Safety / privacy | **9** | No `pull_request_target`, permission-checked commands, base-branch config reads, secret warnings, scan clean. |
| Positioning / brand fit | **8** | Clear "Robin Hood of code review — free for everyone"; audience and status obvious. |
| Code completeness / demo | **9** | Working action, 54 tests, CI green, dogfooded on its own PRs, verified installer. |
| CI/CD safety | **8** | Least-privilege perms (`contents: read`, `pull-requests: write`), release automation, concurrency control. |
| GitHub surface hygiene | **5** | Issues on (good), but **empty wiki enabled** and **no issue/PR templates**. |

**Overall: 7.5 / 10** — a strong, safe, well-positioned repo. The gaps are
presentation/community surface, not substance.

## Biggest blockers (highest leverage first)

1. **No support/author path (3).** Add an author block, `.github/FUNDING.yml`, and a
   small "Support / Services" section. Cheap, high-trust.
2. **Empty wiki + no templates (5).** Disable the unused wiki; add issue + PR templates.
3. **Skill not discoverable (5).** Decide: is `skills/robin` a shipped product? If yes,
   add `evals/evals.json`, a README skill section, and the skills.sh badge.
4. **No `llms.txt` (6).** Add a machine-readable summary for AI search / agents.

## Not blockers (already strong — preserve)

Security model, CI safety, test coverage, release automation, positioning, README
quick-start. Do not rewrite these — only additive patches.
