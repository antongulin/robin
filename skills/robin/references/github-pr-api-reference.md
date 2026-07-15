# GitHub PR Review API Reference

Reusable API patterns for querying and mutating pull request review state. These are the
exact queries used by the `robin` PR review-loop skill.

## Fetch PR top-level state

```bash
gh pr view <number> --json \
  number,url,baseRefName,headRefName,state,reviewDecision,mergeStateStatus,statusCheckRollup
```

Key fields:
- `reviewDecision` — can be stale; always cross-check with latest review body and thread state.
- `mergeStateStatus` — `CLEAN`, `BLOCKED`, `DIRTY`, `UNSTABLE`, `UNKNOWN`. Use alongside `mergeable`.
- `statusCheckRollup` — array of check results; look for `state: FAILURE` or `status: IN_PROGRESS`.

## Fetch review comments (REST)

```bash
gh api repos/<owner>/<repo>/pulls/<number>/comments --paginate
```

Returns inline diff comments. Each comment has an `id` field needed for posting replies.

Top-level PR comments (not tied to a diff line):

```bash
gh pr view <number> --json comments,reviews
```

## Fetch review thread state (GraphQL)

REST does not expose `isResolved`. Use GraphQL:

```bash
gh api graphql \
  -f owner=<owner> \
  -f repo=<repo> \
  -F number=<number> \
  -f query='
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first:100) {
            nodes {
              id
              author { login }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}'
```

Fields:
- `id` — needed for `resolveReviewThread` mutation.
- `isResolved` — the authoritative source; do not infer from REST.
- `isOutdated` — thread is on a stale diff line; still needs resolving if it has comments.

## Reply to a reviewer comment

One reply per original reviewer comment ID. Use the replies endpoint, not a new top-level comment:

```bash
gh api -X POST \
  repos/<owner>/<repo>/pulls/<number>/comments/<comment-id>/replies \
  -f body='Fixed in <commit>: <specific resolution>.'
```

Do not use `gh pr comment` for inline replies — that posts to the top-level comments feed, not the thread.

## Resolve a review thread

```bash
gh api graphql \
  -f threadId=<thread-id> \
  -f query='
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread { id isResolved }
  }
}'
```

After resolving, re-query `reviewThreads` and confirm `isResolved: true` for each thread. Do not trust the mutation response alone — re-query to verify.

## Check GitHub Actions runs

```bash
gh run list --limit 20 --json \
  databaseId,event,status,conclusion,workflowName,createdAt,url,displayTitle,headBranch
```

Filter for Robin runs: look for `event: pull_request`, or a workflow/display title of
`Robin` (or anything that looks like review / code-review automation).

Rerun a failed run:

```bash
gh run rerun <run-id> --failed
gh run watch <run-id> --interval 10 --exit-status
```

## PR checks summary

```bash
gh pr checks <number>
```

Returns all required checks and their current state. Use as final confirmation before merge.

## Merge

```bash
# Pick the method the repo allows — --merge fails on a squash-only repo.
gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed
gh pr merge <number> --squash --delete-branch   # or --merge / --rebase per the repo
```

`--delete-branch` requests local and remote branch deletion, but do not assume every
cleanup step succeeded. Confirm the merge, switch explicitly to the recorded base branch,
sync it, and verify both task-branch refs.

Confirm after merge:

```bash
gh pr view <number> --json state,closedAt,mergedAt,mergedBy,mergeCommit,url
git switch <base-branch>
git pull --ff-only origin <base-branch>
git fetch --prune origin
git status --short --branch
git branch --list <task-branch>
git ls-remote --heads origin refs/heads/<task-branch> # no output means deleted
```

After merge confirmation, delete the exact remote or local task branch only if either
still exists. Do not touch unrelated branches:

```bash
git push origin --delete <task-branch>
git branch -D <task-branch>
```

## Common field gotchas

| Field | Gotcha |
|-------|--------|
| `reviewDecision` | Stays `CHANGES_REQUESTED` after a clean later pass; verify against latest review body |
| `isResolved` | Only available via GraphQL; REST comment endpoint does not expose it |
| `mergeStateStatus` | Can be `UNKNOWN` briefly after a push; wait and re-query |
| `statusCheckRollup` | Array; a single failing check blocks merge even if overall PR looks green |
