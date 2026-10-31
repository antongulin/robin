<p align="center">
  <a href="https://www.robinreview.dev/"><img src="https://www.robinreview.dev/brand/repository.png?v=feee03b10ca6" width="100%" alt="Robin — The Robin Hood of code review. Free AI code reviews for every pull request." /></a>
</p>

# Robin

Free AI code reviews for every pull request. You bring an API key; Robin reviews show up like a teammate left comments.

[![Self-Test](https://github.com/antongulin/robin/actions/workflows/self-test.yml/badge.svg)](https://github.com/antongulin/robin/actions/workflows/self-test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 24](https://img.shields.io/badge/runtime-node24-brightgreen.svg)](action.yml)

> [!IMPORTANT]
> **Default change on `main` and from v2.13.0:** When you leave `agent-mode` unset in both inputs and repository config, Robin now uses `auto`. The model can read callers, types and tests before reporting findings.
>
> Reviews may make extra model requests, take longer and use more tokens, runner time and network traffic. Files read through tools go to your configured LLM endpoint. Tool support alone does not ensure good reviews or enough context capacity. For weak, local or small-context models, start with explicit diff-only mode:
>
> ```yaml
> # .github/robin.yml on the PR base branch
> agent-mode: off
> ```
>
> **Request defaults also change:** Robin checks an estimated **256,000-token working budget per request**, with a **32,000-token output cap** when unset and **16,000** safety headroom. Both raw diff allowances now default to **500,000 characters**. These are configurable estimates, not model context guarantees. Total usage across turns/retries can exceed 256,000 tokens. See [request budgets](docs/ADVANCED.md#estimated-request-budget).
>
> For the previous single-shot/provider-default output shape, set both `agent-mode: off` and `estimated-request-token-budget: off`, and leave `max-output-tokens` unset. Explicit output and character caps still apply. Older reusable workflows may explicitly forward `50000`; Robin preserves that value.
>
> A nonblank workflow/action input overrides this file; change an existing `agent-mode: auto` input to `agent-mode: "off"` too. Some tagged reusable workflows call the action at `@main` and can receive this change before the release. See the [migration and model compatibility guide](docs/ADVANCED.md#default-change-and-migration) for input snippets, fallback limits and pin behavior. `/summary` stays single-shot.

## What you get

- A review when you open a pull request (or when someone comments `/robin`)
- A short summary plus inline comments on changed lines, with one-click suggested fixes when the model can pin one down
- Reviews with repository tools by default, so tool-capable models can check callers, types and tests; explicit `agent-mode: off` keeps diff-only reviews
- Your choice of AI provider — including **free** options

When there's nothing worth flagging, Robin reports **No issues found**.

You are **not** signing up for a separate review bot service. The workflow runs in your repo and calls the AI URL you configure.

## For AI coding agents

Using Cursor, Copilot, Claude Code, or similar? Copy this prompt after secrets are set:

```text
Add Robin to this repository.
- Workflow file: .github/workflows/robin.yml
- Reusable workflow: antongulin/robin/.github/workflows/review.yml@main
- Action ref if needed: antongulin/robin@main
- Secrets: LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
- Do NOT use @v0 or any v0 tag
- Do NOT use pull_request_target
Read AGENTS.md in the robin repo for full rules.
```

## Quick install

> [!IMPORTANT]
> Run the installer from the root of the Git repository you want Robin to review — not
> from your home directory. The workflow and secrets are configured once per repository;
> the companion agent skill is installed globally once per machine.

From the target repository, run either:

```bash
npx robin-review
```

or, without Node.js:

```bash
curl -fsSL https://robinreview.dev/install.sh | bash
```

Either one keeps a single canonical `.github/workflows/robin.yml` and installs or updates
the [companion chat skill](#robin-in-your-editor) in your coding agents. If it finds an
older Robin or Universal Code Reviewer workflow under another name, it moves that file to
`.github/robin-workflow-archive/` (where GitHub cannot trigger it) before creating the
canonical workflow. Inspect the archived copy, then remove it after confirming the
migration. An unrelated file already using the canonical path is never overwritten.
Run an installer separately in every repository that should use Robin. Re-running it is
safe and idempotent — your workflow ref and any `with:` overrides (for example
`llm-temperature`) are preserved.
You still need to add the three secrets — do **Steps 1 and 2** below, then commit and push.
You can **skip Step 3**: the installer already did it.

**Auto-updates:** the generated workflow references
`antongulin/robin/.github/workflows/review.yml@main` and follows changes on `main`.
`ROBIN_REF=v2 npx robin-review` selects the floating v2 workflow ref. That workflow
still calls the action at `@main`; see [Version pins](#version-pins) to pin the action
implementation or keep diff-only mode across updates.

Prefer to do it by hand, or read the installer first? It's
[bin/robin-review.js](bin/robin-review.js) (npm) / [scripts/install.sh](scripts/install.sh)
(curl) — or follow the manual 3 steps instead.

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
> `openrouter/free` picks a free model for each review — **$0 from OpenRouter**. OpenRouter rotates which model runs; **leave this secret as `openrouter/free`** — the action retries and uses provider fallbacks when a route is temporarily unavailable. You only spend [GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions) minutes while the job runs. Review duration depends on the model, diff, review mode and retries.
>
> Check [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) for included minutes and runner charges. See [Review timing](docs/ADVANCED.md#review-timing) to distinguish queue time from the review itself.

Other providers (OpenAI, Groq, Ollama, etc.) work too. See [Supported providers](#supported-providers) or [docs/ADVANCED.md](docs/ADVANCED.md).

### Step 2 — Add secrets on GitHub

1. Open **your** repository on GitHub (not this one).
2. Go to **Settings** → **Secrets and variables** → **Actions**.
3. Click **New repository secret** and add each name from the table above.

> [!WARNING]
> Never put API keys inside workflow files, pull request comments, or chat with an AI. Only use GitHub Secrets.

### Step 3 — Add the workflow file

> [!NOTE]
> **Ran the Quick install one-liner above?** Skip this step — the script already created
> this file. Just finish Steps 1 and 2 (the secrets), then commit and push.

Create a new file in your repo:

**Path:** `.github/workflows/robin.yml`

**Contents:** copy this exactly:

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

Commit and push, then open a pull request. Follow the run in **Actions**; [review timing](docs/ADVANCED.md#review-timing) varies with the workload and provider.

By default Robin reviews when the PR opens (and on `/review`), not on every push. To also review each push, add `synchronize` to the `pull_request` `types:` and set `review-on-synchronize: true` in the job's `with:` block.

> [!IMPORTANT]
> Use **`@main`** to follow the default branch, or choose a workflow ref from [releases](https://github.com/antongulin/robin/releases). A reusable-workflow tag does not pin its nested action at `@main`. Do **not** use `@v0`. See [Version pins](#version-pins) below.

## LLM usage reports

Open the **LLM usage** section of the Actions job summary to see provider-reported
prompt, completion, cached-input and reasoning tokens across the invocation. Robin
counts physical requests, including retries, compaction and diff-only fallback.
Missing or interrupted usage stays unknown; known sums can be partial.

The reusable workflow exposes compact JSON as `usage-report`; dependent jobs read
`needs.<your-review-job>.outputs.usage-report`. Direct action
steps also expose `usage-report-path`, a full sanitized ledger for later steps in
that same job. The local file is not a downloadable artifact. See
[report fields and retention](docs/ADVANCED.md#llm-usage-reports).

These observations do not establish billed dollars, plan percentages or a token
budget. Robin adds no model requests or usage-request parameters for reporting.

## Running on a self-hosted runner

By default, the reusable workflow runs on GitHub's hosted `ubuntu-latest` runner:

```yaml
with:
  runner: '"ubuntu-latest"'
```

To run reviews on your own machine, Mac mini, home server, local Linux box, or Coolify runner, pass `runner` as valid JSON. Use a JSON string for one label or a JSON array for multiple labels.

To create a local runner, go to:

```text
Repository Settings -> Actions -> Runners -> New self-hosted runner
```

Then add labels such as `local`, `linux`, `mac`, or `coolify`, and reference those labels through the `runner` input.

### Does the runner need to run all the time?

A matching self-hosted runner must be online when GitHub starts the review job. It can be a local runner process (`./run.sh`), a service (`./svc.sh start`), a Docker container, or a Coolify-managed service. Docker is optional; it is just one way to run the GitHub Actions runner.

If no matching runner is online, GitHub queues the job until one comes online. It will not fall back to `ubuntu-latest` unless you add a separate fallback job. For reliable PR reviews, keep an always-on runner available, such as a Mac mini, home server, VPS, or Coolify service. A laptop runner only works while the laptop is awake and the runner process or service is running.

> [!WARNING]
> Self-hosted runners can execute arbitrary workflow code.
> Do not use them for untrusted public pull requests.
> Prefer repo-owned private repos or trusted collaborators only.
> Consider ephemeral runners for stronger isolation.

Local machine runner:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      runner: '["self-hosted", "local"]'
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

Coolify runner:

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

## Optional: your own review identity

Robin uses `github-actions[bot]` by default. Existing workflows and the three-secret
setup need no changes. To post as your own GitHub App, create its token and run the
direct Robin action in the same job. Reusable-workflow callers can opt in by passing
the optional `ROBIN_TOKEN` secret, for example a fine-grained PAT.

See [Custom review identity](docs/ADVANCED.md#custom-review-identity) for complete
examples, permissions, PAT limitations, and installer behavior. Custom identity
workflows stay intact when you rerun either installer; update their refs manually.

## Using it day to day

| When | What happens |
| --- | --- |
| You open a PR | Review runs once automatically |
| You push more commits | No new review (saves time and API usage) |
| You want another review | Comment `/robin` on the PR (first line of the comment) |
| You want a short overview only | Comment `/summary` |
| You need help | Comment `/help` |

`/review` still works as an alias for `/robin`. Only people with **write** access (or higher) on the repo can run these commands by default.

## Example

The bot posts a status comment, then a review with severity counts:

```md
## <img src="https://www.robinreview.dev/brand/favicon-48.png" width="24" height="24" alt="" /> The <a href="https://www.robinreview.dev/">Robin</a> Hood of code review

<!-- :bow_and_arrow: Robin -->

> **Heads up:** this is a point-in-time review. Push fixes freely, then comment `/robin` whenever you want another pass.

🚨 **1 High** | ⚠️ **1 Medium** | 💡 **2 Suggestions**

### Summary
Focused change. Main risk: timeout errors are not handled clearly.

### Findings Not Posted Inline
**1 (`src/example.ts:24`)** — Retries exist but timeout failures lack context.
```

## Agent mode: reviews with repository context

Robin defaults to `agent-mode: auto` when neither an input nor base-branch config sets
the mode. A tool-capable model can read full files, grep for callers of a changed function,
and check types and tests at the PR's head commit before reporting a bug. Findings can come with a one-click GitHub
**suggested change** containing the exact fix.

- Robin downloads a read-only snapshot through the GitHub API; no checkout is needed and Robin never executes PR code.
- Tool rejection or snapshot failure triggers an attempted complete diff-only fallback, subject to `max-diff-size`. Warnings and the final status show the fallback reason; size or provider failures can still stop the review.
- Set `agent-mode: off` to skip the snapshot and tools. Use this for weak/local models until you have checked tool behavior, review quality and context capacity. `agent-max-turns` defaults to 40; extra requests can add time and usage.
- Context compaction summarizes investigation history within existing limits. It cannot guarantee that a small-context model fits or that a review completes. Explicit truncated output fails the review.

Details: [Agent mode](docs/ADVANCED.md#agent-mode-multi-turn-review-with-repository-context) and [migration guidance](docs/ADVANCED.md#default-change-and-migration).

## Robin in your editor

The one-line installer also installs a small **companion skill** into every coding agent
on your machine (Claude Code, Cursor, Copilot, Windsurf, …) via the cross-platform
[skills CLI](https://skills.sh) —
`npx -y skills add https://github.com/antongulin/robin --skill robin --agent '*' --global --yes`. It
ships with Robin; there's nothing separate to sign up for. (Skip it with `ROBIN_SKILL=0`,
or install it by hand with that command.) Once installed, the skill activates for ordinary
pull-request work: the agent detects Robin on the base branch, so you do not need to ask
for Robin explicitly. Explicit requests still work too:

> "create a pull request" · "review this PR with Robin" · "fix the Robin feedback"

The agent drives a bounded review → verify → fix → reply → resolve → re-review loop. It
fixes only findings confirmed against the full repository and skips noise with a factual
reply. Five completed Robin reviews are approved by default; above five, the agent asks
for one additional review at a time unless you explicitly enabled full-auto review for
that PR. Merge is a separate permission and remains manual by default. After an authorized
merge, the agent verifies base-branch sync and task-branch cleanup. Release preparation is
never automatic; when the repository already publishes releases, the final report may
offer it as a separate next step. Source: [skills/robin/SKILL.md](skills/robin/SKILL.md).

## Supported providers

| Provider | `LLM_BASE_URL` | `LLM_MODEL` example |
| --- | --- | --- |
| **OpenRouter (free)** | `https://openrouter.ai/api/v1` | `openrouter/free` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o`, `gpt-5-mini`, `o4-mini` |
| Anthropic (Claude) | `https://api.anthropic.com/v1` | `claude-sonnet-4-5` |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | a model ID supported by OpenCode Go |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| Ollama (your server) | `http://YOUR_SERVER:11434/v1` | `llama3.2` |

Anthropic works through its OpenAI-compatible endpoint with your regular Anthropic API key; pasting `https://api.anthropic.com` without `/v1` is fine too. Keep your existing OpenCode Go `LLM_API_KEY` and provider settings; Robin supplies the required User-Agent and a stable session ID automatically when the official Go endpoint is configured. For OpenCode Go with `deepseek-v4.1-flash`, set `reasoning-effort: max` in `.github/robin.yml` to send top-level `reasoning_effort: "max"`. Go rejections surface as errors; Robin keeps the configured effort on retries. OpenAI reasoning models (`o1`/`o3`/`o4-mini`, `gpt-5*`, `codex-*`) are sent without `temperature` and with `max_completion_tokens` automatically. See [Provider notes](docs/ADVANCED.md#provider-notes).

GitHub’s servers cannot reach `localhost` on your laptop. For Ollama at home, use a public server, a tunnel, or a [self-hosted runner](docs/ADVANCED.md#save-github-actions-minutes).

## Optional: config and custom rules

Copy [`.github/robin.yml.example`](.github/robin.yml.example) to `.github/robin.yml` to tune `estimated-request-token-budget`, `max-diff-size` and `agent-max-diff-size` together, skip extra paths, and more. The same file is the normal place to change `reasoning-effort` for providers that expose reasoning controls; when it is unset Robin sends no reasoning control and the provider/model decides, and `off` is an explicit way to send nothing. Details: [docs/ADVANCED.md](docs/ADVANCED.md#repository-config-file) and [Reasoning effort](docs/ADVANCED.md#reasoning-effort-provider-dependent).

### Optional settings index

Existing installations keep their current behavior without adding settings. Set
workflow inputs in the caller workflow's `with:` block (or the direct action's
`with:` block). Set repository config on the PR base branch in `.github/robin.yml`;
use `config-file` for another path.
See the [complete input reference](docs/ADVANCED.md#all-workflow-inputs) and
[config precedence](docs/ADVANCED.md#repository-config-file) for validation and exceptions.

Triggers, authors, and permissions:

| Setting | Default / behavior | Where |
| --- | --- | --- |
| `review-on-synchronize` | `false`; add the `synchronize` trigger too to review pushes | Workflow input |
| `bot-review-policy` | `all`; `none` skips GitHub Bot authors, `allowlist` permits listed bots plus humans | Workflow input or repo config |
| `bot-allowlist` | Empty list; exact case-insensitive logins. Comma-separated in workflow, YAML sequence in config | Workflow input or repo config |
| `min-command-permission` | `write`; minimum permission for slash commands | Workflow input |
| `github-token` / `ROBIN_TOKEN` | `github.token`; custom review identity | Direct action input / reusable workflow secret |
| `runner` | JSON string `"ubuntu-latest"`; runner label or array of labels | Reusable workflow only |

The [bot author filter](docs/ADVANCED.md#automatic-bot-pr-reviews) applies only to
automatic PR reviews. Authorized `/review` commands can review excluded bot PRs.
Blank bot inputs defer to base config; `bot-allowlist: '[]'` clears that list in workflow inputs.
Use `bot-allowlist: []` in repo config to clear it there. Choose `none` to exclude all bots.

Review scope, results, and instructions:

| Setting | Default / behavior | Where |
| --- | --- | --- |
| `max-diff-size` | `500000` characters for single-shot reviews and `/summary`; complete diff or fail | Nonblank workflow input overrides base config; blank inherits |
| `max-comments` | `15` inline comments; extra findings stay in the review body | Workflow input or repo config; config wins when input equals `15` |
| `skip-paths` | No extra exclusions; built-in generated-file exclusions still apply | Repo config only |
| `fail-on-high` | `false`; optionally fail the check on high findings | Workflow input |
| `request-changes` | `true`; high findings block the PR. `false` enables advisor mode | Workflow input or repo config |
| `review-instructions` | Empty; append instructions for code reviews | Workflow input |
| `review-instructions-file` | `.github/code-reviewer.md`, read from the base branch | Workflow input |
| `config-file` | `.github/robin.yml`, read from the base branch | Workflow input |

Model requests and repository context:

| Setting | Default / behavior | Where |
| --- | --- | --- |
| `llm-api-key` / `LLM_API_KEY` | Blank direct action input uses the public `ollama` placeholder; reusable workflow requires the secret | Direct action input / reusable workflow secret |
| `estimated-request-token-budget` | `256000` estimated tokens per request, including input, output and safety; `off` disables the estimate/default output cap | Nonblank workflow input overrides base config; blank inherits |
| `max-output-tokens` | Unset: scales with enabled budget up to `32000`; guard off: provider/model default | Positive safe integer workflow input; explicit cap is preserved |
| `reasoning-effort` | Unset; provider/model decides. `off` sends no reasoning configuration | Workflow input or repo config |
| `llm-timeout-ms` | `600000` milliseconds (10 minutes) | Workflow input |
| `llm-temperature` | `0.1`, range 0–2; model-specific exceptions apply | Workflow input |
| `use-json-response-mode` / `json-response-mode` | `true`; request structured review output, with provider fallbacks | Workflow input / repo config key |
| `agent-mode` | `auto` (repository tools with bounded diff-only fallback); explicit `off` uses single-shot | Nonblank workflow input overrides base-branch repo config; blank inputs defer |
| `agent-max-turns` | `40`, capped at `100` | Workflow input or repo config |
| `agent-max-diff-size` | `500000` characters up front in agent mode; a larger filtered diff fails before the agent request and the single-shot fallback uses `max-diff-size` | Workflow input or repo config |

Blank inputs for `request-changes`, `reasoning-effort`, `use-json-response-mode`,
`max-diff-size`, `estimated-request-token-budget` and the three `agent-*` settings defer to repo config, then to these defaults. Omit the
boolean `request-changes` input on reusable-workflow callers to defer to repo config.
The required model and endpoint remain `LLM_MODEL` and `LLM_BASE_URL` secrets
(direct action inputs `model` and `llm-base-url`).

### Custom reviewer rules

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
| `/robin` does nothing | Put `/robin` on the **first** line; you need write access on the repo. On `@v1`, pin `@v1.4.0`+ or use `/review` if the tag predates v1.4.0 |
| Review fails with a diff-size message | The filtered diff is larger than the selected cap, so Robin stops before the model request instead of reviewing part of it — see [docs/ADVANCED.md](docs/ADVANCED.md) (`max-diff-size`, `agent-max-diff-size`) |
| `Empty response from LLM` | Free routers sometimes return no text — the action retries automatically; comment `/robin` again |
| `OpenRouter stall` / job runs 45 min with no review | Auto-router hung — action now aborts after 45s with no stream and retries | Watch Actions log for `LLM resolved model` (routing OK); pin `@v2` or `@main` for the fix |
| `404 Provider returned error` | Normal for `openrouter/free` when one provider is down — the action retries up to 5 times; keep `LLM_MODEL=openrouter/free` |
| `temperature` / `max_tokens` rejected by the model | The action warns, retries once with the parameter renamed or dropped (or with `max_completion_tokens`), and keeps that shape for the run. If the endpoint rejects both token-cap spellings, the provider error surfaces rather than running uncapped. To pin a value some models insist on (Kimi requires `1`), set `llm-temperature` in your workflow's `with:` block, see [docs/ADVANCED.md](docs/ADVANCED.md#models-that-require-a-fixed-temperature) |
| `reasoning-effort` rejected as unsupported or invalid | On the official OpenCode Go endpoint, the error surfaces without dropping the configured effort. For other providers, the action warns, retries once with no reasoning override, and completes the review when that retry succeeds. After that fallback, the final status comment tells you to update `reasoning-effort` in `.github/robin.yml` or the workflow `with:` block. With no value configured Robin sends no reasoning control at all, so nothing is rejected. Set `reasoning-effort: off` to be explicit |

More fixes: [docs/ADVANCED.md#troubleshooting](docs/ADVANCED.md#troubleshooting)

## Version pins

For a **direct action step** (`uses: antongulin/robin@…`):

| Action ref | Behavior |
| --- | --- |
| `@main` | Latest changes on the default branch |
| `@v2` | Latest `2.x` release (updated on each release) |
| `@v2.13.0` | This release's action implementation, with the default of `auto` |
| `@v2.12.4` | That release's action implementation, including its previous default of `off` |
| Full commit SHA | The action implementation at that commit |

For a **reusable workflow**, the ref selects the workflow file. The verified workflow
files at `main`, `v2` and `v2.12.4` call `antongulin/robin@main` inside the job. Even an
exact tag or SHA of those workflow files does not freeze the nested action. Those
callers receive action changes from `main` independently of the outer workflow's release.

```yaml
uses: antongulin/robin/.github/workflows/review.yml@v2
```

This example follows the v2 workflow while its nested action follows `main`. To keep
diff-only mode, set [explicit `off`](docs/ADVANCED.md#default-change-and-migration).
To pin the implementation, use a direct action step at an exact release or full SHA
with the required permissions and credentials; see the [direct action example](docs/ADVANCED.md#custom-review-identity).

Releases and notes are published automatically from [CHANGELOG.md](CHANGELOG.md) when changes land on `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) for commit message format.

## Learn more

- [docs/ADVANCED.md](docs/ADVANCED.md) — all settings, strict mode, manual-only reviews, security notes
- [CONTRIBUTING.md](CONTRIBUTING.md) — run tests and send pull requests
- [CHANGELOG.md](CHANGELOG.md) — release history

## Support

Robin is free and open source (MIT). If it saves you money on code review, you can help keep it maintained:

- ⭐ Star the repo — it's the cheapest way to help others find it.
- 💛 [Sponsor the project](https://github.com/sponsors/antongulin) to support ongoing work.
- 🐛 [Open an issue](https://github.com/antongulin/robin/issues) for bugs or ideas.

Built by [Anton Gulin](https://github.com/antongulin), AI Architect building AI systems, agent workflows, and software automation. Need a custom AI agent, code-review pipeline, or QA automation? Visit [Anton.QA](https://www.anton.qa).

## Development

```bash
git clone https://github.com/antongulin/robin.git
cd robin
npm ci
npm run lint
npm test
npm run build
```

Runtime code lives in `dist/index.js`; run `npm run build` before releasing. A full build removes intermediate files under `dist/` after bundling so only `index.js` remains locally (same file CI checks against).

If you ran `tsc` alone and see extra files under `dist/`, run `npm run clean`.
