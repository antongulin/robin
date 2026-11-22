# Historical review replay

Replay an unmodified Robin build against a past PR commit and compare review duration, tool usage, findings and reported token usage. This is an experiment, not a replacement for live review or a quality judgment.

The local proxy forwards only GET and HEAD requests for the case repository. It substitutes the past commit and cutoff for supported PR endpoints. Every write, including GraphQL, is intercepted and recorded with a synthetic response; it is never sent upstream. The action receives a dummy GitHub token. The read token stays in the harness process and is attached only to upstream requests. The action's server URL points to a closed local port to prevent native Git fallback from reaching GitHub. Use a trusted build and a read-only GitHub token: this is not an operating-system network sandbox for arbitrary code.

Prerequisites: Node 24, `tar`, an unmodified build containing `dist/index.js` and `package.json`, GitHub repository read access, and an OpenAI-compatible endpoint. Keep case files and output directories private: they contain PR data, findings, and review payloads. The harness does not send credentials in command-line arguments. For example, within a subshell, obtain credentials from your local secret manager without printing them:

```sh
(
  export REPLAY_GITHUB_TOKEN="$(your-secret-manager read github-read-token)"
  export REPLAY_LLM_API_KEY="$(your-secret-manager read llm-key)"
  export REPLAY_LLM_BASE_URL="https://example.invalid/v1"
  export REPLAY_LLM_MODEL="example-model"
  node experiment/replay/prepare-case.mjs --repo example/demo --pr 123 --round 1 > cases.jsonl
  mkdir -p /tmp/robin-control
  git archive <ref> dist/index.js package.json | tar -x -C /tmp/robin-control
  node experiment/replay/run-replay.mjs --cases cases.jsonl --arm control --build /tmp/robin-control --out replay-results --reps 2 --concurrency 2 --price-input 0.30 --price-cached 0.007 --price-output 1.20
  node experiment/replay/run-replay.mjs --cases cases.jsonl --arm variant --build /tmp/robin-variant --out replay-results --reps 2 --concurrency 2 --env ROBIN_EXPERIMENT=read-skip,final-repair --price-input 0.30 --price-cached 0.007 --price-output 1.20
  node experiment/replay/summarize.mjs replay-results
  node experiment/replay/summarize.mjs replay-results --json
)
```

Prepare the variant build directory using the same archive command with its ref. `--case <id>` selects a case and may be repeated; `--input name=value` overrides workflow defaults. Environment overrides cannot replace runtime, input, credential, or Node control variables. Never put secrets in override arguments. For each arm, case and repetition the runner creates `result.json`, `proxy.jsonl`, `writes.jsonl`, timestamped `stdout.log` and `stderr.log`, `event.json`, `output.txt`, `summary.md`, and, when available, `usage-report.json`. Results include exit and timeout, exclusion, wall time, agent turns, tools and repeats, limit and fallback signals, findings, usage attempts and optional computed cost. Unknown data is null. Price flags are per million tokens; cached tokens are a subset of prompt tokens. Logs redact the exact supplied LLM key and GitHub token; treat all outputs as sensitive regardless.

`prepare-case` identifies a Robin review in submission order. It uses the merge commit's first parent for merged PRs, otherwise the base ref, to compute a merge base. Its cutoff is one second before submission, not the start of the original run; historical context can therefore include material added during the review. It reports the filtered diff character count. The compare diff equals the PR diff only when `base_sha` is the correct merge base. GitHub compare responses can have pagination and size limits; compare file and commit arrays use only their first page. Replay covers PRs whose diff the compare API can serve: compare errors produce a 502, mark `excluded: diff-unavailable`, and never expose a structured 406 to the action. Native Git attempts are recorded and cannot connect through the configured server URL. GraphQL is blocked, and other historical repository reads are not a full reconstruction of the PR at cutoff. Run the local checks with `node --test experiment/replay/`.
