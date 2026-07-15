# Robin Review Loop — Lessons Learned

Incidents and edge cases that shaped the `robin` PR review-loop skill. Each entry is a
real failure from a PR review loop session.

## Duplicate reviewer runs from premature `/robin`

**What happened:** Agent posted `/robin` immediately after PR creation. The repo
auto-triggers Robin on `pull_request` events. The manual `/robin` started a second run in
parallel.

**Why it's hard to avoid:** Auto-triggered runs start seconds after PR creation, sometimes
after a short delay. If the agent checks for reviewer signals right away, none are visible
yet, so `/robin` looks safe to post.

**Fix in the skill:** Wait before checking for reviewer signals. Look for started-signal
patterns in both PR comments and GitHub Actions runs — not just one exact phrase. Only fall
back to `/robin` after the grace period and only if no Robin signal ever appeared.

## Reviewer infra failure misread as clean pass

**What happened:** Robin returned an empty LLM response. The PR had no reviewer comments.
Agent treated this as "no issues found" and attempted to merge.

**Why it's hard to avoid:** An empty reviewer response and a truly clean pass look identical
from the PR comment feed — both result in zero actionable comments.

**Fix in the skill:** Check the GitHub Actions run status for the Robin job. An empty
response usually means the run succeeded but the model output was blank — the run logs and
Robin's own "I couldn't finish the review this time" status comment show this. Classify as
INFRA, not CLEAN, and attempt a rerun before proceeding.

## Obeying a finding that wasn't real

**What happened:** A weak free model flagged a "High" SQL-injection risk on a line that was
already using a parameterized query. The agent "fixed" it, churning the code and adding a
redundant guard.

**Why it's hard to avoid:** A confident-sounding High from the reviewer feels authoritative,
especially when it cites security.

**Fix in the skill:** Verify every finding against the actual code before fixing. Severity
and `confidence` are hints, not proof. An unverifiable High is NOISE — reply with the reason
and resolve the thread; do not invent a fix.

## Unresolved threads despite replies

**What happened:** Agent posted replies to every reviewer comment using `gh pr comment`. The
PR still showed unresolved threads. GitHub blocked merge.

**Why it's hard to avoid:** `gh pr comment` posts to the top-level comments feed, not to the
review thread. The thread `isResolved` field stays false regardless.

**Two fixes required:**
1. Use the `pulls/{n}/comments/{id}/replies` endpoint, not `gh pr comment`, for inline replies.
2. Explicitly resolve each thread with the GraphQL `resolveReviewThread` mutation after replying.

## Stale `reviewDecision` blocked a clean merge

**What happened:** Robin posted a clean second pass. `reviewDecision` still returned
`CHANGES_REQUESTED` from the first pass. Agent stopped, reported "PR is not approved."

**Why it's hard to avoid:** GitHub does not automatically update `reviewDecision` when a later
review is clean unless the reviewer explicitly clicks "Approve." Robin posts results as
comments / `REQUEST_CHANGES`, not formal approvals.

**Fix in the skill:** Do not treat `reviewDecision: CHANGES_REQUESTED` as a hard block when
the latest Robin pass is clean, all threads are resolved, and all checks are green. The
green-light gate checks all four signals together, not `reviewDecision` alone.

## REST comment endpoint missed unresolved threads

**What happened:** Agent fetched `pulls/{n}/comments` via REST, checked that all comments had
owner replies, and concluded threads were resolved. GraphQL showed several still
`isResolved: false`.

**Fix in the skill:** Always use GraphQL `reviewThreads` as the authoritative source for
thread state. REST is for fetching comment IDs and bodies cheaply; GraphQL is for resolution.

## Outdated threads silently blocking merge

**What happened:** PR had threads on old diff lines marked `isOutdated: true`. Agent skipped
them thinking outdated = irrelevant. GitHub counted them as unresolved.

**Fix in the skill:** Resolve outdated threads that have comments. `isOutdated` means the
thread is on a stale diff line, not that it can be ignored.

## Endless re-review loop

**What happened:** Each Robin pass surfaced one or two new low-value nits. The agent kept
fixing and re-requesting, burning GitHub Actions minutes and free-model calls for hours
without converging.

**Fix in the skill:** Count completed Robin results rather than loosely defined fix rounds,
and cap them at 5. On the ceiling, fix remaining verified bugs and reply/resolve open
threads, but do not request review 6 without an explicit override. A “one more” approval
extends the budget by exactly one, so review 7 requires another approval. Explicit full-auto
review can pre-authorize later rounds for that PR. Check synchronize behavior before
pushing because some repositories make the push itself consume the next review. Most PRs
converge in one or two reviews; five remains the default budget.

## Re-review started before old threads were closed

**What happened:** Agent pushed a fix first, which started another Robin run. It then
replied to and resolved the previous review while the next reviewer was already reading
the PR. Some agents returned after the push and never closed the old threads at all.

**Fix in the skill:** Make the order mandatory: fix, verify, commit locally, reply to every
finding, resolve and re-query every thread, then push and re-review. A pushed commit or
active review is explicitly non-terminal.

## Assuming every fix push triggers Robin

**What happened:** Agent pushed fixes and waited for a re-review that never started. The
recommended Robin workflow intentionally omits `synchronize`; re-reviews normally use the
`/robin` command.

**Fix in the skill:** Inspect the installed workflow and Actions runs after a push. Watch an
actual synchronize-triggered run when present; otherwise request `/robin`. Never do both.

## Cleanup hid unrelated local work

**What happened:** Agent treated a dirty tree as review debris, stashed or deleted files,
then reported cleanup as successful.

**Fix in the skill:** Snapshot the initial worktree, stage only task files, delete only the
task branch, and verify cleanup postconditions. Preserve and report unrelated changes; if
they prevent switching or pulling safely, stop with an exact cleanup blocker.

## Merge commits duplicated a release-please changelog entry

**What happened:** A PR was merged with `--merge` into a release-please repo. The resulting
release notes listed the same feature twice — once for the original `feat` commit, once for
the merge commit, because the merge commit's message carried the conventional PR title and
release-please parsed both.

**Fix in the skill:** In an auto-releasing repo (release-please / semantic-release /
changesets), **prefer `--squash`** even when merge commits are allowed. Squash collapses the
PR into one commit whose subject is the PR title, yielding exactly one clean changelog line.
Reserve `--merge` for the rare case where each underlying commit is deliberately its own
release-note entry.
