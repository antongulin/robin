# <img src="https://www.robinreview.dev/brand/favicon-48.png" width="32" height="32" alt="" /> Advanced guide

This document is for maintainers and power users. For a short setup, see the [README](../README.md).

## Repository config file

Copy [`.github/robin.yml.example`](../.github/robin.yml.example) to `.github/robin.yml` on your default branch.

```yaml
max-diff-size: 25000
max-comments: 10
json-response-mode: true
request-changes: true
# bot-review-policy: none   # optional: skip automatic reviews of GitHub Bot authors; default all
# bot-allowlist: []   # use a sequence of logins with bot-review-policy: allowlist
# reasoning-effort: high   # unset: no reasoning control is sent (provider default). Set low/medium/high/… to send it, or "off" to be explicit
# agent-mode: off   # unset: auto (repository tools). Set off for a diff-only review
# agent-max-turns: 40
# agent-max-diff-size: 500000
skip-paths:
  - "**/generated/**"
```

| Key | Purpose |
| --- | --- |
| `max-diff-size` | Blank input inherits base config, then `500000`. Counted after `skip-paths` and built-in exclusions; a larger filtered diff fails before the corresponding single-shot review or summary request instead of being truncated. This also applies to a single-shot fallback or structured retry after an agent request |
| `max-comments` | Used when the workflow still passes the action default (`15`) |
| `json-response-mode` | Used when `use-json-response-mode` is empty (action default defers to this file) |
| `request-changes` | Used when `request-changes` input is empty. `true` (default) blocks on high findings; `false` posts advisor-only comments |
| `reasoning-effort` | Used when the `reasoning-effort` action/workflow input is empty. Provider-dependent reasoning value; when both are unset no reasoning control is sent and the provider/model decides, `off` also sends no reasoning configuration |
| `agent-mode` | Used when the `agent-mode` input is empty. When both are unset, `auto` runs the [multi-turn agent review](#agent-mode-multi-turn-review-with-repository-context). Explicit `off` uses a single-shot diff review without a snapshot or tools |
| `agent-max-turns` | Used when the `agent-max-turns` input is empty. Tool-calling turns before the final review is requested (default `40`, max `100`) |
| `agent-max-diff-size` | Used when the `agent-max-diff-size` input is empty. Diff characters sent up front in agent mode (default `500000`); a larger filtered diff fails before the agent request. `max-diff-size` still applies to the single-shot fallback |
| `estimated-request-token-budget` | Blank input inherits this setting, then `256000`; positive safe integer or `off`. See [request budgets](#estimated-request-budget) |
| `skip-paths` | Extra paths removed from the diff before the LLM call |
| `bot-review-policy` | `all` (default), `none`, or `allowlist`; blank action/workflow input defers here. Applies to automatic PR reviews only |
| `bot-allowlist` | YAML sequence of string logins (default empty); blank action/workflow input defers here. Used by `allowlist` policy; `[]` clears the list |

Lockfiles (npm, yarn, pnpm, Cargo, Gemfile, poetry), `dist/`, `node_modules/`, and minified assets are always skipped automatically. If every changed file is skipped, the action posts a status comment and skips the LLM call.

The config file uses a small YAML subset (line-based keys only), not full YAML nesting.

Read configuration from the PR base branch: changing it only in the PR does not
change that PR's settings. For `bot-review-policy`, `bot-allowlist`,
`reasoning-effort`, `request-changes`, `use-json-response-mode`, the three `agent-*`
inputs, `max-diff-size` and `estimated-request-token-budget`, a nonblank input
overrides the corresponding config key. Empty
or omitted input defers to config, then to the documented default. Omit the boolean
`request-changes` input on reusable-workflow callers to defer; direct action callers
can use an empty string. `use-json-response-mode` maps to config `json-response-mode`.

`max-diff-size` no longer uses the old numeric-default sentinel: an explicit
`50000` wins over config, including values forwarded by older reusable workflows.
All three budget/character metadata defaults stay blank. `max-comments` retains its
existing convention: config wins when the workflow passes `15`. `skip-paths` has
no workflow input. Other inputs have no repository-config equivalent. The example's
`25000` and `10` are sample overrides, not defaults.

## Estimated request budget

Robin defaults to a decimal **256000 estimated tokens per request**. This working
budget applies to arbitrary provider/model IDs, including custom local endpoints;
Robin does not discover capacity or load a tokenizer/model registry. Set it below
your endpoint's effective context when needed. Published context sizes and supported
output caps can differ from the capacity your deployment makes available.

The `utf8-json-div3-v1` heuristic uses the complete final Chat Completions JSON body
serialized by the installed SDK (two-space indentation):

- Estimated input = `ceil(UTF-8 bytes / 3)`, including stream mode, annotated diff,
  instructions, history, private assistant replay, tool schemas/calls/results and
  response format. Authentication headers and usage-report metadata are excluded.
- Safety headroom = `ceil(budget / 16)`.
- Unset `max-output-tokens` sends `max(1, min(32000, floor(budget / 8)))` as the output
  cap. An explicit positive safe integer is sent unchanged and reserved in full.
- A request proceeds only if estimated input + output cap + safety <= budget.
  Equality passes. Preflight failure makes no provider call and adds no physical
  attempt to the usage ledger; earlier observed usage stays in that report.

At 256000, the 32000 output cap and 16000 safety leave **208000 estimated input**.
The output cap is a behavior change, not passive usage reporting. Robin tries the
endpoint's alternate cap spelling on parameter rejection but never drops or clamps
the cap. Unsupported caps can fail; choose a supported explicit value.

This heuristic can accept a request the provider cannot fit or reject one it could
fit. JSON bytes differ from actual tokenization and chat framing; the safety reserve
is heuristic too. Unicode, escaped content, annotations and large instructions can
push an otherwise eligible diff over budget. Estimates do not replace provider-reported
tokens, establish a hard token ceiling, or prove that a request fits your model.

Both independent raw limits default to **500000 JavaScript string characters**.
This allowance leaves working room; it is not an exact conversion from 256k.
Passing a raw cap does not establish whole-request fit. Tune all three controls for
your endpoint, for example on the **PR base branch**:

```yaml
estimated-request-token-budget: 64000
max-diff-size: 100000
agent-max-diff-size: 100000
```

The same controls work in a caller job/direct step's existing `with:` block as quoted
strings. A nonblank input wins over config, then internal defaults. Increasing the
working budget never increases an explicit raw cap. Numeric settings must be positive
safe integers; malformed explicit values fail before dispatch without echoing them.
Quoted config numbers/`off` and inline comments work.

For the previous single-shot/provider-default output request shape:

```yaml
# .github/robin.yml on the PR base branch
agent-mode: off
estimated-request-token-budget: off
# Leave the workflow's max-output-tokens unset for provider-default output.
```

The estimate and default output cap turn off together. Explicit output/character caps
still apply. Override any existing nonblank workflow inputs too. There is no automatic
disable on provider rejection. `/summary`, structured retries, outer retries,
compatibility rebuilds, compaction and forced-final requests all face the same guard.
A complete diff-only fallback must fit its actual request; Robin never clips the diff.

Each agent turn resends its accumulated investigation after bounded compaction.
**Total invocation usage can exceed 256000 tokens** across these requests. A new
`/robin` starts a fresh conversation with the current PR diff/head; it does not resume
the previous investigation. The [usage report](#llm-usage-reports) records actual
provider observations separately from this per-request estimate.

## Automatic bot PR reviews

`bot-review-policy` controls automatic `pull_request` reviews:

| Value | Review eligibility |
| --- | --- |
| `all` | Everyone, including bot authors. Default; existing installations need no changes |
| `none` | Everyone except authors whose GitHub user type is `Bot` |
| `allowlist` | Humans plus Bot authors whose login appears in `bot-allowlist`. An empty list excludes all bots |

Robin checks the PR author's GitHub type and login, not the actor who opened,
reopened, or updated the PR. Automated ordinary `User` accounts and unknown author
types remain eligible. Login matches are exact and case-insensitive; policy values
are `all`, `none`, and `allowlist` in lowercase. Include the full login, such as
`dependabot[bot]`, rather than a display name or a substring.

Choose one source, or override base config with nonblank workflow inputs:

```yaml
# .github/robin.yml on the PR base branch
bot-review-policy: allowlist
bot-allowlist:
  - "dependabot[bot]"
  - "renovate[bot]"
```

```yaml
# Caller job's with: block (also supported by the direct action)
with:
  bot-review-policy: allowlist
  bot-allowlist: "dependabot[bot],renovate[bot]"
```

Omitted, empty, or whitespace-only bot inputs defer to the same setting in base
config. An explicit `bot-review-policy: all` overrides a restrictive base policy.
To clear a base allowlist from the workflow, pass `bot-allowlist: '[]'`; an empty
string defers rather than clearing. In repo config, use `bot-allowlist: []` or an
empty sequence. Removing the repo key also leaves an empty list. Clearing the list
only excludes bots under `allowlist`; use `none` to exclude all Bot authors.

The config parser accepts a block sequence of string logins or `[]` for the list;
nonempty inline arrays, scalar lists, nested mappings, and non-string entries are
invalid. Quote numeric or YAML boolean-like login strings. Invalid policy/list
values produce an Actions warning and skip automatic Bot-author reviews, including
under `all`; they do not silently restore the permissive default. A valid workflow
input replaces an invalid config value for that same setting. Human reviews and
authorized manual commands continue.

Robin logs the reason for a filtered skip before fetching the diff, downloading a
snapshot, creating a status comment, or contacting the LLM. A successful skipped
run does not mean a review was posted. A maintainer can comment `/review` on an
excluded bot PR; existing `min-command-permission` checks still apply, and Robin
still ignores bot-authored comments. Synchronize reviews also require the existing
`review-on-synchronize` opt-in and workflow trigger.

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
2. The workflow verifies release PR heads with read-only permissions, including while approval is pending. After successful verification, PRs without the required approval report **WAITING**. A maintainer reviews and merges them; automation can also merge an approved, verified head under the existing rules.
3. The workflow updates `package.json`, `CHANGELOG.md`, creates tag `vX.Y.Z`, and publishes [GitHub release notes](https://github.com/antongulin/robin/releases).
4. The workflow moves floating `v<major>` and `v<major>.<minor>` tags to the new release. For v2 and later, it also keeps `v1` at the latest `1.x` tag.

The main push after a maintainer merge resumes publication from that PR's exact
merge SHA. Bot-token merges publish in the same run, then dispatch npm at the
exact release tag because GitHub suppresses token-generated release events.

For recovery, run **Release** on **main** with `release-pr` set to the release PR
number. Recovery verifies the merged tree even if GitHub deleted the source branch,
and matching existing releases remain safe to resume without moving newer floating
tags backward. See [Release approval and recovery](../CONTRIBUTING.md#release-approval-and-recovery)
for commands and failure states. Do not create tags or releases by hand.

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

- Leave `synchronize` out of the trigger (the shipped default) so Robin reviews once when the PR opens and you comment `/review` after fixes (see [Review every push (opt-in)](#review-every-push-opt-in)).
- Use a smaller `max-diff-size` for huge PRs.
- **Free tier:** GitHub Free includes about **2,000 Actions minutes/month** for public and private repos; GitHub Pro about **3,000 minutes/month** (limits can change — see [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) for your account).
- **Heavy usage:** use a [self-hosted runner](https://docs.github.com/en/actions/hosting-your-own-runners) so LLM wait time does not consume hosted minutes.

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

Available on the [direct action](../action.yml) and the [reusable workflow](../.github/workflows/review.yml), unless noted. LLM credentials are action inputs / reusable-workflow secrets respectively.

| Input | Default | Description |
| --- | --- | --- |
| `github-token` / `ROBIN_TOKEN` | `${{ github.token }}` | Token for PR API and comments. Direct action input / optional reusable-workflow secret. See [Custom review identity](#custom-review-identity) |
| `llm-api-key` / `LLM_API_KEY` | Direct action: `ollama` | Provider API key; the reusable workflow requires the secret |
| `llm-base-url` / `LLM_BASE_URL` | — | OpenAI-compatible base URL (required) |
| `model` / `LLM_MODEL` | — | Model name (required) |
| `fail-on-high` | `false` | Fail the check if high-severity issues are found |
| `request-changes` | omit → `true` (defer to repo config) | `true` submits a blocking REQUEST_CHANGES review on high findings; `false` posts a non-blocking COMMENT (advisor mode). Reusable workflow input is a boolean with no default — omit it to let `.github/robin.yml` win |
| `max-diff-size` | empty (base config, then `500000`) | Max diff characters for a single-shot review or `/summary`, after path filters. A larger filtered diff fails before the model request with its observed size and this limit |
| `estimated-request-token-budget` | empty (base config, then `256000`) | Estimated input + sent output cap + safety per request; `off` disables this guard/default output cap. See [request budgets](#estimated-request-budget) |
| `max-output-tokens` | empty | Positive safe integer; unset with enabled budget sends a scaled cap (default `32000`); unset with guard off uses provider/model default |
| `reasoning-effort` | empty (defer to repo config; unset anywhere sends nothing) | Provider reasoning effort, provider-dependent (for example `low`, `medium`, `high`). Empty defers to `.github/robin.yml`; if that is also unset, no reasoning control is sent and the provider/model default applies. `off` also sends no reasoning configuration |
| `llm-timeout-ms` | `600000` | LLM timeout (10 minutes) |
| `llm-temperature` | `0.1` | Sampling temperature (0–2). Raise only if your model rejects the default — some models accept a single fixed value (Kimi requires `1`) |
| `max-comments` | `15` | Max inline comments |
| `review-on-synchronize` | `false` | Reusable workflow / action input. When the workflow triggers on `synchronize`, set `true` to review every push to an existing PR; default `false` skips pushes and re-reviews with `/review` |
| `bot-review-policy` | empty (defer to repo config, then `all`) | Automatic PR review policy: `all`, `none`, or `allowlist`. See [Automatic bot PR reviews](#automatic-bot-pr-reviews); authorized manual commands bypass the filter |
| `bot-allowlist` | empty (defer to repo config, then empty list) | Comma-separated exact, case-insensitive bot author logins; `[]` clears the base list. An empty list excludes all bots under `allowlist` |
| `runner` | `'"ubuntu-latest"'` | Reusable workflow only: runner as a JSON string or JSON array |
| `min-command-permission` | `write` | Minimum repository permission for slash commands: `read`, `triage`, `write`, `maintain`, or `admin` |
| `review-instructions` | empty | Extra prompt text for code reviews (not `/summary`); appended to the built-in prompt alongside the rules file |
| `review-instructions-file` | `.github/code-reviewer.md` | Rules file on the base branch for code reviews; empty disables this file. Missing files do not block review |
| `config-file` | `.github/robin.yml` | Repo config path on the base branch |
| `use-json-response-mode` | empty (defer to repo config, else true) | Request strict JSON-schema output (`response_format: json_schema`) for reviews, stepping down to `json_object` and then to no `response_format` if the provider rejects it. Pass `"true"` / `"false"` on the reusable workflow |
| `agent-mode` | empty (defer to repo config, then `auto`) | `auto` lets the model read the repository with tools before reviewing. Tool rejection or snapshot failure attempts a complete diff-only fallback subject to `max-diff-size`; explicit `off` skips the snapshot/tools and uses single-shot |
| `agent-max-turns` | empty (defer to repo config, then `40`) | Maximum tool-calling turns in agent mode (capped at 100) |
| `agent-max-diff-size` | empty (defer to repo config, then `500000`) | Diff characters sent up front in agent mode, after path filters. A larger filtered diff fails before the agent request with its observed size and this limit; agent tools read PR head files, so they cannot restore dropped diff hunks. `max-diff-size` still applies to the single-shot fallback |

## Agent mode (multi-turn review with repository context)

With `agent-mode: auto`, `/review` uses a multi-turn conversation with repository tools.
Robin selects `auto` when neither the input nor base-branch `.github/robin.yml` sets
`agent-mode`. Explicit `off` selects a single-shot diff review and skips snapshot/tool
work. `/summary` stays single-shot in either mode.

### Default change and migration

The new default applies on `main` and is planned for v2.13.0, the next v2 minor release.
In v2.12.4's direct action, an unset mode selected `off`. The reusable workflows at
`main`, `v2` and `v2.12.4` call the action at `@main` inside the job, so their callers
can receive this change when it merges to `main`, before the minor release publishes.
A tag or SHA pin of those workflow files pins only the outer workflow. Direct action
refs differ: `antongulin/robin@v2.12.4` keeps that release's implementation, a full
action SHA keeps that commit, and direct `@v2` follows the floating release tag.

To keep the previous diff-only behavior, commit this to the **PR base branch**
(usually your default branch). A config change only on the feature head does not
affect that PR's settings:

```yaml
# .github/robin.yml
agent-mode: off
```

For a reusable-workflow caller, add or update the mode in the job's existing `with:`
block, keeping its other inputs and secrets:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      agent-mode: "off"
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

For a direct action step, add the same input to that step's existing `with:` block:

```yaml
- uses: antongulin/robin@main
  with:
    github-token: ${{ github.token }}
    llm-api-key: ${{ secrets.LLM_API_KEY }}
    llm-base-url: ${{ secrets.LLM_BASE_URL }}
    model: ${{ secrets.LLM_MODEL }}
    agent-mode: "off"
```

A recognized nonblank input (`auto` or `off`) wins over base-branch config. Blank or
omitted inputs defer to that config, then to `auto`. If your workflow already passes
`auto`, change that input to `"off"`; adding config `off` alone will not override it.
Robin leaves both metadata defaults blank to preserve this precedence.

### Model compatibility and usage

Repository tools let the model check callers, types and tests before reporting findings.
They also let it send additional repository content to your configured LLM endpoint.
The snapshot download and extra requests can add network traffic, runner time, tokens
and provider usage. Choose explicit `off` for weak, local or small-context models until
you have verified their behavior on representative changes.

Tool support is a protocol requirement, separate from review quality and context
capacity. A local endpoint may reject tools; a model may accept tools but ignore them,
misuse them or return poor findings. Robin does not detect model quality or choose a
mode from the model name. Neither mode guarantees compatibility with a local model.
Character caps are not token/context guarantees: even a 50k-character diff plus prompts
and output may exceed a small model's effective context. Lower limits or reduce the PR
scope to match the model you run; compaction cannot guarantee a fit.

### Investigation and limits

1. Robin downloads the PR head commit as a tarball through the GitHub API and unpacks it
   into the runner's temp directory. No `actions/checkout` step is needed, and the code is
   only read, never executed.
2. The model gets the line-numbered diff plus three read-only tools: `read_file`, `grep`,
   and `list_files`. It uses them to read full files, find callers of changed functions,
   and look up definitions before it decides something is a bug.
3. When it has enough context it returns the usual JSON review. Findings can include an
   exact replacement for the affected lines, which Robin posts as a one-click GitHub
   **suggested change** when every line in the range is in the same diff hunk.

The investigation uses these limits. Match them to your model and workload:

| Limit | Default |
| --- | --- |
| Tool-calling turns | 40 (`agent-max-turns`, max 100) |
| Diff sent up front | 500k characters (`agent-max-diff-size`); a larger filtered diff fails before the agent request. The single-shot fallback keeps `max-diff-size` (500k) and fails before that request if the filtered diff exceeds it. Neither cap guarantees a fit in the model's context |
| Tool calls per turn | 16 |
| Investigation time | 30 minutes |
| Output per tool call | about 50k characters (`read_file` returns up to 2000 lines and says where to continue) |
| `grep` | 300 matches, optional `context_lines` (0-5), files up to 2 MB, up to 100k files scanned |
| `list_files` | 2000 entries |
| Repository snapshot | 500 MB compressed |

When the turn or time limit runs out, Robin asks the model for its final review without
tools.

**Context compaction.** An early pressure valve targets about 450k characters across
the diff and tool output, with at least 150k for tool output. This is independent of
request fit and makes no token-capacity guarantee. Robin also compacts when the
estimated request guard or provider context limit rejects a request. The model writes
notes about the investigation so far: suspected bugs with evidence, facts it established,
what it already checked, and what's left. Robin then continues from those notes plus the
latest tool turn. If the summary request itself fails, Robin falls back to dropping the
oldest tool results. Summary requests use the same estimate, with up to three
shrinking transcripts. A review can compact up to six times; local budget recovery
stops when it cannot shrink the conversation. Base input and oversized notes or
assistant history can still fail without a provider call.

**Fallback.** If the model or provider rejects tool calling (for example OpenRouter's
"No endpoints found that support tool use", or Ollama's "does not support tools"), the
snapshot download fails, or the agent loop errors, Robin logs a warning and attempts a
single-shot diff review. The final status identifies a completed fallback and its reason;
a failed status reports the failure. The fallback sends the complete filtered diff only
if it fits `max-diff-size` and the estimated request budget; a larger diff or
request fails before dispatch. Provider or output
failures can still prevent a review. Robin downloads the snapshot before it can learn
that the endpoint rejects tools. Explicit `off` avoids that work. `/summary` stays
single-shot and uses `max-diff-size`.

Explicit `finish_reason=length` is an exception: the output is incomplete, even if it
contains text or tool calls. Robin discards that partial output and fails the review
without retrying the same request or starting a single-shot fallback. The error includes
available token counts (including reasoning tokens when returned); these counts do not
establish which limit caused the truncation. Check the model/provider's output and
reasoning generation limits and reduce the review scope. If the input is too large,
split the change into smaller logically complete PRs, keeping related implementation
and tests together, or select a model/provider with larger effective context capacity.
After adjusting the cause, comment `/robin` to try again. Missing finish metadata remains compatible.
If a compaction summary fails, the mechanical recovery described above still drops old
tool results and continues with changed context.

Agent mode can make more requests and consume more tokens than a single-shot review.
The reusable workflow's job timeout is 45 minutes. Lower `agent-max-turns` to limit
investigation turns, or set explicit `agent-mode: off` for diff-only reviews. Turn, tool-call
and compaction statistics describe the investigation; they are not total request counts,
cost analytics, a whole-run token ceiling or a measure of review quality. Retries,
compaction and a fallback can add requests beyond the reported investigation turns.

## LLM usage reports

Robin records metadata at each physical SDK dispatch, below its outer and
request-compatibility retry loops. The ledger retains preceding work when an empty
response, truncation, compaction failure, parsing/posting error or diff-only fallback
ends or changes the review. `/summary` has its own phase. Accounting does not change
request parameters, effort, output limits, retries, character caps or the verdict.
It does not request extra usage chunks from providers that omit them.

### Outputs and retention

| Surface | Contents and lifetime |
| --- | --- |
| Actions job summary | Concise branded totals/coverage and escaped aggregate JSON in a details block |
| `usage-report` action output | Compact aggregate JSON, also mapped through the reusable job to `workflow_call.outputs.usage-report` |
| `usage-report-path` action output | Full sanitized JSON ledger in a uniquely owned runner-temp file; available to later steps in the **same job** |

Use `needs.<review-job>.outputs.usage-report` in a dependent caller job. The reusable
workflow does **not** forward its local file path or upload an artifact. To retain
individual attempts, use the direct action in a job you control, give its step an
`id`, and consume `steps.<id>.outputs.usage-report-path` in a later step. You own
optional upload, access and retention. Runner/OS temp cleanup controls the local
file's lifetime; it is not a durable download.

Robin attempts each sink independently on handled completion/failure. A reporting
failure produces a fixed warning and does not fail the review. Failed-job outputs
may be unavailable; the summary also contains the compact JSON. Abrupt termination,
the existing signal-exit path, OOM and runner loss can prevent any final report.
No report guarantees consumption visibility for an interrupted in-flight request.

### Schema version 1 and coverage

The aggregate contains invocation UUID, repository/PR, head SHA and provenance,
command, Actions run ID/attempt, state, requested model/effort, provider class,
logical-call and physical-attempt counts, outcomes/triggers, per-phase counts and
metrics, model groups, and agent activity when a completed agent review supplies it.
The full file adds `ledger`, one record per physical attempt, with logical-call ID,
phase and optional agent/compaction ordinals, outer/compatibility attempt ordinals,
retry trigger, compatibility adjustment, streaming state, sent model/effort/output
limit, reported model, finish/outcome and numeric observations. Metadata-only phase
context never goes to the provider.

`metrics` contains `prompt_tokens`, `completion_tokens`, `total_tokens`,
`cached_input_tokens` and `reasoning_tokens`. Each metric has:

| Field | Meaning |
| --- | --- |
| `observed_sum` | Sum of known safe nonnegative integers, or `null` with no observations or arithmetic overflow |
| `observed_attempts` / `final_attempts` | Attempts with a numeric observation / a final, nonconflicting observation |
| `unknown_attempts` / `nonfinal_attempts` | Attempts missing that metric / attempts with observations that cannot establish final counts |
| `complete` / `overflow` | Whether all dispatched attempts have final counts and collector coverage is intact / safe integer addition overflowed |

An explicit reported zero is valid. Missing usage, timeouts and failed requests do
not mean zero tokens. A zero-dispatch failure has no known token sum and zero
unknown dispatched attempts. Prompt, completion and reported total sum independently;
Robin does not invent absent totals or reconcile provider inconsistencies. Cached
input and reasoning are breakdowns (subsets of prompt and completion in OpenAI's
contract); Robin never adds them again. Compatible providers may define these
fields differently. Totals do not establish dollars, OpenCode Go plan percentages,
account-level attribution or review quality, and enforce no token budget.

For cumulative stream usage, Robin keeps the latest valid value **per metric** and
counts it once. Earlier-only fields, decreasing counters and interrupted streams
retain observations with incomplete coverage. A reported model change sets
`model_conflict`. No response model means `null`; Robin does not substitute the
requested model. Requested effort and the actual sent field/value/state remain
separate, including `off`, `unset`, `not-sent` and `removed-by-compatibility`.
`collector_incomplete` marks an observation failure. Compact JSON stays within
64 KiB UTF-8 by omitting only model-group details with `model_groups_omitted` set to
the omitted count; all counts/metrics and the full local ledger remain intact.

PR events supply an `event` head snapshot. Comment-triggered runs reuse fetched PR
metadata or try a best-effort read and label the head `observed`. Unknown stays
`null`; the Actions checkout SHA is not a substitute for the PR head. This is
correlation, not proof that the diff and head were acquired atomically.

The report copies allowlisted metadata and safe numeric fields. It excludes prompt,
source, tool arguments/results, private reasoning, credential values and raw request,
response and error bodies. Model/effort identifiers have a bounded grammar and known
configured credentials are suppressed. Treat provider-supplied identifiers as
untrusted metadata; this does not audit existing SDK/debug/error logs. Only usage
already exposed by the SDK (including a preserved `error.usage` envelope) is visible;
usage discarded by SDK error parsing remains unknown.

## Review timing

Measure the review job and its Robin step separately in GitHub Actions:

| Measurement | Calculation | What it includes |
| --- | --- | --- |
| Queue/start delay | Job start minus run creation | Time before this job starts, including any prerequisite jobs |
| Job duration | Job completion minus job start | Runner setup, action download, Robin and cleanup |
| Robin step duration | Robin step completion minus step start | Diff/snapshot preparation, model requests, retries and posting |
| Observed LLM request interval | Response or failure log timestamp minus the corresponding `LLM attempt` timestamp | Request wait, including any parameter fallback inside that attempt; not pure model inference time |

A successful job can skip a review or handle `/help`. Confirm `Posted review #…`
and the linked PR review before counting it as a completed review. Track failed,
cancelled, skipped and still-running jobs separately.

Agent mode can make many model requests before producing a review. At its turn or
investigation time limit, Robin asks for a final answer without tools. If that fails,
Robin can start a single-shot fallback, whose requests have their own timeout and
retries. The investigation budget therefore does not cap total job duration; the
workflow job timeout still applies. Look for `Agent turn`, fallback warnings,
`LLM attempt` and `Retrying LLM request` in the log.

To compare providers, match repository, review mode, diff size, Robin revision and
retry behavior, and check that requests started after the provider change. Masked
base URLs and model IDs cannot prove which endpoint or model served a request.
Secret-write receipts establish intended configuration at that time; keep that
attribution separate from direct runtime evidence. A few unmatched jobs cannot
establish a provider speedup.

## Usage patterns

### Advisor mode (never block the PR)

Useful when Robin is an assistant and humans own merge decisions. Prefer `.github/robin.yml` for repo-wide defaults; use the workflow input to override per workflow:

```yaml
# .github/robin.yml
request-changes: false
```

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      request-changes: false   # boolean; omit this line to defer to .github/robin.yml
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

### Review every push (opt-in)

The shipped template reviews once when the PR opens (and on `/review`). To also review
every push to a PR, add `synchronize` to the trigger and set `review-on-synchronize: true`:

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
    timeout-minutes: 45
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

### Provider notes

Every provider is reached through the OpenAI chat-completions wire format. Robin
normalizes the base URL (trailing slash, a pasted `/chat/completions` or `/messages`
suffix, a missing `/v1` on the OpenAI and Anthropic hosts) and adjusts the request shape
for the hosts below. Self-hosted and proxy URLs are passed through unchanged.

| Provider | `LLM_BASE_URL` | Notes |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `reasoning-effort` is sent as OpenAI-native `reasoning_effort`. Reasoning models (`o1`, `o3`, `o4-mini`, `gpt-5*`, `codex-*`) are sent without `temperature` and with `max_completion_tokens` instead of `max_tokens`, because they reject both |
| Anthropic (Claude) | `https://api.anthropic.com/v1` | Uses Anthropic's [OpenAI SDK compatibility](https://docs.anthropic.com/en/api/openai-sdk) endpoint with your regular Anthropic API key (`LLM_API_KEY`). `https://api.anthropic.com` without `/v1` is accepted. JSON mode sends Robin's review schema as a best-effort `response_format: json_schema`, but Anthropic's compatibility endpoint ignores `response_format` (guaranteed structured output requires the native Claude API), so the review relies on the prompt plus the markdown fallback parser. If a model rejects the field, Robin drops it and falls back the same way. Anthropic ignores reasoning controls — Robin sends none there and Claude picks its own thinking depth. `temperature` above `1` is capped by Anthropic |
| OpenRouter | `https://openrouter.ai/api/v1` | `reasoning-effort` uses the OpenRouter `reasoning: { effort, exclude }` object; router models get stall detection and provider fallbacks |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | Keep your existing `LLM_API_KEY` and provider settings; Robin supplies the required User-Agent and one UUID `x-opencode-session` per client run, reusing it across retries and turns. This is automatic only for the official Go endpoint. Configured effort uses top-level `reasoning_effort`; rejections surface without dropping it. See [OpenCode Go](https://opencode.ai/docs/go/#where-can-i-use-it) |
| Anything else (Groq, Ollama, vLLM, gateways) | provider URL | Default request shape; unsupported parameters are recovered as described below |

### Models that reject request parameters

Newer models refuse parameters older ones accepted — OpenAI reasoning models return
`Unsupported value: 'temperature' does not support 0.1 with this model` and
`Unsupported parameter: 'max_tokens' … Use 'max_completion_tokens' instead`. When a
400/422 response names one of the optional parameters Robin sent (`temperature`,
`max_tokens`, `max_completion_tokens`, `response_format`), Robin logs a warning, adjusts
that one parameter (omits `temperature`, renames the token cap between
`max_tokens`/`max_completion_tokens`, or steps `response_format` down from `json_schema` to `json_object`
and then drops it), re-sends once, and keeps the adjusted shape for the rest of the run.
Each parameter is adjusted at most once per run (`response_format` gets its one extra
step down), so a provider that keeps rejecting surfaces its real error instead of looping.
The token cap is never silently dropped: Robin tries the other field name first, and if the
endpoint rejects both spellings it surfaces the provider error rather than running uncapped.
A genuine token-limit **value** error (for example below a provider's minimum) surfaces too,
instead of being mistaken for an unsupported field.
Known OpenAI reasoning families skip the round trip and start with the right shape.

Dropping `temperature` or `response_format` is safe: the model falls back to its own default
sampling, and the review parser already handles non-JSON output. Auth, rate-limit, server,
and unrelated validation errors do not trigger this path.

### Models that require a fixed temperature

Robin samples at `0.1` so reviews stay near-deterministic. Some providers reject that and
accept only one value — Kimi models require `1`. Robin recovers automatically by
retrying without `temperature` (see above); set `llm-temperature` only when you want a
specific value sent rather than the model default:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      llm-temperature: "1"
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

Accepted range is 0–2. Out-of-range or non-numeric values log a warning and fall back to
`0.1`. Raising temperature makes findings less repeatable, so change it only when the
provider requires it. Re-running the installer preserves this and any other `with:`
overrides in your workflow.

### Reasoning effort (provider-dependent)

Some providers and models accept a reasoning-effort control. Robin sends none unless you
ask for one: when `reasoning-effort` is unset or whitespace everywhere, the request carries
no reasoning control and the provider/model default applies. Set a value to send it in the
provider's shape (below); set `off` to be explicit about sending nothing. On the official
OpenCode Go endpoint, Robin surfaces rejected efforts without dropping them. Other
providers use the compatibility fallback described below.

Set it per repository in `.github/robin.yml` — the normal location, because reasoning is
configuration, not a credential:

```yaml
# .github/robin.yml
reasoning-effort: high   # or low / medium / a provider-specific name, or off
```

The workflow input overrides the repo config when non-empty, so consumers can scope an
effort to a single caller:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    with:
      reasoning-effort: "high"
    secrets:
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

Common values are `low`, `medium`, and `high`; exact names are provider-dependent (some
providers also use `minimal`, `xhigh`, or `max`). Robin forwards the trimmed value
unchanged. For OpenCode Go with `deepseek-v4.1-flash`, use:

```yaml
# .github/robin.yml
reasoning-effort: max
```

The request shape depends on `LLM_BASE_URL`:

- `api.openai.com`: OpenAI-native `reasoning_effort: "<value>"`.
- Official `https://opencode.ai/zen/go/v1` endpoint (including normalized trailing slashes
  and `/chat/completions` suffixes): top-level `reasoning_effort: "<value>"`, with no nested
  `reasoning` object. Robin retains any configured effort across retries. If Go rejects it,
  the error surfaces instead of retrying without effort. Main Zen, other hosts, HTTP URLs,
  and nondefault ports use the generic shape below.
- `api.anthropic.com`: nothing is sent — Anthropic's compatibility endpoint ignores
  reasoning controls and Claude decides its own thinking depth. Robin logs this once.
- Everything else: OpenRouter-style `reasoning: { effort: "<value>", exclude: true }` —
  Robin requests exclusion of hidden reasoning. Providers that expect a different native
  parameter reject it, and the fallback below then runs the review without reasoning controls.

If a provider supplies a string `reasoning_content`, Robin preserves it as private metadata
and replays it unchanged on that assistant's tool turn in later requests. This includes
streamed string deltas, retained compaction tails, and the final request with tool choice
`none`. Robin keeps this metadata out of summaries, progress updates, logs, and visible
reviews; only `content` supplies review text. Explicit low-level SDK debug logging can
still expose raw payloads.

For providers other than OpenCode Go, if a provider rejects the parameter itself as unknown
or unsupported, or clearly rejects the configured effort value (a 400/422 response such as `Unsupported parameter: reasoning`
or `reasoning effort must be one of low, medium, high`), Robin logs a warning and retries
that completion once without the reasoning control. It then keeps running without a
reasoning override for the rest of the run. When the retry succeeds, the review completes
normally. If you set the value yourself (input or `.github/robin.yml`), the final status
comment also keeps a visible warning telling you to update `reasoning-effort`. With no value
configured, no reasoning control is sent in the first place, so this fallback only ever runs
for a value you configured.

Auth, rate-limit, server, timeout, and unrelated validation errors do not trigger this
fallback. The retry omits the optional reasoning override; it does not guess a different
provider-specific effort value.

## Custom review identity

This is optional. With no `ROBIN_TOKEN` mapping, existing reusable-workflow callers
keep `github.token` and the `github-actions[bot]` identity. An empty secret also uses
that default. A nonempty but invalid or expired token causes an API error; Robin does
not switch identities after an authentication failure. No new secret is required for
the default setup, and the installers do not enable custom identity for you.

### GitHub App: create and use the token in one job

Install your GitHub App on the repository with **Contents: read**, **Pull requests:
write**, and **Actions: read**. Store its **Client ID** (shown in the App settings)
as the `ROBIN_APP_CLIENT_ID` repository variable and its private key as the `ROBIN_APP_PRIVATE_KEY` repository secret. Keep your three
existing LLM secrets. Use the direct action so token creation and the review share
one job.

[GitHub recommends Client ID](https://github.blog/changelog/2024-05-01-github-apps-can-now-use-the-client-id-to-fetch-installation-tokens/) for new setups. The token action at `@v2` still names
its input `app-id`; pass the Client ID as that input's value. Existing numeric App ID
configurations remain supported and do not need to change.

```yaml
name: Robin
on:
  pull_request:
    types: [opened, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read

jobs:
  review:
    if: >-
      github.event_name == 'pull_request' ||
      (github.event.issue.pull_request &&
       contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association) &&
       (startsWith(github.event.comment.body, '/robin') ||
        startsWith(github.event.comment.body, '/review') ||
        startsWith(github.event.comment.body, '/summary') ||
        startsWith(github.event.comment.body, '/help')))
    runs-on: ubuntu-latest
    timeout-minutes: 45
    concurrency:
      group: robin-${{ github.event.pull_request.number || github.event.issue.number }}-${{ github.workflow }}
      cancel-in-progress: true
    steps:
      - uses: actions/create-github-app-token@v2
        id: app-token
        with:
          app-id: ${{ vars.ROBIN_APP_CLIENT_ID }}
          private-key: ${{ secrets.ROBIN_APP_PRIVATE_KEY }}
          permission-contents: read
          permission-pull-requests: write
          permission-actions: read
      - uses: antongulin/robin@v2
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          llm-api-key: ${{ secrets.LLM_API_KEY }}
          llm-base-url: ${{ secrets.LLM_BASE_URL }}
          model: ${{ secrets.LLM_MODEL }}
```

The token stays in the job and the token action revokes it during cleanup. Do not pass
it through `needs.<job>.outputs`: GitHub omits secret-containing job outputs, and the
token action revokes tokens when their creation job ends. See the
[token action documentation](https://github.com/actions/create-github-app-token/tree/v2#how-it-works)
and [GitHub job-output rules](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idoutputs).

GitHub withholds repository secrets from fork PR workflows. This setup does not change
that rule. For a fork PR, use the existing maintainer `/robin` command path after
inspection; do not switch to `pull_request_target`.

### Reusable workflow: supply a token secret

Store a fine-grained PAT with the same repository permissions as `ROBIN_TOKEN`, then
add one mapping to your existing caller. Keep its current inputs and triggers:

```yaml
jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@main
    secrets:
      ROBIN_TOKEN: ${{ secrets.ROBIN_TOKEN }}
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: ${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: ${{ secrets.LLM_MODEL }}
```

Use a workflow revision that declares `ROBIN_TOKEN`; older pinned releases reject
unknown secrets. Passing `secrets: inherit` also makes a repository's `ROBIN_TOKEN`
available to this workflow. Remove the explicit mapping (or the inherited secret)
to return to the default identity.

A PAT posts as its owner. GitHub disallows approving or requesting changes on your
own PR. Robin also only dismisses stale blocking reviews from bot accounts, so a
PAT-authored blocking review may need manual dismissal after a clean rerun. Prefer
a GitHub App for automated reviews; use `request-changes: false` for PAT advisor mode.
Changing identity does not change the LLM provider, review triggers, or command permissions.

### Rerunning an installer

Both installers preserve the workflow files when a modern Robin workflow contains
`ROBIN_TOKEN`, an explicit `github-token`, an App-token step, or `secrets: inherit`.
They skip workflow regeneration and archiving, including `ROBIN_REF` overrides, so
token steps, secret aliases, triggers, and job dependencies survive. The companion
skill update still runs unless `ROBIN_SKILL=0`. Update refs and settings in these
workflows yourself. Default installations keep the existing generation and migration
behavior.

## Review flow

1. PR opened, reopened, or marked ready for review → automatic review.
2. Status comment appears, then updates when done.
3. Author pushes fixes → no automatic re-review (by default).
4. Maintainer comments `/robin` or `/review` for another pass.

The action fetches diffs and, in agent mode, a read-only tarball of the PR head through the GitHub API. `actions/checkout` is not required unless other steps need local files.

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
- **"You only see the diff" guard.** The single-shot prompt reminds the model it sees
  changed lines only, not the whole file — so it doesn't invent bugs about code it can't
  see. The agent-mode prompt replaces this with "verify with the tools before flagging".
  The companion skill mirrors this: it treats findings as hypotheses to verify, not orders.
- **Bounded tool fallback.** On an explicit tool rejection, Robin attempts the single-shot
  prompt with the complete diff subject to `max-diff-size`. This does not detect weak
  reviews from a model that accepts tools, and the fallback can still fail. See
  [model compatibility](#model-compatibility-and-usage).

The parser (`src/review-parser.ts`) is deliberately forgiving — it normalizes severity,
drops unparseable findings, and falls back to a markdown review if JSON mode fails — so a
malformed response from a weak model degrades instead of crashing the run.

## Security and privacy

PR diffs are sent to **your** configured LLM endpoint. In agent mode, any repository file the model reads with its tools is sent there too.

| Setup | Where code goes |
| --- | --- |
| Hosted API (OpenAI, Groq, OpenRouter, …) | That provider |
| Self-hosted Ollama | Your server |
| Self-hosted runner + local model | Your infrastructure |

Practices:

- Store keys in GitHub Secrets only.
- Use `permissions: actions: read`, `contents: read`, and `pull-requests: write`.
- Do not use `pull_request_target` with this action.
- Keep slash commands at `min-command-permission: write` unless you accept cost/abuse risk.
- Fork PRs from outsiders may not receive secrets — use manual `/review` from a maintainer.
- Agent-mode tools are read-only and confined to the extracted snapshot: paths and symlinks that resolve outside it are rejected, and PR code is never executed.

## Limits

No daily quota from this action. Real limits:

- GitHub Actions minutes (while the job waits on the model).
- Provider rate limits and model context size.
- Configured diff caps (`max-diff-size`, `agent-max-diff-size`) on very large PRs: the run fails before the model request instead of reviewing a partial diff.

## Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| Workflow can't resolve `@v0` | Wrong tag | Use `@main` |
| `Connection refused` | Runner can't reach LLM URL | Public URL, tunnel, or self-hosted runner |
| `Input required: model` | Missing secret | Add `LLM_MODEL` |
| `Input required: llm-base-url` | Missing secret | Add `LLM_BASE_URL` |
| `Empty response from LLM` | Provider returned no usable text or tool calls without an explicit length stop | Action retries with bounded backoff and retains the finish reason (`unknown` if absent) |
| `Incomplete LLM output (finish_reason=length...)` | Provider explicitly reported truncated generation; the reason alone does not identify the responsible limit | Robin discards partial text/tools and stops without unchanged retries or a diff-only fallback. Check output/reasoning generation limits and reduce scope. If input is too large, use smaller logically complete PRs (keep implementation/tests together) or larger effective context capacity; retry `/robin` after adjusting the cause |
| Provider context/input-limit error | Review input exceeds the model/provider’s effective capacity | Use smaller logically complete PRs (keep related implementation/tests together) or a model/provider with larger effective context capacity; retry `/robin` after adjusting input or capacity |
| `OpenRouter stall: no first response` | Auto-router hung before picking a provider | Action retries every 45s (up to 5×); PR status comment updates each attempt |
| Job cancelled / 45 min with no review | Hung LLM or concurrency cancel while waiting | Status comment should say interrupted — comment `/robin` again; pin `@v2.0.4`+ for stall detect |
| `404 Provider returned error` | OpenRouter free route missed one provider | Keep `LLM_MODEL=openrouter/free` — action retries (5×) with provider fallbacks; no secret updates when models rotate |
| `Request timed out` | Large PR or slow free model | Lower `max-diff-size` or raise `llm-timeout-ms` (router models default to 2 min per attempt) |
| `temperature` / `max_tokens` / `response_format` rejected | Newer model refuses an optional parameter (OpenAI reasoning models, Kimi) | Action warns, retries once with the parameter renamed or omitted (`max_tokens` ↔ `max_completion_tokens`, `temperature` dropped), and keeps that shape for the run. If the endpoint rejects both token-cap spellings, the provider error surfaces instead of running uncapped. Set `llm-temperature` only to pin a specific value (Kimi: `1`) |
| `404` on `https://api.anthropic.com` | Base URL missing `/v1` on an older Robin | Use `https://api.anthropic.com/v1`; `@v2`/`@main` normalize it automatically |
| `reasoning-effort` rejected as unsupported or invalid | Provider/model does not accept the reasoning control or configured value | On official OpenCode Go, the error surfaces without dropping the configured effort. For other providers, the action warns and retries once with no reasoning override. If that succeeds, the review completes; a user-set value also gets a status-comment notice to update `.github/robin.yml` or the workflow `with:` block. Set `reasoning-effort: off` to stop sending it |
| `Resource not accessible by integration` | Missing permissions | Add `pull-requests: write` |
| Slash command ignored | Wrong format or permission | `/robin` or `/review` as first line; need write access |
| `/robin` does nothing on `@v1` | Stale `v1` tag before v1.4.0 | Use `/review`, pin `@v1.4.0`+, or `@v2`; floating `v1` tracks latest `1.x` on release |
| Shallow review | Small model, or files removed by `skip-paths`/built-in exclusions | Stronger model, or review the excluded paths separately |

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


## Large pull requests: acquisition and coverage

Robin first requests the complete diff from GitHub's pull request API. If GitHub
returns its structured `406` / `PullRequest.diff: too_large` rejection, Robin uses
native Git to acquire the patch. Authentication, rate-limit, network, and other API
failures remain failures; they do not activate this fallback.

The native fallback supports Linux and macOS runners with Git and `ps` on `PATH`,
HTTPS access to the repository, and the same explicit `github-token` used by the
action with permission to fetch its Git objects. This also applies to self-hosted runners. GitHub Enterprise uses the
runner's `GITHUB_SERVER_URL`. Robin does not retry with an anonymous or alternate
identity. Fetch authentication is supplied through a private child environment;
no token is placed in command arguments, repository URLs, or saved Git config.
Inherited Git configuration, credentials helpers, tracing, hooks, external diff
commands, and text conversion helpers are disabled. The temporary repository is
bare and has a private directory. No PR code is checked out or executed. Other
platforms fail before native acquisition creates storage or starts Git; the
ordinary API diff path remains available.

Robin captures the PR base SHA, head SHA, and changed-file count, fetches those
objects with history, and compares their unique common merge base to the captured
head. It verifies the object identities and NUL-delimited path count, then checks
the PR metadata again before returning the patch. Renames count as one change.
The patch includes full object IDs, all text hunks, binary-file markers, deletions,
and mode changes. Robin omits encoded binary payloads from native patches so large
binary assets do not consume the patch output limit. Binary additions, changes,
deletions, and renames still contribute to the verified path count and patch metadata.
Missing history, ambiguous ancestry, changed metadata, invalid encoding, failed
cleanup, or incomplete acquisition aborts the review. Each Git command has a
120-second execution deadline and independent 32 MiB byte limits for stdout and
stderr; exceeding either fails rather than returning a patch prefix. Git runs
without a shell in its own POSIX process group. On failure or leader exit Robin
sends SIGKILL to that owned group, waits for the direct child's `close` event,
and confirms that no live group members remain before returning or removing
storage. Inactive zombies do not use the repository; reaping nonchild descendants
belongs to their OS parent, rather than Robin.

Shutdown confirmation has a separate five-second bound. When signal-based
existence checks still see a group, Robin uses `ps -A -o pgid= -o stat=` to
check for live members. The runner must permit process-group signals and process
status visibility; Linux needs a compatible procps-style `ps`, and macOS's system
`ps` is supported. Each status probe has a one-second deadline, a 1 MiB stdout
bound, a stripped environment, and fixed arguments without credentials or command
lines. A missing, restricted, or unusable probe cannot establish shutdown.

If child closure or group shutdown cannot be confirmed, acquisition fails with
`NATIVE_DIFF_LIFECYCLE_FAILED` and preserves its private `robin-diff-*` directory
under the OS temporary directory. An operator may remove that exceptional residue
after independently confirming its processes have stopped. A directory removal
failure instead reports `NATIVE_DIFF_CLEANUP_FAILED` and also leaves recovery to
the operator. Git, process, and cleanup diagnostics are replaced with fixed error
codes without raw causes.

Acquiring the complete patch does not raise the review's `max-diff-size` or
`agent-max-diff-size`. A filtered diff larger than the cap selected for that request path
fails the run before the model request, and the failed status reports the observed size,
the limit, and how to fix it; Robin never sends a truncated diff. Repository
configuration is loaded from the PR base, so a
configuration added only in the PR cannot enlarge that PR's review. Existing
`skip-paths` and generated-file exclusions still apply, including lockfiles and
`dist/`. Set a suitable base-branch cap and narrowly scoped exclusions when a
large patch must reach the model. Account for line annotations, prompt overhead,
and output reserve when checking the provider's context capacity. A changed-file
list does not prove that all file contents reached the outgoing request.

Generated lockfiles and rebuilt bundles need separate verification when filtered
out; do not describe them as model-reviewed. Verify dependency pins and resolved
versions with the package manager's reproducible install and CI. Rebuild committed
`dist/index.js` from the reviewed source and compare the artifact. Robin does not
visually review image contents through binary-file markers; inspect binary assets
with a separate visual or asset validation check. Local Git
and loopback-provider tests do not prove private GitHub fetch permissions or a
live provider's acceptance of a particular large request.
