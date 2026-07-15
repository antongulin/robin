# Instructions for AI coding agents

Use this file when adding Robin to **another** repository.

## Required workflow reference

Default (latest):

```yaml
uses: antongulin/robin/.github/workflows/review.yml@main
```

Pinned release (preferred for stability):

```yaml
uses: antongulin/robin/.github/workflows/review.yml@v1
```

For a direct action step: `antongulin/robin@main` or `@v1`.

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

## Further reading

- [README.md](README.md) — human-friendly setup
- [docs/ADVANCED.md](docs/ADVANCED.md) — all inputs and patterns
