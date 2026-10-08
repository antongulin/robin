# Instructions for AI coding agents

Use this file when adding Robin to **another** repository.

## Required workflow reference

Default (latest):

```yaml
uses: antongulin/robin/.github/workflows/review.yml@main
```

Pinned release (preferred for stability):

```yaml
uses: antongulin/robin/.github/workflows/review.yml@v2
```

For a direct action step: `antongulin/robin@main` or `@v2`.

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
| `src/llm-client.ts`, `src/llm-retry.ts`, `src/llm-provider.ts` | LLM request shape, retries, provider detection |
| `src/repo-config.ts` | `.github/robin.yml` parsing and input-vs-config resolvers |
| `src/agent-review.ts`, `src/review-tools.ts`, `src/repo-snapshot.ts` | Multi-turn agent review and its read-only tools |
| `src/prompts/`, `src/review-parser.ts` | Review prompts, JSON schema, response parsing |
| `action.yml`, `.github/workflows/review.yml` | Action inputs and reusable-workflow schema (forwarded 1:1) |
| `docs/`, `README.md`, `llms.txt` | User-facing setup, behavior, and troubleshooting |

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

Installers preserve complete custom identity workflows (explicit token mappings, App
token steps, or inherited secrets), including their refs, rather than reconstructing
them. Keep the shell and npm preservation tests in sync. The website's `public/install.sh`
is a shipped copy of `scripts/install.sh`; publish matching changes in `robin-website`.

## Maintainers: release-notes upkeep (automatic)

Whenever a release lands (release-please auto-merges
`chore: release X.Y.Z` and publishes the GitHub release), clean up its notes as part of
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
