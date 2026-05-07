# Changelog

## 0.2.0

- Added strict JSON review parsing with markdown fallback.
- Added maintainer-only slash command authorization.
- Added repository-specific reviewer instructions via `.github/code-reviewer.md` or `review-instructions`.
- Added pagination for pull request file lists.
- Preserved findings that cannot be posted inline in the review body.
- Switched inline review comments from deprecated diff `position` coordinates to `line`/`side` comments and added a summary-only fallback when GitHub rejects inline coordinates.
- Added clear review flow status comments that are updated with `I found N issues` or `I did not find any issues`.
- Added `review-on-synchronize`, defaulting to `false`, so pushes to existing PRs do not trigger repeated LLM reviews unless explicitly enabled.
- Updated README workflow guidance to run automatically on PR open/reopen/ready-for-review, use `/review` for follow-up passes, gate comment-triggered jobs by trusted author association, and set `timeout-minutes`.
- Clarified that the action fetches PR diffs via GitHub API, so `actions/checkout` does not need the PR ref unless other workflow steps use local files.
- Added parser, command, and diff line-mapping tests.
- Added CI enforcement for lint, tests, build, and committed bundle drift.
- Added security, contributing, and license documentation.
