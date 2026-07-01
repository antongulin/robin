# Advanced guide

This document is for maintainers and power users. For a short setup, see the [README](../README.md).

## Repository config file

Copy [`.github/robin.yml.example`](../.github/robin.yml.example) to `.github/robin.yml` on your default branch.

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
| `max-comments` | Used when the workflow passes action default `25` or reusable workflow default `10` |
| `json-response-mode` | Used when `use-json-response-mode` is empty (action default defers to this file) |
| `skip-paths` | Extra paths removed from the diff before the LLM call |

Lockfiles (npm, yarn, pnpm, Cargo, Gemfile, poetry), `dist/`, `node_modules/`, and minified assets are always skipped automatically. If every changed file is skipped, the action posts a status comment and skips the LLM call.

The config file uses a small YAML subset (line-based keys only), not full YAML nesting.

## Pinning the action

| Ref | When to use |
| --- | --- |
| `@main` | Latest changes on the default branch |
| `@v1` | Latest `1.x` release (floating tag, updated each release) |
| `@v1.2.3` | Exact semver from [GitHub Releases](https://github.com/antongulin/robin/releases) |
| Full commit SHA | Maximum supply-chain safety in regulated environments |
| `@v0` | **Do not use** — outdated; workflows often fail |

```yaml
uses: antongulin/robin/.github/workflows/review.yml@v1
```

## Releases

Releases are automated with [Release Please](https://github.com/googleapis/release-please) (`.github/workflows/release.yml`):

1. Conventional commits on `main` accumulate in a **Release** pull request (`chore: release X.Y.Z`).
2. Release PRs are verified, merged, and published automatically by the workflow.
3. The workflow updates `package.json`, `CHANGELOG.md`, creates tag `vX.Y.Z`, and publishes [GitHub release notes](https://github.com/antongulin/robin/releases).
4. Floating tags `v1` and `v1.0` (major.minor) are updated so `@v1` stays current within the major version.

Maintainers: do not tag releases by hand unless the workflow failed; fix or rerun the workflow instead.

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
    uses: antongulin/robin/.github/workflows/review.yml@main
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
- **Public repos:** standard GitHub-hosted runners are free with no monthly minute cap ([billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
- **Private repos:** GitHub Free includes about **2,000 minutes/month**; GitHub Pro about **3,000 minutes/month** (limits can change — see GitHub billing for your account).
- **Private repos (heavy usage):** use a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners) so LLM wait time does not consume hosted minutes.

To use a self-hosted runner with the reusable workflow, pass `runner` as valid JSON. A single label is a JSON string; multiple labels are a JSON array.

Coolify example:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      runner: '["self-hosted", "linux", "coolify"]'
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

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
| `runner` | `'"ubuntu-latest"'` | Reusable workflow runner as a JSON string or JSON array |
| `min-command-permission` | `write` | Who can run `/review` |
| `review-instructions` | empty | Extra prompt text |
| `review-instructions-file` | `.github/code-reviewer.md` | Rules file on the base branch |
| `config-file` | `.github/robin.yml` | Repo config path on the base branch |
| `use-json-response-mode` | empty (defer to repo config, else true) | Request `response_format: json_object` when supported |

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
    uses: antongulin/robin/.github/workflows/review.yml@main
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
    uses: antongulin/robin/.github/workflows/review.yml@main
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
          startsWith(github.event.comment.body, '/robin') ||
          startsWith(github.event.comment.body, '/summary') ||
          startsWith(github.event.comment.body, '/help')
        )
      )
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: antongulin/robin@main
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
    uses: antongulin/robin/.github/workflows/review.yml@main
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
4. Maintainer comments `/robin` or `/review` for another pass.

The action fetches diffs via the GitHub API. `actions/checkout` is not required unless other steps need local files.

## Model robustness

Robin is built to give good reviews even when the LLM is a weak, free, or
randomly-routed model (e.g. OpenRouter's free tier). The prompt and parser do the
heavy lifting so the model doesn't have to. If you change `src/prompts/`, keep these
constraints in mind — they are why reviews stay usable across models:

- **Line-numbered diff.** The diff sent to the model is annotated with real new-file
  line numbers (`src/diff-annotate.ts`), and the prompt tells the model to copy those
  exact numbers. Weak models are bad at counting lines; handing them the numbers keeps
  inline comments anchored to the right place instead of drifting or being dropped.
- **Few-shot severity calibration.** The prompt includes worked HIGH/MEDIUM/LOW/
  SUGGESTION examples plus an explicit rule: *impact ≠ confidence; never inflate
  severity*. Without calibration, weak models flag everything as HIGH. The examples
  pin the scale.
- **`confidence` field.** Each finding carries `high|medium|low` confidence separate
  from severity. The parser ignores invalid values, and the Robin skill uses confidence
  to decide how hard to verify a finding before acting on it. Severity orders effort;
  confidence gates trust.
- **"You only see the diff" guard.** The prompt reminds the model it sees changed lines
  only, not the whole file — so it doesn't invent bugs about code it can't see. The
  companion skill mirrors this: it treats findings as hypotheses to verify, not orders.

The parser (`src/review-parser.ts`) is deliberately forgiving — it normalizes severity,
drops unparseable findings, and falls back to a markdown review if JSON mode fails — so a
malformed response from a weak model degrades instead of crashing the run.

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
| `Empty response from LLM` | Free/unstable model returned no text | Action retries with backoff; comment `/review` again |
| `OpenRouter stall: no first response` | Auto-router hung before picking a provider | Action retries every 45s (up to 5×); PR status comment updates each attempt |
| Job cancelled / 15 min with no review | Hung LLM or concurrency cancel while waiting | Status comment should say interrupted — comment `/robin` again; pin `@v2.0.4`+ for stall detect |
| `404 Provider returned error` | OpenRouter free route missed one provider | Keep `LLM_MODEL=openrouter/free` — action retries (5×) with provider fallbacks; no secret updates when models rotate |
| `Request timed out` | Large PR or slow free model | Lower `max-diff-size` or raise `llm-timeout-ms` (router models default to 2 min per attempt) |
| `Resource not accessible by integration` | Missing permissions | Add `pull-requests: write` |
| Slash command ignored | Wrong format or permission | `/robin` or `/review` as first line; need write access |
| `/robin` does nothing on `@v1` | Stale `v1` tag before v1.4.0 | Use `/review`, pin `@v1.4.0`+, or `@v2`; floating `v1` tracks latest `1.x` on release |
| Shallow review | Small model or truncated diff | Stronger model or higher `max-diff-size` |

## Comparison

| Option | Best when |
| --- | --- |
| Robin | You want any model/provider and no SaaS lock-in |
| GitHub Copilot review | You already pay for Copilot |
| Hosted review bots | You want a managed product |
| Custom scripts | You want full control and will maintain it |

## Roadmap

- `.github/robin.yml` config file
- Provider presets
- Large PR chunking by file
- GitHub App install flow
