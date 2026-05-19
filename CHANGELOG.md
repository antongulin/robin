# Changelog

## Unreleased

- Added `.github/universal-code-reviewer.yml` repo config (skip paths, defaults for diff size, comments, JSON mode).
- Added diff pre-filter for lockfiles (npm, yarn, pnpm, Cargo, Gemfile, poetry), `dist/`, `node_modules/`, and minified assets.
- Added tested `shouldRetryStructuredReview` helper for JSON parse retry.
- Added JSON response mode, resolved-model logging, and one retry when structured parse is empty.
- Added workflow concurrency to cancel duplicate reviews on the same PR.
- Simplified README for beginners; moved advanced docs to `docs/ADVANCED.md`.
- Added `AGENTS.md` and agent skills requiring `@main` (not `@v0`).

## 0.2.0

- Added strict JSON review parsing with markdown fallback.
- Added maintainer-only slash command authorization.
- Added repository-specific reviewer instructions via `.github/code-reviewer.md` or `review-instructions`.
- Added pagination for pull request file lists.
- Preserved findings that cannot be posted inline in the review body.
- Switched inline review comments from deprecated diff `position` coordinates to `line`/`side` comments and added a summary-only fallback when GitHub rejects inline coordinates.
- Added clear review flow status comments that are updated with `I found N issues` or `I did not find any issues`.
- Added `review-on-synchronize`, defaulting to `false`, so pushes to existing PRs do not trigger repeated LLM reviews unless explicitly enabled.
- Added a reusable workflow wrapper at `.github/workflows/review.yml` so consuming repositories can use a much smaller setup file.
- Exposed common cost and behavior controls through the reusable workflow.
- Added low-cost setup guidance, non-technical secret setup steps, and an AI-agent prompt for generating the workflow file.
- Added stronger Universal Code Reviewer branding in status, summary, review, and inline comment bodies.
- Tuned the default review prompt to stay balanced, project-context aware, and avoid noisy findings on generated or formatting-only changes.
- Documented default review behavior, low-cost diff-size tradeoffs, timeout coordination, and SHA-pinning tradeoffs for the reusable workflow.
- Updated README workflow guidance to run automatically on PR open/reopen/ready-for-review, use `/review` for follow-up passes, gate comment-triggered jobs by trusted author association, and set `timeout-minutes`.
- Clarified that the action fetches PR diffs via GitHub API, so `actions/checkout` does not need the PR ref unless other workflow steps use local files.
- Added parser, command, and diff line-mapping tests.
- Added CI enforcement for lint, tests, build, and committed bundle drift.
- Added security, contributing, and license documentation.
