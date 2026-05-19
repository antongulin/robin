# Advanced guide

This document is for maintainers and power users. For a short setup, see the [README](../README.md).

## Repository config file

Copy [`.github/universal-code-reviewer.yml.example`](../.github/universal-code-reviewer.yml.example) to `.github/universal-code-reviewer.yml` on your default branch.

```yaml
max-diff-size: 25000
max-comments: 10
json-response-mode: true
skip-paths:
  - "**/generated/**"
```

| Key | Purpose |
| --- | --- |
| `max-diff-size` | Used when the workflow still passes the action default (`50000`) |
| `max-comments` | Used when the workflow still passes the action default (`25`) |
| `json-response-mode` | Ask the provider for JSON responses when supported |
| `skip-paths` | Extra paths removed from the diff before the LLM call |

Lockfiles, `dist/`, `node_modules/`, and minified assets are always skipped automatically.

## Pinning the action

| Ref | When to use |
| --- | --- |
| `@main` | **Default.** Always works with the latest fixes. Use in README examples and agent prompts. |
| Full commit SHA | Maximum supply-chain safety in regulated environments |
| `@v0` | **Do not use** — outdated; workflows often fail |

```yaml
uses: antongulin/universal-code-reviewer/.github/workflows/review.yml@main
```

## Low-cost and free setups

### OpenRouter free router

| Secret | Value |
| --- | --- |
| `LLM_API_KEY` | OpenRouter API key |
| `LLM_BASE_URL` | `https://openrouter.ai/api/v1` |
| `LLM_MODEL` | `openrouter/free` |

Smaller diffs help free models stay fast and accurate:

```yaml
jobs:
  review:
    uses: antongulin/universal-code-reviewer/.github/workflows/review.yml@main
    with:
      max-diff-size: "25000"
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

### Save GitHub Actions minutes

- Keep the default flow: one review on PR open, then `/review` after fixes (do not enable `review-on-synchronize` unless you need it).
- Use a smaller `max-diff-size` for huge PRs.
- **Public repos:** hosted runner minutes are unlimited on GitHub Free.
- **Private repos:** use a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners) so LLM wait time does not consume hosted minutes.

## All workflow inputs

Available on the [direct action](../action.yml) and the [reusable workflow](../.github/workflows/review.yml).

| Input | Default | Description |
| --- | --- | --- |
| `github-token` | `${{ github.token }}` | Token for PR API and comments |
| `llm-api-key` | `ollama` | Provider API key |
| `llm-base-url` | — | OpenAI-compatible base URL (required) |
| `model` | — | Model name (required) |
| `fail-on-high` | `false` | Fail the check if high-severity issues are found |
| `max-diff-size` | `50000` | Max diff characters sent to the model |
| `max-output-tokens` | empty | Cap response tokens (optional) |
| `llm-timeout-ms` | `600000` | LLM timeout (10 minutes) |
| `max-comments` | `25` (action) / `10` (reusable workflow) | Max inline comments |
| `review-on-synchronize` | `false` | Review every new commit on the PR |
| `min-command-permission` | `write` | Who can run `/review` |
| `review-instructions` | empty | Extra prompt text |
| `review-instructions-file` | `.github/code-reviewer.md` | Rules file on the base branch |

## Usage patterns

### Review on every commit

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

jobs:
  review:
    uses: antongulin/universal-code-reviewer/.github/workflows/review.yml@main
    with:
      review-on-synchronize: true
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

### Manual review only

Useful for public repos with many forks (controls when the LLM runs):

```yaml
on:
  issue_comment:
    types: [created]

jobs:
  review:
    uses: antongulin/universal-code-reviewer/.github/workflows/review.yml@main
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

### Direct action (full control in one file)

```yaml
jobs:
  review:
    if: |
      github.event_name == 'pull_request' ||
      (
        github.event_name == 'issue_comment' &&
        github.event.issue.pull_request &&
        contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
        (
          startsWith(github.event.comment.body, '/review') ||
          startsWith(github.event.comment.body, '/summary') ||
          startsWith(github.event.comment.body, '/help')
        )
      )
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: antongulin/universal-code-reviewer@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          llm-base-url: ${{ secrets.LLM_BASE_URL }}
          model: ${{ secrets.LLM_MODEL }}
          max-comments: "10"
```

### Strict mode (fail on high severity)

```yaml
jobs:
  review:
    uses: antongulin/universal-code-reviewer/.github/workflows/review.yml@main
    with:
      fail-on-high: true
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

If you raise `llm-timeout-ms` above 10 minutes, also raise the job `timeout-minutes`.

## Review flow

1. PR opened, reopened, or marked ready for review → automatic review.
2. Status comment appears, then updates when done.
3. Author pushes fixes → no automatic re-review (by default).
4. Maintainer comments `/review` for another pass.

The action fetches diffs via the GitHub API. `actions/checkout` is not required unless other steps need local files.

## Security and privacy

PR diffs are sent to **your** configured LLM endpoint.

| Setup | Where code goes |
| --- | --- |
| Hosted API (OpenAI, Groq, OpenRouter, …) | That provider |
| Self-hosted Ollama | Your server |
| Self-hosted runner + local model | Your infrastructure |

Practices:

- Store keys in GitHub Secrets only.
- Use `permissions: contents: read` and `pull-requests: write`.
- Do not use `pull_request_target` with this action.
- Keep slash commands at `min-command-permission: write` unless you accept cost/abuse risk.
- Fork PRs from outsiders may not receive secrets — use manual `/review` from a maintainer.

## Limits

No daily quota from this action. Real limits:

- GitHub Actions minutes (while the job waits on the model).
- Provider rate limits and model context size.
- `max-diff-size` truncation on very large PRs.

## Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| Workflow can't resolve `@v0` | Wrong tag | Use `@main` |
| `Connection refused` | Runner can't reach LLM URL | Public URL, tunnel, or self-hosted runner |
| `Input required: model` | Missing secret | Add `LLM_MODEL` |
| `Input required: llm-base-url` | Missing secret | Add `LLM_BASE_URL` |
| `Empty response from LLM` | Wrong model name | Check provider dashboard |
| `Request timed out` | Large PR or slow free model | Lower `max-diff-size` or raise `llm-timeout-ms` |
| `Resource not accessible by integration` | Missing permissions | Add `pull-requests: write` |
| Slash command ignored | Wrong format or permission | `/review` as first line; need write access |
| Shallow review | Small model or truncated diff | Stronger model or higher `max-diff-size` |

## Comparison

| Option | Best when |
| --- | --- |
| Universal Code Reviewer | You want any model/provider and no SaaS lock-in |
| GitHub Copilot review | You already pay for Copilot |
| Hosted review bots | You want a managed product |
| Custom scripts | You want full control and will maintain it |

## Roadmap

- `.github/universal-code-reviewer.yml` config file
- Provider presets
- Large PR chunking by file
- GitHub App install flow
