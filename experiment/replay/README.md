# Replay harness (experiment branch only)

Runs an unmodified Robin build against a past pull request at the commit an earlier review saw, without writing anything to GitHub, and records how the review went. It exists for the review-speed experiment in issue #140 and never ships.

## What it guarantees

- **No writes.** The action's GitHub API calls go through a local proxy (`github-proxy.mjs`) on `127.0.0.1`. The proxy forwards `GET` and `HEAD` for the case's repository only. One read leaves the proxy: the repository archive download follows GitHub's redirect to its archive host with a short-lived signed URL (no token is involved). Every other method, and all GraphQL, is answered with a synthetic success and recorded in `writes.jsonl`; nothing is sent upstream.
- **No write-capable token in the action.** The action gets the dummy token `replay-dummy-token`. The real read token stays in the harness process and is added only to upstream reads.
- **The PR as it was.** The proxy serves the diff and file list from `compare/<base_sha>...<head_sha>`, patches the PR's head and base SHAs, hides reviews and comments created at or after the case's `cutoff`, and refuses to download any tarball except `head_sha`.
- **No native Git.** GitHub's "diff too large" (406) response is never passed to the action, and `GITHUB_SERVER_URL` points at a closed local port, so Robin's native-Git fallback cannot reach GitHub. A case whose diff the compare API cannot serve is marked `excluded: "diff-unavailable"`.

This is not an operating-system sandbox: run only trusted builds.

## Requirements

Node 24, `tar`, `gh` (or another way to get a GitHub read token), and an OpenAI-compatible endpoint.

Credentials come only from environment variables, never from command-line arguments:

| Variable | Meaning |
| --- | --- |
| `REPLAY_GITHUB_TOKEN` | GitHub token with read access to the case repositories |
| `REPLAY_LLM_API_KEY` | Provider key |
| `REPLAY_LLM_BASE_URL` | Provider base URL (the action detects provider-specific behavior from it, so use the real URL) |
| `REPLAY_LLM_MODEL` | Model id |

Load them inside a subshell so nothing is printed, for example:

```sh
(
  export REPLAY_GITHUB_TOKEN="$(gh auth token)"
  export REPLAY_LLM_API_KEY="$(your-secret-manager read llm-key)"
  export REPLAY_LLM_BASE_URL="https://provider.example/v1"
  export REPLAY_LLM_MODEL="example-model"
  node experiment/replay/run-replay.mjs ...
)
```

## Steps

1. **Builds.** Each arm needs a directory with `dist/index.js` and `package.json`:

   ```sh
   mkdir -p /tmp/robin-control /tmp/robin-variant
   git archive <control-ref> dist/index.js package.json | tar -x -C /tmp/robin-control
   git archive <variant-ref> dist/index.js package.json | tar -x -C /tmp/robin-variant
   ```

2. **Cases.** One JSON line per review to replay (read-only API calls):

   ```sh
   node experiment/replay/prepare-case.mjs --repo owner/name --pr 123 --round 1 >> cases.jsonl
   ```

   `--round K` picks the K-th Robin review on the PR by submission time. The case records `head_sha` (the commit that review saw), `base_sha` (the merge base; for merged PRs computed from the merge commit's first parent), `cutoff` (one second before that review was submitted), `diff_chars` (filtered diff size), and the repository's Robin caller `with:` inputs at the base commit (`inputs`, `caller_file`, `caller_ref`). Inputs that use `${{ }}` expressions and `runner` are skipped.

3. **Run an arm.**

   ```sh
   node experiment/replay/run-replay.mjs --cases cases.jsonl --arm control --build /tmp/robin-control \
     --out results --reps 2 --concurrency 1 \
     --price-input 0.30 --price-cached 0.007 --price-output 1.20
   node experiment/replay/run-replay.mjs --cases cases.jsonl --arm read-skip+final-repair --build /tmp/robin-variant \
     --env ROBIN_EXPERIMENT=read-skip,final-repair --out results --reps 2 --concurrency 1 \
     --price-input 0.30 --price-cached 0.007 --price-output 1.20
   ```

   - Inputs: the reusable workflow's defaults, then the case's caller inputs, then `--input name=value` (for example `--input reasoning-effort=high`). Every arm in a comparison must use the same provider, model and inputs except the one under test.
   - `--env` sets extra environment variables for the action (for example `ROBIN_EXPERIMENT`); runtime, input, credential and Node variables cannot be overridden.
   - `--case <id>` limits the run to listed cases; `--reps` must be the same for every arm.
   - Keep `--concurrency 1` when the key is shared with live reviews, and stop on HTTP 429.

4. **Summarize.**

   ```sh
   node experiment/replay/summarize.mjs results          # Markdown table per arm and per case (metrics from eligible runs only)
   node experiment/replay/summarize.mjs results --json
   ```

## Output

Per arm, case and repetition, `<out>/<arm>/<case>/rep<k>/` holds:

- `result.json`: exit code, timeout, exclusion, wall time, turns, tool calls, compactions, exact-repeat tool calls, turn timestamps, stop reason (turn or time limit), structured retry, final-repair calls, diff-only fallback, the experiment-switch and reasoning-effort log lines, effective inputs, findings (severity, confidence, file, line, description, recommendation) parsed from the review Robin would have posted, token usage (prompt, cached, completion, reasoning) per attempt and in total, cost from the price flags, the number of blocked writes and any refused proxy requests. Unknown values are `null`.
- `stdout.log`, `stderr.log` (timestamped; the supplied key and token are replaced by `***`), `writes.jsonl`, `proxy.jsonl`, `event.json`, `output.txt`, `summary.md`, `usage-report.json`.

Treat case files and outputs as private: they contain repository names, code and review text.

## Limitations

- The compare diff equals the PR diff only when `base_sha` is the right merge base. Compare file and commit lists use the first page only.
- `cutoff` is the review's submission time, not the start of its run.
- GraphQL is blocked; other repository reads come from the current repository, not a reconstruction at `cutoff`.
- Caller inputs are read with a small YAML subset parser (scalars and block scalars); check `effective_inputs` in `result.json`.

## Tests

```sh
node --test experiment/replay/
```
