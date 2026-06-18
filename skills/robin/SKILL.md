---
name: robin
description: Use when the user mentions Robin for a pull request — "review with Robin", "run Robin", "robin this PR", "create a PR with Robin", "ask Robin to review", "start the Robin loop" — or, more generally, when a GitHub pull request needs review monitoring, reviewer-comment triage, PR feedback fixes, comment replies, unresolved-thread cleanup, or a bounded wait → fix → re-review → merge loop.
---

# Robin — PR Review Loop

[Robin](https://robinreview.dev) is a free AI code reviewer that runs as a GitHub
Action: it posts a review with severity-tiered findings (High / Medium / Low /
Suggestion) on each pull request. This skill drives a PR from "Robin is reviewing"
to a mergeable state — without losing comments, hiding unresolved threads, trusting
stale review state, or over-reviewing.

Robin's reviews come from a **rotating free model that may be weak**. Treat its
findings as suggestions to verify, never as orders to obey. You (the agent running
this skill) are often the more capable reviewer. Fix real bugs; drop the noise.

## When to Use

- User says "review with Robin", "run Robin", "robin this PR", "start the review loop",
  "watch my PR", "fix PR feedback", or "wait for review".
- A PR has Robin (or human) reviewer comments to evaluate.
- A PR needs every actionable comment replied to and every thread resolved.
- Robin's GitHub Action failed and needs a retry before judging the code.
- A newly created PR may already have an auto-triggered Robin run.

## Core Rule — a PR is not green until all are true

- The latest Robin pass is clean / has no actionable issues, **or** every issue it
  raised has been fixed-or-justified.
- Required checks and deploy previews are green or intentionally neutral/skipped.
- Every actionable reviewer comment has a separate inline reply.
- Every review thread is resolved, including outdated ones.
- The branch is mergeable and local verification has passed.

Do not rely on `reviewDecision` alone. GitHub may keep stale `CHANGES_REQUESTED`
after a later clean review.

Do not post `/robin` immediately after PR creation. Most repos auto-trigger Robin on
creation, and an extra `/robin` starts a duplicate reviewer run.

## Bounded Loop — at most 5 passes

Track an iteration counter, starting at the first Robin review pass. **Run at most 5
review → fix → re-review passes per PR.**

- Each completed Robin review (auto-triggered or `/robin`) counts as one pass.
- On reaching pass 5: do **not** request another review. Fix any remaining *verified*
  bugs from the last pass, reply to and resolve open threads, run the green-light gate,
  and merge.
- Stop early the moment a pass is clean and the green-light gate passes — you do not
  need to use all 5.

Over-reviewing a PR is a failure mode, not thoroughness. Re-running Robin indefinitely
burns GitHub Actions minutes and free-model calls for diminishing returns. Five passes
is the ceiling; most PRs converge in one or two.

## 1. Discover Context

```bash
gh pr view --json number,url,baseRefName,headRefName,state,reviewDecision,mergeStateStatus,statusCheckRollup
gh repo view --json nameWithOwner -q .nameWithOwner
```

If no PR is obvious, ask for the PR number. Check local safety before edits:

```bash
git status --short --branch
```

Stage only files relevant to reviewer fixes. Leave unrelated dirty files alone.

## 2. Fetch Review Data

```bash
gh pr view <number> --json comments,reviews,reviewDecision,mergeStateStatus,statusCheckRollup
gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate
```

Fetch review-thread state with GraphQL — REST does not reliably expose `isResolved`.
See [references/github-pr-api-reference.md](references/github-pr-api-reference.md) for
the full `reviewThreads` query and the `resolveReviewThread` mutation.

## 3. Handle Auto-Triggered Review

When a PR was just created, or no completed Robin result exists yet, wait before
requesting another review:

```bash
sleep 60
gh pr view <number> --json comments,reviews,statusCheckRollup
gh run list --limit 20 --json databaseId,event,status,conclusion,workflowName,createdAt,url,displayTitle,headBranch
```

Look for any Robin-started signal in PR comments, reviews, or check runs. Do not require
one exact phrase. Examples:

- A comment headed `🏹 Robin` / `## :bow_and_arrow: Robin`
- `On it — taking a look at this pull request`
- A GitHub Actions run whose workflow/display title is `Robin`, or looks like PR review /
  code review automation

If a Robin-started signal exists, do not post `/robin`. Watch the in-flight run until it
finishes or clearly times out:

```bash
gh run watch <run-id> --interval 10 --exit-status
```

Only post `/robin` as a fallback after checking GitHub Actions:

1. If a Robin run failed, rerun the failed run first:

```bash
gh run rerun <run-id> --failed
gh run watch <run-id> --interval 10 --exit-status
```

2. If rerun is unavailable, the rerun fails, or Robin never appears after the grace
   period, alert the user instead of creating duplicate runs blindly.
3. If there is no Robin signal, no related Actions run, and enough time has passed to
   rule out normal auto-trigger lag, request a review:

```bash
gh pr comment <number> --body "/robin"
```

Robin's failed-review comment says so explicitly ("I couldn't finish the review this
time… Free model routes drop sometimes"). That is **INFRA**, not feedback — handle it in
step 4, never change code for it.

## 4. Classify Feedback — verify, don't obey

**Robin's comments are suggestions, not orders.** A rotating free model produced them;
you are often more capable. Treat every finding as a *hypothesis to verify against the
actual code*. Never auto-apply.

Robin tags each inline finding with a severity and a `confidence` (e.g.
`🚨 HIGH · confidence: medium`). Use both as hints — neither is proof.

Classify each finding:

- **LEGIT — fix it:** you reproduced or confirmed the problem in the code. Real bugs,
  security risks, data loss, broken/missing tests, race conditions, wrong behavior,
  misleading docs. A sharp **Low** that is clearly a real bug is LEGIT. Fix it.
- **NOISE — skip it:** you checked and the issue is not real, is subjective style that
  conflicts with repo conventions, is a duplicate already handled, or depends on context
  Robin could not see in the diff (it only sees changed lines). An unverifiable **High**
  is NOISE — high severity is not evidence.
- **INFRA — don't touch code:** Robin failed to run, timed out, or returned an empty
  response. Rerun the failed Action before considering `/robin`.

Filtering guidance:

- **Fix only LEGIT findings.** Severity orders your effort (LEGIT High before LEGIT Low);
  it does not decide what is real — your verification does.
- **Suggestions are optional by default.** Apply one only if it is clearly correct and
  cheap. Skip taste/style unless it matches the repo's existing conventions.
- **`confidence: low` raises the bar** — verify extra carefully before spending a fix on it.
- **Never invent a fix to satisfy Robin.** If a finding is wrong or based on unseen
  context, that is NOISE — reply with the reason and move on.

Handle INFRA first (rerun the Action). If Robin cannot be rerun or keeps failing for
infrastructure reasons, alert the user with the failing run URL and stop the loop.

## 5. Fix Legitimate Issues

Implement LEGIT fixes in the codebase's existing style, simplest fix first. After edits,
run the repo's verification — common examples:

```bash
npm run typecheck && npm run lint && npm run test && npm run build
git diff --check
```

Commit and push:

```bash
git add <intended-files>
git commit -m "fix(pr-feedback): address Robin review comments"
git push
```

Request another review pass — **only if you are below 5 passes**:

```bash
gh pr comment <number> --body "/robin

Fixed in <commit>:
- <item>

Verification:
- <command>
"
```

## 6. Reply to Every Reviewer Comment

Each original reviewer comment gets its own inline reply — including ones you skipped as
NOISE. Do not rely on a single summary comment. Use the replies endpoint, not
`gh pr comment` (see the API reference):

```bash
gh api -X POST \
  repos/<owner>/<repo>/pulls/<number>/comments/<comment-id>/replies \
  -f body='Fixed in <commit>: <specific resolution>.'
```

Keep replies factual:

- `Fixed in abc123: added a timeout and error branch to the fetch call.`
- `Not changing: this path is already covered by the parameterized query above — no injection risk here.`
- `Skipping: this flags a variable as unused, but it is read in the unchanged code below the diff.`

## 7. Resolve Threads

After replying, resolve each thread with the `resolveReviewThread` GraphQL mutation
(see the API reference). Then re-query `reviewThreads` and confirm:

- `isResolved: true` for every thread.
- Every non-owner reviewer comment has a later owner reply in the same thread.
- Outdated threads with comments are also resolved.

## 8. Green-Light Gate

Before merge, verify all:

```bash
gh pr checks <number>
gh pr view <number> --json state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,comments
```

Re-query GraphQL review threads. State explicitly:

- Total review threads, and how many are resolved.
- Whether any reviewer comment lacks a reply.
- Latest Robin result, and how many findings were fixed vs. skipped-as-noise (with reasons).
- How many review passes were used (out of the 5 ceiling).
- Check / deploy status.

If the latest clean pass exists but `reviewDecision` is still `CHANGES_REQUESTED`, treat
it as stale only when all threads are resolved and checks are green.

## 9. Merge

Only after the green-light gate:

```bash
gh pr merge <number> --merge --delete-branch
```

Confirm:

```bash
gh pr view <number> --json state,closedAt,mergedAt,mergedBy,mergeCommit,url
git fetch --prune origin
git status --short --branch
```

## Common Mistakes

- Obeying a finding without verifying it against the code (Robin's model may be weak).
- Treating severity or `confidence: high` as proof a finding is real.
- Inventing a fix to satisfy a NOISE comment instead of replying with the reason.
- Looping past 5 passes / re-running Robin indefinitely.
- Replying in one summary comment instead of separate inline replies.
- Using REST comments only and missing unresolved `reviewThreads`.
- Posting `/robin` right after PR creation and starting a duplicate run.
- Treating a failed Robin run (INFRA) as code feedback.
- Merging while outdated or unresolved threads remain.
- Staging unrelated dirty files while fixing PR feedback.

## References

- [references/github-pr-api-reference.md](references/github-pr-api-reference.md) — exact GitHub API queries and mutations.
- [references/lessons-learned.md](references/lessons-learned.md) — real failures that shaped this loop.
