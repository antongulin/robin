# Changelog

## [2.0.3](https://github.com/antongulin/robin/compare/v2.0.2...v2.0.3) (2026-06-18)


### Documentation

* mark 2.0 roadmap as shipped ([7522b58](https://github.com/antongulin/robin/commit/7522b587bae5f960a3ca619bc368faccf1977ca5))
* mark 2.0 roadmap as shipped ([70155cb](https://github.com/antongulin/robin/commit/70155cb6592e197bd2ae2f00bf7bdf38149b96e6))

## [2.0.2](https://github.com/antongulin/robin/compare/v2.0.1...v2.0.2) (2026-06-18)


### Documentation

* show clean-pass screenshot in README ([6af8cf9](https://github.com/antongulin/robin/commit/6af8cf954264e523a433c4d077f5470911324d3b))
* show clean-pass screenshot in README ([8c36b27](https://github.com/antongulin/robin/commit/8c36b2732087acaf1b39c25108576156fa0b772e))

## [2.0.1](https://github.com/antongulin/robin/compare/v2.0.0...v2.0.1) (2026-06-18)


### Documentation

* **readme:** add a real Robin review screenshot above the fold ([04c124a](https://github.com/antongulin/robin/commit/04c124a01df4d0490ac803cfb0b586a7d0bb9dc9))
* **readme:** add Robin review screenshot above the fold ([e213f2d](https://github.com/antongulin/robin/commit/e213f2d0e430a16256c85ebb535f67e5c53ba246))

## [2.0.0](https://github.com/antongulin/robin/compare/v1.6.1...v2.0.0) (2026-06-18)


### ⚠ BREAKING CHANGES

* the api-key, base-url, and fail-on-critical action inputs are removed. If you call antongulin/robin directly via 'uses:' with any of these, rename them: api-key -> llm-api-key, base-url -> llm-base-url, fail-on-critical -> fail-on-high. Consumers of the reusable workflow (.github/workflows/review.yml) are unaffected — it already used the canonical names.

### Features

* drop deprecated input aliases ([6f8c3ba](https://github.com/antongulin/robin/commit/6f8c3ba75fa60536a7f83406d17788b7c3d3c880))

## [1.6.1](https://github.com/antongulin/robin/compare/v1.6.0...v1.6.1) (2026-06-18)


### Documentation

* document model-robustness design and prompt-testing ([a71e7c6](https://github.com/antongulin/robin/commit/a71e7c6952a9d0b0904a41e0857bd11891982a69))
* model-robustness design + prompt-testing guide ([851103a](https://github.com/antongulin/robin/commit/851103a6fca737704d49a8b2425a0400ed30bd20))

## [1.6.0](https://github.com/antongulin/robin/compare/v1.5.1...v1.6.0) (2026-06-18)


### Features

* **config:** unify max-comments default to 15 ([de10bae](https://github.com/antongulin/robin/commit/de10baefabcd896abc9092944b4ac69a1f8c0f6d))
* **config:** unify max-comments default to 15 ([466f427](https://github.com/antongulin/robin/commit/466f427ca63b7f4856d2ea0ca866f0fe2e1cfd23))

## [1.5.1](https://github.com/antongulin/robin/compare/v1.5.0...v1.5.1) (2026-06-18)


### Documentation

* **config:** fix example to reference .github/robin.yml ([5f85a20](https://github.com/antongulin/robin/commit/5f85a20ff8badeb0962f0c785b843d6c0ddc51f5))
* **config:** fix example to reference .github/robin.yml ([51f8f93](https://github.com/antongulin/robin/commit/51f8f93b26e59455b841c0d82848cf0ddd2639ff))

## [1.5.0](https://github.com/antongulin/robin/compare/v1.4.0...v1.5.0) (2026-06-18)


### Features

* **install:** install companion skill for all agents via skills CLI ([6098654](https://github.com/antongulin/robin/commit/6098654891dd3734e640f8676e2d7f2ff763f395))
* **repo:** community surface, llms.txt, and bundled chat skill ([7e09dd6](https://github.com/antongulin/robin/commit/7e09dd666298c94ec1384ed037161bb71f13aa8f))


### Documentation

* add repo-publishing scorecard, metadata, and plan ([db34269](https://github.com/antongulin/robin/commit/db342696c9190397e2177f1a0f66962fb6844b5d))

## [1.4.0](https://github.com/antongulin/robin/compare/v1.3.0...v1.4.0) (2026-06-18)


### Features

* **engine:** line-numbered diffs, confidence scoring, and Robin voice ([3c9afd5](https://github.com/antongulin/robin/commit/3c9afd501e9a64c87e430af8245881e634fef3ef))
* **scripts:** add one-line installer ([1719b7c](https://github.com/antongulin/robin/commit/1719b7c34e521f9e6efcd5a6635c3531f78362a1))
* **skill:** add robin PR review-loop skill ([e7e41ed](https://github.com/antongulin/robin/commit/e7e41ed128c8a12827188700690a4105b9877272))


### Bug Fixes

* **ci:** trigger reviews on /robin comments ([5a21dfa](https://github.com/antongulin/robin/commit/5a21dfa93b8e07a90a314fff2f8e3b3d00f7c1b3))
* **install:** avoid leaving a .bak file from the ref substitution ([21d40b4](https://github.com/antongulin/robin/commit/21d40b4267894a75e1ffabdd3cbc58629dc5034c))


### Documentation

* correct versioning — road to 2.0, not 1.0 ([71a0835](https://github.com/antongulin/robin/commit/71a083501e597e6079371a83336ca6832954a481))
* quick-install, 1.0 roadmap, and brand consistency ([71ca183](https://github.com/antongulin/robin/commit/71ca183c0b3f1345b324744c6ab6cc5defb1c663))

## [1.3.0](https://github.com/antongulin/robin/compare/v1.2.3...v1.3.0) (2026-06-17)


### Features

* rebrand to Robin ([46b61ed](https://github.com/antongulin/robin/commit/46b61eda225dba2eff60b8de6da4f07d452ed8db))
* rebrand to Robin with one-command install UX ([1247e43](https://github.com/antongulin/robin/commit/1247e433632dc5f69cf143b07dfeefb9990f7f05))

## [1.2.3](https://github.com/antongulin/robin/compare/v1.2.2...v1.2.3) (2026-05-19)


### Bug Fixes

* explain release pr label failures ([3fbafca](https://github.com/antongulin/robin/commit/3fbafcadc2a342fbed33cf4db9b979f03e203d4b))
* harden release pr label errors ([49415b0](https://github.com/antongulin/robin/commit/49415b00b60932c51d5b3887f458afe07889d379))
* make release pr labeling idempotent ([85f5759](https://github.com/antongulin/robin/commit/85f5759ba4d1ea25dbdd7b5c31fff373e9c43a06))
* mark auto release prs tagged ([41e22ba](https://github.com/antongulin/robin/commit/41e22ba626e91364f580a972a1140359dadf4428))
* mark auto release PRs tagged ([d0da052](https://github.com/antongulin/robin/commit/d0da052a8b6a955421c665f648d81d7434962a8d))
* simplify release pr number validation ([5c825ee](https://github.com/antongulin/robin/commit/5c825ee73626586f20be96fee874879e9cadc649))
* validate release pr label target ([c5c4b2f](https://github.com/antongulin/robin/commit/c5c4b2fc2e36375072be45f0315a4f1ce1c39f99))
* verify release pr before labeling ([d6184e1](https://github.com/antongulin/robin/commit/d6184e1089709f5b7b4f45f41a7a76bccedf0baf))

## [1.2.2](https://github.com/antongulin/robin/compare/v1.2.1...v1.2.2) (2026-05-19)


### Bug Fixes

* document pr-only release please mode ([b976506](https://github.com/antongulin/robin/commit/b9765068b9577c06fc3e165bc70118485f82fdbd))
* keep Release Please in PR-only mode ([46084b7](https://github.com/antongulin/robin/commit/46084b78a7e097c8b8a93bca0d90eed38d1239a6))
* keep release-please in pr-only mode ([67c2846](https://github.com/antongulin/robin/commit/67c2846db208b991d4ae894ca210ed1457cff8b8))
* remove stale release-please publish outputs ([d7bc626](https://github.com/antongulin/robin/commit/d7bc6268cffd0a8255041ea2d2ab3bba7fe0f000))
* repair auto-release notes extraction ([7a7b26a](https://github.com/antongulin/robin/commit/7a7b26a94f0416eb1009018ff4d171c8cf5bbaf9))
* repair auto-release notes extraction ([4c490cf](https://github.com/antongulin/robin/commit/4c490cf4f90b125ed41c952be93c10a9cc577dfc))


### Documentation

* clarify release publishing ownership ([3759b2f](https://github.com/antongulin/robin/commit/3759b2fb7dbcb9669e9851c8cae158232f99cf3b))

## [1.2.1](https://github.com/antongulin/robin/compare/v1.2.0...v1.2.1) (2026-05-19)


### Bug Fixes

* address auto release review feedback ([d9876b4](https://github.com/antongulin/robin/commit/d9876b4c090aaf38ddad6a975390086a770f840a))
* harden auto release workflow ([9558a17](https://github.com/antongulin/robin/commit/9558a1755784b91883e5382de3b6d3a701600934))

## [1.2.0](https://github.com/antongulin/robin/compare/v1.1.2...v1.2.0) (2026-05-19)


### Features

* support configurable review runner ([5f8cbdc](https://github.com/antongulin/robin/commit/5f8cbdc9bde040d924efb6fd9269d64760472a68))


### Documentation

* explain self-hosted runner usage ([0c5776e](https://github.com/antongulin/robin/commit/0c5776ed7b5d6593fb2656400767d2ab2256816f))

## [1.1.2](https://github.com/antongulin/robin/compare/v1.1.1...v1.1.2) (2026-05-19)


### Bug Fixes

* support openrouter/free rotation without updating secrets ([f31aa2d](https://github.com/antongulin/robin/commit/f31aa2d548f31f034bdba152c1258a700a1eacaf))
* support openrouter/free rotation without updating secrets ([4ec28ec](https://github.com/antongulin/robin/commit/4ec28ecb18510d649fcfebf287d54a332e6ef5af))

## [1.1.1](https://github.com/antongulin/robin/compare/v1.1.0...v1.1.1) (2026-05-19)


### Bug Fixes

* auto-retry LLM completions on empty or transient errors ([c22bb05](https://github.com/antongulin/robin/commit/c22bb05bb5da004c7f30ea65665ab169d8618d36))

## [1.1.0](https://github.com/antongulin/robin/compare/v1.0.0...v1.1.0) (2026-05-19)


### Features

* configurable LLM timeout with 10-minute default ([7b48945](https://github.com/antongulin/robin/commit/7b48945a01b43574d54d35d73ef142c85d83a55c))
* configurable LLM timeout with 10-minute default ([4f50e51](https://github.com/antongulin/robin/commit/4f50e5114ed7abdeb23861e74bb687674d7b8c5b))
* harden core reviewer and add tests ([c3e7380](https://github.com/antongulin/robin/commit/c3e7380ef9a19b5cd52bd9a7c0dea7fe7ea09637))
* improve review rerun flow ([9ae3e67](https://github.com/antongulin/robin/commit/9ae3e677a2c4a32ac3a359f8d82f3efd8f8ef743))
* stronger review output, failure UX, and eyes reaction ([f60b881](https://github.com/antongulin/robin/commit/f60b881891bf56f6b92960121c2b1bd5b19e358e))
* v1 config, diff filter, JSON mode, simpler docs ([#7](https://github.com/antongulin/robin/issues/7)) ([64f97f4](https://github.com/antongulin/robin/commit/64f97f4089a7bf28aab8189811191abc421a01d4))


### Bug Fixes

* address reviewer flow feedback ([c568a35](https://github.com/antongulin/robin/commit/c568a35d92510ffea712fdba1431340713ac05d9))
* avoid unnecessary PR API call and gracefully handle missing permissions ([#1](https://github.com/antongulin/robin/issues/1)) ([feff466](https://github.com/antongulin/robin/commit/feff4664561e6ac6ab889b90a140f5809c1efa60))
* Bundle action as single dist/index.js for GitHub Actions ([bfb2287](https://github.com/antongulin/robin/commit/bfb228710c5fbe79a4a5e1df4ac43e20e771c4c9))
* handle empty LLM responses and soften self-test flakes ([e8502dc](https://github.com/antongulin/robin/commit/e8502dc931ee15319969edc7cad1f8648d0d1c88))
* minimize workflow permissions and tighten trigger conditions ([bdb75cd](https://github.com/antongulin/robin/commit/bdb75cdca23f3cd47500f909640d856cdb6a1ccd))
* use [@main](https://github.com/main) instead of [@v0](https://github.com/v0) for the action reference ([a45770d](https://github.com/antongulin/robin/commit/a45770d08c284af10d0239dafd8d101a2acea759))


### Documentation

* Add plain-English architecture explanation for non-technical users ([d238d89](https://github.com/antongulin/robin/commit/d238d89311bad614d95b80c47572e623cce880f8))
* Add v0.1.0 changelog and v0.2.0 roadmap ([ba4c70c](https://github.com/antongulin/robin/commit/ba4c70c14f5e42f0e5efaf0bccd4127258dc9be2))
* clarify setup and review limits ([287230b](https://github.com/antongulin/robin/commit/287230be775d6f17ef0e830f74c4a8eae0193d1b))
* explain reviewer workflow and slash commands ([098fb90](https://github.com/antongulin/robin/commit/098fb9019a1a2142507f016b6468c3afbd83b479))
* minimize workflow permissions and tighten trigger conditions ([6af07c6](https://github.com/antongulin/robin/commit/6af07c6f3e667270307806464258e063e7162c11))
* note Actions PR permission for Release Please ([e922459](https://github.com/antongulin/robin/commit/e922459854f117dd2d7a8feb3e04be27db439ae5))
* tighten reviewer workflow guidance ([683219a](https://github.com/antongulin/robin/commit/683219a1c1b21364924aa0d82cfe948143911d9b))

## [Unreleased]

## [1.0.0](https://github.com/antongulin/robin/releases/tag/v1.0.0) - 2026-05-18

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
