# Robin 1.0 — Roadmap

Goal: turn the strong v0.x foundation into a standout, contribution-ready OSS code
reviewer that runs at $0 (BYOK + free OpenRouter + free GitHub Actions minutes),
stays robust even when a weak free model is randomly routed, and is invokable by
any agent from plain chat ("review this PR with Robin").

No rewrite. This is a focused 1.0 polish across five phases. Ship phases in order;
each is independently shippable.

---

## Design principles (apply to every phase)

1. **Protect the wedge.** Zero marginal cost, zero lock-in, runs in the user's own
   repo. Never add anything that requires a hosted service or a paid tier.
2. **Assume the model is weak and random.** Every prompt/scaffolding decision is
   judged by: does it make a dumb, rotating free model produce a *consistent, low-noise*
   review? Robustness > cleverness.
3. **"Robin" is the universal trigger verb.** Same word in three places:
   - chat coding agents → a skill named `robin`
   - GitHub PR → `/robin` slash command (already exists)
   - bot output → comments headed `## 🤖 Robin`
   Consistency is the discoverability strategy. A weak agent only has to learn one word.
4. **Comments are suggestions, not orders.** The implementing agent is often smarter
   than the reviewer model. It verifies before fixing and fixes only real bugs.

---

## Phase 0 — Brand & trigger consistency (foundation, no behavior change)

The keyword that makes Robin discoverable everywhere.

- [ ] Lock `robin` as the canonical name. Skill name, slash command, comment header,
      domain all say "Robin."
- [ ] Skill `description` frontmatter packed with natural-language triggers so any
      agent maps plain phrases to the skill. Cover: `review with Robin`, `run Robin`,
      `Robin review`, `create a PR with Robin`, `ask Robin to review`, `robin this PR`,
      plus generic `review my pull request`, `fix PR feedback`, `wait for review`.
- [ ] Decide skill home: **source of truth inside this repo** under `skills/robin/`,
      published to skills.sh as `robin` for registry discovery. Action + driver-skill
      version together.
- [ ] Clear leftover old-brand strings from live config (not history): `ucr-`
      concurrency group in `.github/workflows/review.yml`, any `Universal Code Reviewer`
      reference in the skill's started-signal list → `Robin`.

Acceptance: typing "review this PR with Robin" in Claude Code / Cursor reliably loads
the skill; `/robin` on a GitHub PR works; no live string still says the old name.

---

## Phase 1 — Engine robustness (the quality core)

Highest-leverage work. Each item makes a weak model better. In priority order.

- [x] **Line-numbered diff payload.** `diff-annotate.ts` prefixes each added/context line
      with its real new-file line number; `buildReviewInput` + the prompt tell the model to
      copy those exact numbers. Stops findings from falling out of inline placement.
- [x] **Few-shot calibration.** Severity-calibration block (HIGH/MEDIUM/LOW/SUGGESTION
      examples) added to the prompt, plus an explicit "impact ≠ confidence; never inflate
      severity" rule.
- [x] **`confidence` field** (`high|medium|low`) per finding — added to `ReviewFinding`,
      parser (`asConfidence`, ignores invalid values), JSON contract, and surfaced in the
      inline comment header so the loop skill can read it.
- [x] **"You only see the diff" guard** in the prompt.
- [x] **Unify category enum.** Added `performance` and `docs` as dimensions 7–8 to match
      the `category` enum.
- [x] Tests: diff annotation (4 cases) + confidence parsing. Full suite 54 green.

Acceptance: on a fixed sample PR, inline-comment placement rate and severity stability
improve across at least 3 different free models; no regression in the markdown fallback.

---

## Phase 2 — The `robin` skill (the loop), inside the repo

Fold the `gh-review-loop` skill in, renamed and tightened per the conversation.

- [x] Created `skills/robin/SKILL.md` with `references/lessons-learned.md` and
      `references/github-pr-api-reference.md`. Source of truth now lives in this repo.
- [x] **Bounded loop — max 5 iterations.** Dedicated section + counter; on the ceiling,
      fix remaining verified bugs, reply/resolve, green-light, merge. "Endless re-review
      loop" added to lessons-learned.
- [x] **Verify-don't-obey classification.** Rewrote the Classify step: comments are
      suggestions not orders; fix only verified LEGIT findings; severity/`confidence` are
      hints not proof; suggestions optional; reply-with-reason on NOISE; never invent a fix.
- [x] **Robin signal names.** Started-signal detection watches for `🏹 Robin` /
      `:bow_and_arrow: Robin` and the new status-comment phrasing; commands use `/robin`.
- [x] Kept the proven GitHub mechanics (GraphQL thread state, per-comment replies, stale
      `reviewDecision` handling, INFRA-rerun-before-`/robin`).

Acceptance: skill triggers from plain chat, runs the loop, never exceeds 5 passes,
documents in its final report how many findings it fixed vs. skipped-as-noise and why.

---

## Phase 3 — Structural polish / 1.0 cleanup (breaking → major bump)

Not a mess, but these inconsistencies make it feel unfinished.

- [ ] Unify `max-comments` default (currently `25` in `action.yml` vs `10` in
      `review.yml`). Pick one (recommend 10–15).
- [ ] Drop dead input aliases: `api-key`/`base-url`/`fail-on-critical`. Keep one
      canonical name each (`llm-api-key`, `llm-base-url`, `fail-on-high`). Breaking →
      land in the major bump with a migration note.
- [ ] Standardize the consumer workflow filename to `robin.yml` across README, AGENTS.md,
      and `templates/` (README currently says `code-review.yml`).
- [ ] Sweep remaining old-brand live strings; leave CHANGELOG history untouched.

Acceptance: one config name per concept; docs and templates agree on every filename.

---

## Phase 4 — Release, docs, contribution-readiness

- [ ] README: add the chat usage path ("review this PR with Robin" + how to install the
      skill) alongside the existing GitHub setup.
- [ ] Document the model-robustness design (why line numbers, few-shot, confidence) so
      contributors understand the constraints.
- [ ] CONTRIBUTING: how to test prompt changes against multiple free models.
- [ ] Version bump (major), CHANGELOG, tag `@v1`; verify `@v1` / `@v1.0.0` pins work.
- [ ] **Host the installer.** `scripts/install.sh` exists and is tested. Before the
      `curl … robinreview.dev/install.sh | bash` one-liner works publicly, `robinreview.dev`
      must serve/redirect `/install.sh` to the repo raw file
      (`raw.githubusercontent.com/antongulin/robin/main/scripts/install.sh`). Until then the
      raw URL is the working fallback.

Acceptance: a new user goes from zero to a working review via either path (GitHub setup
or chat) using only the README; a contributor can run the test suite and understand the
robustness rules.

---

## Sequencing

Phase 0 → 1 → 2 can each ship as their own PR. Phase 3 is breaking, so it batches into
the major release with Phase 4. Recommended order of work: **0, 1, 2, 3, 4.**
