# Universal Code Reviewer

AI code review on pull requests. You bring an API key; reviews show up on GitHub like a teammate left comments.

[![Self-Test](https://github.com/antongulin/universal-code-reviewer/actions/workflows/self-test.yml/badge.svg)](https://github.com/antongulin/universal-code-reviewer/actions/workflows/self-test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 24](https://img.shields.io/badge/runtime-node24-brightgreen.svg)](action.yml)

## What you get

- A review when you open a pull request (or when someone runs `/review`)
- A short summary plus inline comments on changed lines
- Your choice of AI provider — including **free** options

You are **not** signing up for a separate review bot service. The workflow runs in your repo and calls the AI URL you configure.

## Setup in 3 steps

### Step 1 — Get an API key (free option)

The easiest free setup uses [OpenRouter](https://openrouter.ai/):

1. Create an account at [openrouter.ai](https://openrouter.ai/).
2. Create an API key in the dashboard.
3. Use these values for your GitHub secrets:

| Secret name | Value |
| --- | --- |
| `LLM_API_KEY` | Your OpenRouter key (`sk-or-...`) |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | `openrouter/free` |

> [!TIP]
> `openrouter/free` picks a free model for each review — **$0 from OpenRouter**. You only spend [GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions) minutes while the job runs (often a few minutes per review).
>
> - **Public repos:** standard GitHub-hosted runners are free with no monthly minute cap.
> - **Private repos:** GitHub Free includes about **2,000 minutes/month**; [GitHub Pro](https://docs.github.com/en/billing/concepts/product-billing/github-actions) includes about **3,000 minutes/month** (check your plan for current limits).

Other providers (OpenAI, Groq, Ollama, etc.) work too. See [Supported providers](#supported-providers) or [docs/ADVANCED.md](docs/ADVANCED.md).

### Step 2 — Add secrets on GitHub

1. Open **your** repository on GitHub (not this one).
2. Go to **Settings** → **Secrets and variables** → **Actions**.
3. Click **New repository secret** and add each name from the table above.

> [!WARNING]
> Never put API keys inside workflow files, pull request comments, or chat with an AI. Only use GitHub Secrets.

### Step 3 — Add the workflow file

Create a new file in your repo:

**Path:** `.github/workflows/code-review.yml`

**Contents:** copy this exactly:

```yaml
name: Universal Code Reviewer

on:
  pull_request:
    types: [opened, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: antongulin/universal-code-reviewer/.github/workflows/review.yml@main
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

Commit and push. Open a pull request — you should see a review within a few minutes.

> [!IMPORTANT]
> Use **`@main`** for the latest fixes, or pin a release tag (for example `@v1` or `@v1.0.0`) after [releases](https://github.com/antongulin/universal-code-reviewer/releases) exist. Do **not** use `@v0`. See [Version pins](#version-pins) below.

## Using it day to day

| When | What happens |
| --- | --- |
| You open a PR | Review runs once automatically |
| You push more commits | No new review (saves time and API usage) |
| You want another review | Comment `/review` on the PR (first line of the comment) |
| You want a short overview only | Comment `/summary` |
| You need help | Comment `/help` |

Only people with **write** access (or higher) on the repo can use `/review` and `/summary` by default.

## Example

The bot posts a status comment, then a review with severity counts:

```md
## Universal Code Reviewer

1 High | 1 Medium | 2 Suggestions

### Summary
Focused change. Main risk: timeout errors are not handled clearly.

### Findings Not Posted Inline
**1 (`src/example.ts:24`)** - Retries exist but timeout failures lack context.
```

## Supported providers

| Provider | `LLM_BASE_URL` | `LLM_MODEL` example |
| --- | --- | --- |
| **OpenRouter (free)** | `https://openrouter.ai/api/v1` | `openrouter/free` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Ollama (your server) | `http://YOUR_SERVER:11434/v1` | `llama3.2` |

GitHub’s servers cannot reach `localhost` on your laptop. For Ollama at home, use a public server, a tunnel, or a [self-hosted runner](docs/ADVANCED.md#save-github-actions-minutes).

## Optional: config and custom rules

Copy [`.github/universal-code-reviewer.yml.example`](.github/universal-code-reviewer.yml.example) to `.github/universal-code-reviewer.yml` to set `max-diff-size`, skip extra paths, and more. Details: [docs/ADVANCED.md](docs/ADVANCED.md#repository-config-file).

Add `.github/code-reviewer.md` in your repo:

```md
# Reviewer rules

- Focus on bugs and security, not formatting.
- Ask for tests when business logic changes.
```

## Something went wrong?

| Problem | What to try |
| --- | --- |
| Workflow fails immediately | Check all three secrets exist and the workflow uses `@main` |
| `Input required: model` or `llm-base-url` | Add missing secrets (Step 2) |
| Review never appears | Open **Actions** tab → open the failed run → read the error |
| `/review` does nothing | Put `/review` on the **first** line; you need write access on the repo |
| Review is very short | PR may be huge — see [docs/ADVANCED.md](docs/ADVANCED.md) (`max-diff-size`) |
| `Empty response from LLM` | Free routers sometimes return no text — the action retries automatically (3 attempts); comment `/review` again or pin a model in `LLM_MODEL` |

More fixes: [docs/ADVANCED.md#troubleshooting](docs/ADVANCED.md#troubleshooting)

## For AI coding agents

Copy this prompt after secrets are set:

```text
Add Universal Code Reviewer to this repository.
- Workflow file: .github/workflows/code-review.yml
- Reusable workflow: antongulin/universal-code-reviewer/.github/workflows/review.yml@main
- Action ref if needed: antongulin/universal-code-reviewer@main
- Secrets: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
- Do NOT use @v0 or any v0 tag
- Do NOT use pull_request_target or synchronize on pull_request
Read AGENTS.md in the universal-code-reviewer repo for full rules.
```

## Version pins

| Pin | When to use |
| --- | --- |
| `@main` | Latest changes on the default branch |
| `@v1` | Latest `1.x` release (updated on each release) |
| `@v1.0.0` | Exact version (most predictable) |
| Full commit SHA | Maximum supply-chain safety |

```yaml
uses: antongulin/universal-code-reviewer/.github/workflows/review.yml@v1
```

Releases and notes are published automatically from [CHANGELOG.md](CHANGELOG.md) when changes land on `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) for commit message format.

## Learn more

- [docs/ADVANCED.md](docs/ADVANCED.md) — all settings, strict mode, manual-only reviews, security notes
- [CONTRIBUTING.md](CONTRIBUTING.md) — run tests and send pull requests
- [CHANGELOG.md](CHANGELOG.md) — release history

## Development

```bash
git clone https://github.com/antongulin/universal-code-reviewer.git
cd universal-code-reviewer
npm ci
npm run lint
npm test
npm run build
```

Runtime code lives in `dist/index.js`; run `npm run build` before releasing.
