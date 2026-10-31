# Instructions for AI coding agents

Use this file when adding Robin to **another** repository.

## Required workflow reference

Default (latest):

```yaml
uses: antongulin/robin/.github/workflows/review.yml@main
```

Floating v2 workflow ref:

```yaml
uses: antongulin/robin/.github/workflows/review.yml@v2
```

The reusable workflows at `main`, `v2` and `v2.12.4` call `antongulin/robin@main`
internally. A workflow tag or SHA pins only that workflow, not the nested action.
For a direct action step, `antongulin/robin@main` follows main and `@v2` follows
the latest v2 release; an exact action release or full SHA pins its implementation.
Do not present a reusable-workflow pin as an implementation pin.

Unset `agent-mode` defaults to `auto` on `main` and from v2.13.0. Keep the action and
workflow input defaults blank so base-branch `.github/robin.yml` can select `off`.
Explicit mode input overrides that config. For weak/local/small-context models,
recommend explicit `off` until tool behavior, quality and context capacity have been
checked; fallback is bounded and can fail. See [migration guidance](docs/ADVANCED.md#default-change-and-migration).

## Do not use

- `@v0`, `v0`, or any `v0` release tag — workflows fail or point at stale code.
- `pull_request_target` — not supported; security risk with secrets.
- `synchronize` on `pull_request` unless the user explicitly wants review on every push.

## Required secrets (in the consumer repo)

| Secret | Purpose |
| --- | --- |
| `LLM_API_KEY` | Provider API key |
| `LLM_BASE_URL` | OpenAI-compatible base URL |
| `LLM_MODEL` | Model id |

Optional custom identity: reusable-workflow callers may pass `ROBIN_TOKEN`. Omitted
or empty keeps `github.token`; do not add it to default installer templates. GitHub App
examples must create and use their token in the same job via the direct action, never
pass a masked token through job outputs. See [Custom review identity](docs/ADVANCED.md#custom-review-identity).

Free OpenRouter example:

- `LLM_BASE_URL`: `https://openrouter.ai/api/v1`
- `LLM_MODEL`: `openrouter/free`

## Minimal consumer workflow

Create `.github/workflows/robin.yml`:

```yaml
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
    uses: antongulin/robin/.github/workflows/review.yml@main
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

## Permissions

The job needs:

```yaml
permissions:
  actions: read
  contents: read
  pull-requests: write
```

`actions/checkout` is optional for review-only workflows.

## Maintainers: project map and verification

Everything above is for adding Robin to a consumer repo. This section is for agents working
**in this repository**. It is a concise operating map, not a task log; keep run evidence in
task records outside the tracked tree.

**Layout.** `src/` is the GitHub Action (compiled into the committed `dist/index.js`).
`action.yml` is the action input/output contract; `.github/workflows/review.yml` is the
reusable workflow consumers call; `templates/robin.yml`, `scripts/install.sh`, and
`bin/robin-review.js` are the shipped installer surfaces; `docs/` and `README.md` are the
user documentation; `skills/robin/` is the companion chat skill shipped for coding agents.

| Path | Owns |
| --- | --- |
| `src/main.ts` | Entry point: event/trigger policy, input parsing, orchestration |
| `src/git-utils.ts`, `src/native-diff.ts`, `src/native-process.ts` | PR diff API, authenticated native Git fallback, and owned process-group lifecycle; see runner and coverage limits in `docs/ADVANCED.md` |
| `src/llm-client.ts`, `src/llm-retry.ts`, `src/llm-provider.ts` | LLM request shape, retries, provider detection |
| `src/request-budget.ts` | Complete serialized-request estimate, typed preflight rejection and output reserve; guard before physical-attempt accounting |
| `src/usage-report.ts` | Passive per-invocation physical-attempt ledger, safe metric coverage, isolated Actions/local reporting |
| `src/repo-config.ts` | `.github/robin.yml` parsing and input-vs-config resolvers |
| `src/agent-review.ts`, `src/review-tools.ts`, `src/repo-snapshot.ts` | Multi-turn agent review and its read-only tools |
| `src/prompts/`, `src/review-parser.ts` | Review prompts, JSON schema, response parsing |
| `action.yml`, `.github/workflows/review.yml` | Action inputs and reusable-workflow schema (forwarded 1:1) |
| `docs/`, `README.md`, `llms.txt` | User-facing setup, behavior, and troubleshooting |
| `docs/assets/brand/`, `src/brand.ts` | Compact artwork copies/provenance and shared GitHub heading |
| `scripts/release-control.cjs`, `.github/workflows/release.yml`, `.github/workflows/publish.yml` | Trusted release selection, approval waiting, immutable verification/publication, and npm tag/version guard; maintainer recovery in `CONTRIBUTING.md` |
| `src/release-control.test.ts`, `src/release-workflow.test.ts`, `testdata/release-tools.cjs` | Offline release state/process fixtures and workflow contracts; fixtures must never invoke live publication |

**Brand ownership.** The website owns artwork masters and deterministic exports at
`https://www.robinreview.dev/brand/`. Core keeps exact lightweight copies and source
credits in `docs/assets/brand/`; refresh them from the website build rather than adding
an image generator here. Use the full bird for introductory artwork and the head for
small marks. Every action-authored top-level GitHub body (initial, progress, completed,
failed, skipped, cancelled, superseded, review, summary and help) uses the shared
`buildRobinHeader`: one decorative bird followed by plain ` The `, linked `Robin`,
and plain ` Hood of code review`. Only `Robin` links to `https://www.robinreview.dev/`;
the decorative image stays outside the link with empty alt text.
A summary suffix may follow the heading. Include the exact `ROBIN_SIGNATURE`
(`:bow_and_arrow: Robin`) once in a hidden HTML comment for compatibility; keep
recognition behavior and the reviewer re-export unchanged. Inline finding labels
stay plain, with no decorative image or tagline. CLI/install/setup/update prefixes
use plain `Robin:`, with no HTML, image or tagline.

**Documentation ownership.** This root `AGENTS.md` is the documentation contract for the whole
repository: the source, workflow, docs, and skill surfaces above share this single ownership
boundary, so there are no child `AGENTS.md` files. Add a child `AGENTS.md` only when a subtree
grows its own stable contract that the root index no longer covers cleanly. The index follows the
structure guidance of [agent0ai/dox](https://github.com/agent0ai/dox) at pinned revision
[`765ae4ac`](https://github.com/agent0ai/dox/tree/765ae4ac02cc884eefcd41a3d0f71941721adb89)
(MIT, Copyright 2026 Agent Zero).

**Verification.** Run the existing checks before pushing:

```bash
npm ci
npm test                 # Jest + ts-jest
npm run lint             # eslint src/**/*.ts
npx --no-install tsc --noEmit
actionlint -shellcheck= -pyflakes= .github/workflows/*.yml testdata/consumer-workflows/*.yml
npm run build            # tsc + ncc; commit the regenerated dist/index.js
```

Keep action inputs, reusable-workflow `workflow_call` inputs, the `with:` forwarding in
`review.yml`, the installer template, and the docs in sync — `src/workflow.test.ts` guards
that parity. Behavior changes that touch optional request parameters should not silently
drop a user-configured control; surface the provider error instead.

Diff input fails closed: every model request receives the complete filtered diff or the run
fails before that request, reporting the observed size, the cap that applied, and how to fix
it (`src/input-limit.ts`). Do not reintroduce truncated diff input or claim that agent tools
recover dropped hunks; commit the rebuilt `dist/index.js` with the change.

**Estimated request budget.** Default decimal 256000 per request; `utf8-json-div3-v1`
counts ceil(complete final SDK JSON UTF-8 bytes/3), plus actual output cap and
ceil(budget/16) safety. Default output scales up to 32000; raw diff caps default 500000.
Blank metadata inherits base config; explicit values, including old 50000, win.
Guard every rebuilt body before ledger begin, including stream/private replay/tools/schema.
Typed preflight errors bypass retries; bounded agent compaction may recover. No diff
clipping, no silent output-cap dropping/clamping. Guard off plus agent-mode off and
absent explicit output restores the previous request shape. Keep estimates separate
from provider usage; no prompt/private/source text in budget diagnostics. See
`docs/ADVANCED.md#estimated-request-budget`.

**Usage reporting.** Keep accounting below both retry loops and observe before extraction or
awaited stream progress. Pass phase context explicitly; never send it to the provider.
Preserve unknown/nonfinal coverage and preceding attempts; cached/reasoning counts stay
breakdowns. Reporting is passive and nonfatal, with allowlisted metadata only. Keep
`usage-report` action -> job -> workflow output wiring intact. `usage-report-path` is a
same-job runner-local ledger, not a caller artifact. See `docs/ADVANCED.md#llm-usage-reports`.
Redact explicitly supplied credentials, including short keys. Keep the omitted-key
input blank so the public `ollama` fallback sent to the SDK does not suppress report identifiers.

**Private assistant replay.** Preserve a provider-supplied string `reasoning_content`
as private completion metadata, including empty strings and streamed string deltas.
Replay it unchanged only on its original assistant tool message, including retained
compaction tails and forced-final requests. Omit absent or invalid values. Keep it out
of summary prompts, progress/status updates, Robin logs, and visible reviews; use
`content` for review text. Low-level SDK debug logging can expose raw payloads.

Installers preserve complete custom identity workflows (explicit token mappings, App
token steps, or inherited secrets), including their refs, rather than reconstructing
them. Keep the shell and npm preservation tests in sync. The website's `public/install.sh`
is a shipped copy of `scripts/install.sh`; publish matching changes in `robin-website`.

## Maintainers: release-notes upkeep (automatic)

Whenever an approved `chore: release X.Y.Z` PR merges and the workflow publishes
the GitHub release, clean up its notes as part of
the same task — do it automatically, without asking.

1. Inspect every release cut during the session: `gh release view <tag> --json body`.
2. Enrich each `feat`/`fix` entry with a one-line plain-language user impact, and credit
   external contributors (`— thanks [@login](https://github.com/login)!`).
3. Catch orphaned commits: a commit that lands on `main` between the release PR's
   snapshot and its merge appears in **no** changelog. Compare
   `git log <prev-tag>..<tag> --oneline` against the notes and add missing entries under
   the matching section.
4. Edit **only** the GitHub release (`gh release edit <tag> --notes '…'`). Never rewrite
   `CHANGELOG.md` retroactively — a changelog commit itself triggers another release.
5. Keep the generated format (version heading with compare link, `### Features` /
   `### Bug Fixes` / `### Documentation` sections). Never create tags or releases by
   hand, and never delete a published release.

## Further reading

- [README.md](README.md) — human-friendly setup
- [docs/ADVANCED.md](docs/ADVANCED.md) — all inputs and patterns
