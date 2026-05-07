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
- Updated README workflow guidance to run automatically on PR open/reopen/ready-for-review and use `/review` for follow-up passes.
- Added parser, command, and diff line-mapping tests.
- Added CI enforcement for lint, tests, build, and committed bundle drift.
- Added security, contributing, and license documentation.
