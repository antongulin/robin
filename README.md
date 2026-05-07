# Universal Code Reviewer

AI pull request reviews with any OpenAI-compatible model: OpenAI, Groq, Together AI, Ollama Cloud, or your own self-hosted endpoint.

No hosted review bot. No vendor lock-in. Bring your own key and run reviews as a GitHub Action.

[![Self-Test](https://github.com/antongulin/universal-code-reviewer/actions/workflows/self-test.yml/badge.svg)](https://github.com/antongulin/universal-code-reviewer/actions/workflows/self-test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 20](https://img.shields.io/badge/runtime-node20-brightgreen.svg)](action.yml)

## What It Does

Universal Code Reviewer reads a pull request diff, sends it to the LLM endpoint you configure, and posts structured feedback back to GitHub.

It is built for developers who want AI review without being locked into one SaaS reviewer, model, quota, or provider.

| You want | This gives you |
| --- | --- |
| Model choice | Use any OpenAI-compatible chat completions endpoint |
| Self-hosting | Point reviews at Ollama or another private model server |
| No action-level quota | The action does not add its own daily review limit |
| GitHub-native workflow | Reviews are posted as PR reviews and inline comments |
| Simple ownership | You control the endpoint, key, model, and cost |

## Example Output

The action posts a short status comment, then updates that same comment when the review finishes. The actual review is posted as a PR review summary plus inline comments when findings can be mapped to changed lines.

```md
## Code Review

> **Review flow:** this is a point-in-time review. Push fixes freely, then comment `/review` when you want Universal Code Reviewer to run again.

:rotating_light: 1 High | :warning: 1 Medium | :bulb: 2 Suggestions

### Summary
The change is focused and keeps the public API small. The main risk is that timeout errors are not handled, so failed provider calls can make the review job fail without a useful message.

### Findings Not Posted Inline

:warning: **1 (`src/llm-client.ts:24`)** - The LLM request has retries, but timeout failures are not surfaced with provider context.
> Include the model and endpoint host in the error message while avoiding API key exposure.
```

## Quick Start

### 1. Add Secrets

In the repository where you want reviews, go to **Settings -> Secrets and variables -> Actions** and add:

| Secret | Required | Example |
| --- | --- | --- |
| `LLM_API_KEY` | Yes | `sk-...` or `ollama` |
| `LLM_BASE_URL` | Yes | `https://api.openai.com/v1` |
| `LLM_MODEL` | Yes | `gpt-4o`, `llama3.2`, `deepseek-coder`, provider-specific model name |

### 2. Add A Workflow

Create `.github/workflows/code-review.yml`:

```yaml
name: Code Review

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
    if: |
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request && (
        startsWith(github.event.comment.body, '/review') ||
        startsWith(github.event.comment.body, '/summary') ||
        startsWith(github.event.comment.body, '/help')
      ))
    runs-on: ubuntu-latest
    steps:
      - name: Universal Code Review
        uses: antongulin/universal-code-reviewer@v0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          llm-base-url: ${{ secrets.LLM_BASE_URL }}
          model: ${{ secrets.LLM_MODEL }}
```

Use the latest release tag for production. During early development you can use `@main`, but pinned release tags are safer.

### 3. Open A PR Or Comment

Automatic reviews run when a PR is opened, reopened, or marked ready for review. New commits pushed to an existing PR are not reviewed automatically by default; comment `/review` after a batch of fixes when you want another pass. Slash commands must be the first non-empty line of a PR comment. Manual trigger comments get an `eyes` reaction when the action accepts the request.

| Command | Result |
| --- | --- |
| `/review` | Full review with High, Medium, Low, and Suggestion findings |
| `/summary` | Short explanation of what changed |
| `/help` | List available commands |

Slash commands are maintainer-only by default. The commenter must have at least `write` permission unless you change `min-command-permission`.

Optional: add `.github/code-reviewer.md` to your repository to define project-specific review rules. The action reads this file from the PR base branch so pull requests cannot inject reviewer instructions.

### Review Flow

The default workflow is designed to avoid repeated LLM runs while a contributor is pushing fix commits:

1. PR is opened, reopened, or marked ready for review.
2. Universal Code Reviewer posts a status comment that it is reviewing.
3. The action posts the review and updates the status comment with either `I did not find any issues` or `I found N issues`.
4. The author pushes fixes without triggering another automatic review.
5. A maintainer comments `/review` when the PR is ready for another pass.

Manual command comments get an `eyes` reaction when accepted, so the user knows the request was picked up.

## Supported Providers

Use any provider that exposes an OpenAI-compatible Chat Completions API.

| Provider | `llm-base-url` example | `model` example |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Together AI | `https://api.together.xyz/v1` | provider-specific model name |
| Ollama Cloud | Ollama Cloud OpenAI-compatible URL | model in your Ollama account |
| Self-hosted Ollama | `http://your-server:11434/v1` | `llama3.2`, `codellama:13b` |
| Custom gateway | Your OpenAI-compatible URL | your routed model name |

GitHub-hosted runners cannot reach `localhost` on your laptop. For self-hosted Ollama, use a reachable server, tunnel/private network, or a self-hosted GitHub runner.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | Yes | `${{ github.token }}` | Token used to read PRs and post reviews |
| `llm-api-key` | No | `ollama` | API key for your LLM endpoint |
| `api-key` | No | empty | Alias for `llm-api-key` |
| `llm-base-url` | Yes | none | OpenAI-compatible API base URL |
| `base-url` | No | empty | Alias for `llm-base-url` |
| `model` | Yes | none | Model name sent to the provider |
| `fail-on-high` | No | `false` | Fails the workflow if high severity issues are found |
| `fail-on-critical` | No | `false` | Deprecated alias for `fail-on-high` |
| `max-diff-size` | No | `50000` | Maximum diff characters sent to the model |
| `max-output-tokens` | No | empty | Optional response token cap; empty uses provider/model default |
| `llm-timeout-ms` | No | `600000` | LLM request timeout in milliseconds. Default is 10 minutes. Increase if large diffs time out. |
| `max-comments` | No | `25` | Maximum inline comments; extra findings stay in the review body |
| `review-on-synchronize` | No | `false` | Run automatic reviews after each new commit pushed to a PR |
| `min-command-permission` | No | `write` | Minimum permission for slash commands: `read`, `triage`, `write`, `maintain`, or `admin` |
| `review-instructions` | No | empty | Additional reviewer instructions appended to the built-in prompt |
| `review-instructions-file` | No | `.github/code-reviewer.md` | File containing reviewer instructions, read from the PR base branch |

## Usage Patterns

### Automatic Review On Every PR

Use the Quick Start workflow. This runs once when the PR enters review, then relies on `/review` for follow-up passes after the author pushes fixes. This avoids repeated LLM runs on every small commit.

### Review On Every Commit

If you intentionally want a full review after every push to a PR, add `synchronize` to the workflow trigger and opt in explicitly:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

with:
  review-on-synchronize: "true"
```

### Manual Review Only

Use this for public repositories, fork-heavy projects, or teams that want to control LLM spend.

```yaml
name: Manual Code Review

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: |
      github.event.issue.pull_request && (
        startsWith(github.event.comment.body, '/review') ||
        startsWith(github.event.comment.body, '/summary') ||
        startsWith(github.event.comment.body, '/help')
      )
    runs-on: ubuntu-latest
    steps:
      - uses: antongulin/universal-code-reviewer@v0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          llm-base-url: ${{ secrets.LLM_BASE_URL }}
          model: ${{ secrets.LLM_MODEL }}
```

Then a maintainer comments `/review` or `/summary` on the PR.

### Strict Mode

Fail the workflow when high severity issues are found:

```yaml
with:
  fail-on-high: "true"
```

### Let Strong Models Use Their Default Output Budget

By default the action does not set `max_tokens`, so stronger models can use their provider default output budget. If you want a hard cap, set it explicitly:

```yaml
with:
  max-output-tokens: "12000"
```

### Reduce Inline Noise

Keep inline comments focused and put extra findings in the review body:

```yaml
with:
  max-comments: "10"
```

### Customize The Reviewer

Add `.github/code-reviewer.md` to your repository:

```md
# Reviewer Rules

- Prioritize security, data loss, and production correctness over style.
- Do not comment on generated files or formatting-only changes.
- Treat missing tests as medium or high severity when business logic changes.
- Prefer actionable findings with a concrete fix.
```

Or pass instructions directly:

```yaml
with:
  review-instructions: |
    Focus on API compatibility and database migration safety.
```

## Security And Privacy

The action sends PR diffs to the LLM endpoint you configure.

| Setup | Where code goes |
| --- | --- |
| OpenAI, Groq, Together, or another hosted API | To that provider |
| Ollama Cloud | To Ollama Cloud |
| Self-hosted Ollama on your server | To your server |
| Self-hosted GitHub runner plus local model | Stays inside your infrastructure |

Recommended practices:

- Store API keys in GitHub Secrets.
- Keep workflow permissions minimal.
- Review your provider's data retention policy before using hosted APIs on private code.
- Avoid `pull_request_target`; this action intentionally skips that event.
- Keep `min-command-permission: "write"` unless you understand the cost and privacy tradeoffs.
- Use manual `/review` for public repositories that receive external fork PRs.

## Limits

Universal Code Reviewer does not add a daily review quota. Your real limits are:

- GitHub Actions minutes.
- Your LLM provider billing and rate limits.
- Your model context window.
- The configured `max-diff-size`.

Large diffs are truncated before being sent to the model. For best results, keep PRs focused and split very large changes.

## Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| `Connection refused` | GitHub cannot reach your LLM endpoint | Use a reachable server, tunnel, or self-hosted runner |
| `Input required and not supplied: model` | `LLM_MODEL` is missing | Add the secret or set `model` directly |
| `Input required and not supplied: llm-base-url` | Endpoint URL is missing | Add `LLM_BASE_URL` or set `llm-base-url` directly |
| `Empty response from LLM` | Model is missing or provider returned no content | Check model name and provider logs |
| Status comment says the review failed | LLM endpoint, API key, model, network problem, or GitHub API rejection | Open the Actions run and check provider/action configuration |
| `Request timed out` | LLM provider took too long to respond, usually on large diffs | Increase `llm-timeout-ms` (default 10 min = `600000`) or reduce `max-diff-size` |
| `Resource not accessible by integration` | Workflow token missing GitHub API permissions | Add `permissions: {contents: read, pull-requests: write}` to the workflow job. See Quick Start for the exact block. |
| `No comments appear` | Missing workflow permissions | Add `pull-requests: write` |
| `Slash command ignored` | Commenter lacks permission or command is not first line | Use `/review` as the first non-empty line from a maintainer account |
| Review is too shallow | Model is too small or diff was truncated | Use a stronger model or increase `max-diff-size` |

## Comparison

| Option | Best when | Tradeoff |
| --- | --- | --- |
| Universal Code Reviewer | You want model control, self-hosting, or no SaaS reviewer account | You operate the endpoint and secrets |
| GitHub Copilot review | You already use Copilot and want native GitHub UX | Less model/provider control |
| Hosted AI reviewer bots | You want a polished hosted product | Vendor lock-in, pricing, and quota limits |
| Custom scripts | You want full control | More maintenance and less GitHub review polish |

## Development

```bash
git clone https://github.com/antongulin/universal-code-reviewer.git
cd universal-code-reviewer
npm ci
npm run lint
npm test
npm run build
```

The action runs from `dist/index.js`, so runtime changes must be bundled before release.

## Roadmap

- Config file support with `.github/universal-code-reviewer.yml`.
- Provider presets for common endpoints.
- Better large PR chunking by file and hunk.
- GitHub App version for one-click organization installation.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
