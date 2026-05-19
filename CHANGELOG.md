# Changelog

## [1.3.0](https://github.com/antongulin/universal-code-reviewer/compare/v1.2.0...v1.3.0) (2026-05-19)


### Features

* configurable LLM timeout with 10-minute default ([7b48945](https://github.com/antongulin/universal-code-reviewer/commit/7b48945a01b43574d54d35d73ef142c85d83a55c))
* configurable LLM timeout with 10-minute default ([4f50e51](https://github.com/antongulin/universal-code-reviewer/commit/4f50e5114ed7abdeb23861e74bb687674d7b8c5b))
* harden core reviewer and add tests ([c3e7380](https://github.com/antongulin/universal-code-reviewer/commit/c3e7380ef9a19b5cd52bd9a7c0dea7fe7ea09637))
* improve review rerun flow ([9ae3e67](https://github.com/antongulin/universal-code-reviewer/commit/9ae3e677a2c4a32ac3a359f8d82f3efd8f8ef743))
* stronger review output, failure UX, and eyes reaction ([f60b881](https://github.com/antongulin/universal-code-reviewer/commit/f60b881891bf56f6b92960121c2b1bd5b19e358e))
* support configurable review runner ([5f8cbdc](https://github.com/antongulin/universal-code-reviewer/commit/5f8cbdc9bde040d924efb6fd9269d64760472a68))
* v1 config, diff filter, JSON mode, simpler docs ([#7](https://github.com/antongulin/universal-code-reviewer/issues/7)) ([64f97f4](https://github.com/antongulin/universal-code-reviewer/commit/64f97f4089a7bf28aab8189811191abc421a01d4))


### Bug Fixes

* address reviewer flow feedback ([c568a35](https://github.com/antongulin/universal-code-reviewer/commit/c568a35d92510ffea712fdba1431340713ac05d9))
* auto-retry LLM completions on empty or transient errors ([c22bb05](https://github.com/antongulin/universal-code-reviewer/commit/c22bb05bb5da004c7f30ea65665ab169d8618d36))
* avoid unnecessary PR API call and gracefully handle missing permissions ([#1](https://github.com/antongulin/universal-code-reviewer/issues/1)) ([feff466](https://github.com/antongulin/universal-code-reviewer/commit/feff4664561e6ac6ab889b90a140f5809c1efa60))
* Bundle action as single dist/index.js for GitHub Actions ([bfb2287](https://github.com/antongulin/universal-code-reviewer/commit/bfb228710c5fbe79a4a5e1df4ac43e20e771c4c9))
* handle empty LLM responses and soften self-test flakes ([e8502dc](https://github.com/antongulin/universal-code-reviewer/commit/e8502dc931ee15319969edc7cad1f8648d0d1c88))
* minimize workflow permissions and tighten trigger conditions ([bdb75cd](https://github.com/antongulin/universal-code-reviewer/commit/bdb75cdca23f3cd47500f909640d856cdb6a1ccd))
* support openrouter/free rotation without updating secrets ([f31aa2d](https://github.com/antongulin/universal-code-reviewer/commit/f31aa2d548f31f034bdba152c1258a700a1eacaf))
* support openrouter/free rotation without updating secrets ([4ec28ec](https://github.com/antongulin/universal-code-reviewer/commit/4ec28ecb18510d649fcfebf287d54a332e6ef5af))
* use [@main](https://github.com/main) instead of [@v0](https://github.com/v0) for the action reference ([a45770d](https://github.com/antongulin/universal-code-reviewer/commit/a45770d08c284af10d0239dafd8d101a2acea759))


### Documentation

* Add plain-English architecture explanation for non-technical users ([d238d89](https://github.com/antongulin/universal-code-reviewer/commit/d238d89311bad614d95b80c47572e623cce880f8))
* Add v0.1.0 changelog and v0.2.0 roadmap ([ba4c70c](https://github.com/antongulin/universal-code-reviewer/commit/ba4c70c14f5e42f0e5efaf0bccd4127258dc9be2))
* clarify setup and review limits ([287230b](https://github.com/antongulin/universal-code-reviewer/commit/287230be775d6f17ef0e830f74c4a8eae0193d1b))
* explain reviewer workflow and slash commands ([098fb90](https://github.com/antongulin/universal-code-reviewer/commit/098fb9019a1a2142507f016b6468c3afbd83b479))
* explain self-hosted runner usage ([0c5776e](https://github.com/antongulin/universal-code-reviewer/commit/0c5776ed7b5d6593fb2656400767d2ab2256816f))
* minimize workflow permissions and tighten trigger conditions ([6af07c6](https://github.com/antongulin/universal-code-reviewer/commit/6af07c6f3e667270307806464258e063e7162c11))
* move AI agent setup prompt higher in README ([fa1029e](https://github.com/antongulin/universal-code-reviewer/commit/fa1029e2b62241315c63e74ab1958e174c28b8d8))
* move AI agent setup prompt higher in README ([3a9b25c](https://github.com/antongulin/universal-code-reviewer/commit/3a9b25c66d4bad92849c621617ac95a5a9c62009))
* note Actions PR permission for Release Please ([e922459](https://github.com/antongulin/universal-code-reviewer/commit/e922459854f117dd2d7a8feb3e04be27db439ae5))
* tighten reviewer workflow guidance ([683219a](https://github.com/antongulin/universal-code-reviewer/commit/683219a1c1b21364924aa0d82cfe948143911d9b))

## [1.2.0](https://github.com/antongulin/universal-code-reviewer/compare/v1.1.2...v1.2.0) (2026-05-19)


### Features

* support configurable review runner ([5f8cbdc](https://github.com/antongulin/universal-code-reviewer/commit/5f8cbdc9bde040d924efb6fd9269d64760472a68))


### Documentation

* explain self-hosted runner usage ([0c5776e](https://github.com/antongulin/universal-code-reviewer/commit/0c5776ed7b5d6593fb2656400767d2ab2256816f))

## [1.1.2](https://github.com/antongulin/universal-code-reviewer/compare/v1.1.1...v1.1.2) (2026-05-19)


### Bug Fixes

* support openrouter/free rotation without updating secrets ([f31aa2d](https://github.com/antongulin/universal-code-reviewer/commit/f31aa2d548f31f034bdba152c1258a700a1eacaf))
* support openrouter/free rotation without updating secrets ([4ec28ec](https://github.com/antongulin/universal-code-reviewer/commit/4ec28ecb18510d649fcfebf287d54a332e6ef5af))

## [1.1.1](https://github.com/antongulin/universal-code-reviewer/compare/v1.1.0...v1.1.1) (2026-05-19)


### Bug Fixes

* auto-retry LLM completions on empty or transient errors ([c22bb05](https://github.com/antongulin/universal-code-reviewer/commit/c22bb05bb5da004c7f30ea65665ab169d8618d36))

## [1.1.0](https://github.com/antongulin/universal-code-reviewer/compare/v1.0.0...v1.1.0) (2026-05-19)


### Features

* configurable LLM timeout with 10-minute default ([7b48945](https://github.com/antongulin/universal-code-reviewer/commit/7b48945a01b43574d54d35d73ef142c85d83a55c))
* configurable LLM timeout with 10-minute default ([4f50e51](https://github.com/antongulin/universal-code-reviewer/commit/4f50e5114ed7abdeb23861e74bb687674d7b8c5b))
* harden core reviewer and add tests ([c3e7380](https://github.com/antongulin/universal-code-reviewer/commit/c3e7380ef9a19b5cd52bd9a7c0dea7fe7ea09637))
* improve review rerun flow ([9ae3e67](https://github.com/antongulin/universal-code-reviewer/commit/9ae3e677a2c4a32ac3a359f8d82f3efd8f8ef743))
* stronger review output, failure UX, and eyes reaction ([f60b881](https://github.com/antongulin/universal-code-reviewer/commit/f60b881891bf56f6b92960121c2b1bd5b19e358e))
* v1 config, diff filter, JSON mode, simpler docs ([#7](https://github.com/antongulin/universal-code-reviewer/issues/7)) ([64f97f4](https://github.com/antongulin/universal-code-reviewer/commit/64f97f4089a7bf28aab8189811191abc421a01d4))


### Bug Fixes

* address reviewer flow feedback ([c568a35](https://github.com/antongulin/universal-code-reviewer/commit/c568a35d92510ffea712fdba1431340713ac05d9))
* avoid unnecessary PR API call and gracefully handle missing permissions ([#1](https://github.com/antongulin/universal-code-reviewer/issues/1)) ([feff466](https://github.com/antongulin/universal-code-reviewer/commit/feff4664561e6ac6ab889b90a140f5809c1efa60))
* Bundle action as single dist/index.js for GitHub Actions ([bfb2287](https://github.com/antongulin/universal-code-reviewer/commit/bfb228710c5fbe79a4a5e1df4ac43e20e771c4c9))
* handle empty LLM responses and soften self-test flakes ([e8502dc](https://github.com/antongulin/universal-code-reviewer/commit/e8502dc931ee15319969edc7cad1f8648d0d1c88))
* minimize workflow permissions and tighten trigger conditions ([bdb75cd](https://github.com/antongulin/universal-code-reviewer/commit/bdb75cdca23f3cd47500f909640d856cdb6a1ccd))
* use [@main](https://github.com/main) instead of [@v0](https://github.com/v0) for the action reference ([a45770d](https://github.com/antongulin/universal-code-reviewer/commit/a45770d08c284af10d0239dafd8d101a2acea759))


### Documentation

* Add plain-English architecture explanation for non-technical users ([d238d89](https://github.com/antongulin/universal-code-reviewer/commit/d238d89311bad614d95b80c47572e623cce880f8))
* Add v0.1.0 changelog and v0.2.0 roadmap ([ba4c70c](https://github.com/antongulin/universal-code-reviewer/commit/ba4c70c14f5e42f0e5efaf0bccd4127258dc9be2))
* clarify setup and review limits ([287230b](https://github.com/antongulin/universal-code-reviewer/commit/287230be775d6f17ef0e830f74c4a8eae0193d1b))
* explain reviewer workflow and slash commands ([098fb90](https://github.com/antongulin/universal-code-reviewer/commit/098fb9019a1a2142507f016b6468c3afbd83b479))
* minimize workflow permissions and tighten trigger conditions ([6af07c6](https://github.com/antongulin/universal-code-reviewer/commit/6af07c6f3e667270307806464258e063e7162c11))
* note Actions PR permission for Release Please ([e922459](https://github.com/antongulin/universal-code-reviewer/commit/e922459854f117dd2d7a8feb3e04be27db439ae5))
* tighten reviewer workflow guidance ([683219a](https://github.com/antongulin/universal-code-reviewer/commit/683219a1c1b21364924aa0d82cfe948143911d9b))

## [Unreleased]

## [1.0.0](https://github.com/antongulin/universal-code-reviewer/releases/tag/v1.0.0) - 2026-05-18

### Features

- Added `.github/universal-code-reviewer.yml` repo config (skip paths, defaults for diff size, comments, JSON mode).
- Added diff pre-filter for lockfiles (npm, yarn, pnpm, Cargo, Gemfile, poetry), `dist/`, `node_modules/`, and minified assets.
- Added JSON response mode, resolved-model logging, and smart parse retry when structured output is missing.
- Added workflow concurrency to cancel duplicate reviews on the same PR.
- Simplified README for beginners; moved advanced docs to `docs/ADVANCED.md`.
- Added `AGENTS.md` and agent skills for correct `@main` workflow setup.

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
