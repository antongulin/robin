---
name: add-to-repository
description: Add Universal Code Reviewer to a consumer repository. Use when the user wants AI PR reviews, code-review workflow, or mentions this action.
---

# Add Universal Code Reviewer to a repository

## Critical rules

1. **Always pin `@main`**, never `@v0`:
   - `antongulin/universal-code-reviewer/.github/workflows/review.yml@main`
   - `antongulin/universal-code-reviewer@main`
2. Read [AGENTS.md](../../AGENTS.md) before generating workflows.
3. Do not use `pull_request_target`.
4. Do not add `synchronize` to `pull_request` unless the user explicitly wants review on every commit.

## Secrets (consumer repo → Settings → Secrets → Actions)

| Secret | Example (OpenRouter free) |
| --- | --- |
| `LLM_API_KEY` | `sk-or-...` |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | `openrouter/free` |

## File to create

Path: `.github/workflows/code-review.yml`

Use the minimal workflow from [AGENTS.md](../../AGENTS.md).

## After setup

Tell the user to open a PR or comment `/review` on an existing PR.
