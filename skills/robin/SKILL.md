---
name: robin
version: 2.1.1 # x-release-please-version
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

- A pass is one **review → fix → re-review round**, counted once. The auto-triggered
  review on PR creation starts pass 1; each subsequent fix-and-re-review is the next
  pass. So a re-review does *not* add a pass on its own — it closes the round its fix
  opened. Counting rounds (not raw Robin runs) is what keeps the loop from drifting to 6
  or 7. State the current count each pass ("pass 3 of 5").
- **A fix push may auto-trigger the re-review for you.** Many repos run Robin on
  `pull_request: [opened, synchronize]`, so pushing commits starts a fresh review on its
  own — that run *is* the re-review half of the current pass, not a bonus. When that
  happens, watch it; do **not** also post `/robin` (that's the duplicate-run mistake).
  Repos that run Robin only on the `/robin` comment won't auto-trigger — there you
  request the re-review yourself (step 5).
- On reaching pass 5: do **not** silently push another fix or request another review —
  either would start a 6th round. Evaluate the pass-5 review, fix any remaining
  *verified* bugs, reply to and resolve open threads, then **stop and ask the user** how
  to proceed (see below) rather than looping further on your own.
- Stop early the moment a pass is clean and the green-light gate passes — you do not
  need to use all 5.

**At the 5-pass ceiling without a green light, ask the user — don't decide alone.**
Robin almost always emits *some* feedback (noise included), so a PR can keep drawing new
low/medium comments forever. Reaching pass 5 without convergence means only the user
should choose whether to keep spending passes. Present a short status and ask, e.g.:

> Used all 5 Robin passes. Verified issues still open: `<list or "none">`. Noise skipped:
> `<count>`. I can (a) keep going — but that's past the 5-pass cap, so only if you say so
> — or (b) stop here and merge as-is. Which?

Frame (a) as an explicit override, not a routine choice: the whole point of the cap is
that unbounded re-review is the failure mode. Default to **stopping and asking** — never
auto-loop past 5. The user can also pre-authorize either side up front ("keep going until
clean, no cap" / "just merge whenever it's green"); honor an explicit instruction like
that over this default.

Over-reviewing a PR is a failure mode, not thoroughness. Re-running Robin indefinitely
burns GitHub Actions minutes and free-model calls for diminishing returns. Five passes
is the ceiling; most PRs converge in one or two.

## 0. Confirm the Skill Is Current (best-effort)

A stale copy of this skill can follow an outdated protocol, so at the start of a run do a
quick, **non-blocking** version check. You already know your installed version — it's the
`version:` field in this skill's own frontmatter above. Compare it to the latest release:

```bash
gh release view --repo antongulin/robin --json tagName -q .tagName 2>/dev/null | sed 's/^v//'
```

- Up to date, **or the check fails** (offline, rate-limited, `gh` missing) → just proceed.
  Never block the PR work on this — a failed version check is not a reason to stop.
- Behind → tell the user (e.g. *"robin skill is v2.0.6, latest is v2.1.0"*) and update
  **only** with their OK, or immediately if they've pre-authorized ("keep robin up to
  date"). The installer is cross-agent, so one command updates every coding agent that has
  it (Claude Code, Cursor, Copilot, Windsurf, …) — don't hunt for per-agent paths yourself:

  ```bash
  npx -y skills add https://github.com/antongulin/robin --skill robin --agent '*' --global --yes
  # or the maintained wrapper: bash scripts/update.sh
  ```

  An update takes effect on the **next** run — the skill executing now is already loaded in
  context. So finish this PR on the current version; the newer one applies next time.

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

When a PR was just created, or no completed Robin result exists yet, **poll** for a
result — don't fire one long blind sleep. A healthy Robin run finishes in about a
minute, often less. Poll roughly every 30s so you notice a new review comment promptly
and can act on it while it's fresh:

```bash
# poll loop — repeat until a Robin result appears or the escalation threshold hits
sleep 30
gh pr view <number> --json comments,reviews,statusCheckRollup
gh run list --limit 20 --json databaseId,event,status,conclusion,workflowName,createdAt,url,displayTitle,headBranch
```

**Escalation threshold (~3 min).** Because a normal run lands in ≈1 min, silence past
~3 minutes means something is likely wrong — most often a flaky free-model route or an
unstable provider, occasionally just a slow one. Don't keep sleeping blindly; go look
at GitHub Actions:

```bash
gh run view <run-id>                # status of a still-running job — is it stuck?
gh run view <run-id> --log-failed   # only once it has completed with a failure
```

Use plain `gh run view` for an `in_progress` run — `--log-failed` returns nothing until
a run has finished with failed steps, so it only applies to the failure branch below.

- Run still `in_progress` well past ~1 min → a slow/degraded provider. Keep polling at
  30s, but cap the total wait (about 8–10 min) before treating it as INFRA.
- Run `completed` with `conclusion: failure`, or a Robin status comment saying it
  couldn't finish the review → INFRA (step 4). Rerun the failed run before any `/robin`.
- No Robin run appears at all after ~3 min → auto-trigger likely didn't fire; fall
  through to the `/robin` fallback below.

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

Now get the re-review — but **only if you are below 5 passes**, and mind how the repo
triggers Robin so you don't start a duplicate run:

- **If the push already auto-triggered Robin** (the common `pull_request:
  [opened, synchronize]` config — check `gh run list` / PR comments the way step 3 does),
  that run *is* your re-review. Watch it; do **not** also post `/robin`.
- **Only if no auto-run appears after the push** (repo runs Robin solely on the `/robin`
  comment) request one explicitly:

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

**Before merging, handle release notes if the repo publishes them.** This has to happen
*now*, pre-merge: a squash merge freezes the PR title/body into the commit the release
tooling reads, and once merged the branch is gone. See the **Release Notes** reference at
the end of this skill — detect the repo's mechanism and prepare notes before you ask to
merge.

**When the gate passes, tell the user it's ready and ask before merging.** Merging is
the one irreversible step here, so don't do it silently. Report the gate summary above
and ask, e.g. *"PR #123 is green and ready to merge — want me to merge it?"* Wait for a
yes. The user can pre-authorize this ("merge automatically when it's green"); if they
have, skip the question and merge.

## 9. Merge and Clean Up

Only after the green-light gate, the release-notes step (if the repo publishes them —
step 8), **and** the user's go-ahead or their standing pre-authorization.

**Pick the merge method the repo actually allows — don't assume.** `--merge` fails on a
squash-only repo, and using the wrong method can defeat release tooling that reads the
squash commit. Check first:

```bash
gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed
```

Choose the matching flag — `--squash`, `--merge`, or `--rebase`. **In a repo that
auto-releases (release-please / semantic-release / changesets), prefer `--squash` even
when merge commits are also allowed.** A merge commit embeds the (conventional) PR title
in its own message, so the release tool counts it *and* the underlying commit — you get
duplicate changelog entries. Squash collapses the PR to one commit whose subject is the
PR title, which becomes exactly one clean release-note line. Only fall back to `--merge`
when the individual commits are each meant to be their own changelog entry (rare, and
usually a sign the PR should have been split). If still unsure, ask. Then merge, letting
`gh` handle the branch:

```bash
gh pr merge <number> --squash --delete-branch   # swap --squash for the allowed method
```

`--delete-branch` deletes **both** the local and remote branch and checks you out onto
the base branch — so there is no separate `git branch -d` to run, and no default-branch
guard to worry about. Just confirm, refresh, and prune:

```bash
gh pr view <number> --json state,mergedAt,mergedBy,mergeCommit,url   # confirm it merged
git pull --ff-only           # you're on the default branch now; bring it up to date
git fetch --prune            # drop the stale remote-tracking ref
git status --short --branch   # confirm a clean tree on the default branch
```

Edge cases: if a local branch somehow survives (e.g. you were never checked out on it and
`gh` couldn't remove it), delete it with `git branch -d <branch>`, or `git branch -D`
if it looks unmerged after a squash — confirm the merge landed via `gh pr view` first.
If the tree wasn't clean going in, you likely staged unrelated files back in step 1 —
resolve that rather than carrying junk onto the default branch.

## Release Notes (reference for step 8 — do this *before* merging)

Optional and detection-gated. Step 8 sends you here before the merge in step 9, because
the leverage is entirely pre-merge (a squash commit and the release bot read the PR
title/body you set now, and after merge the branch is gone). Skip the whole thing if the
repo publishes no release notes.

You already hold the full context of what this PR did, so you're well placed to make its
release note *useful* — "Add retry with backoff to the upload client, fixing dropped
uploads on flaky networks" beats an auto-generated "Merged PR #123." But how you help
depends entirely on the repo's release mechanism, and the common mistake is hand-writing
notes that a bot then overwrites. **Detect the mechanism first**, then act:

```bash
ls .changeset/ .release-please-manifest.json release-please-config.json 2>/dev/null
grep -rilE 'release-please|semantic-release|changesets' .github/workflows 2>/dev/null
ls CHANGELOG.md HISTORY.md 2>/dev/null
```

- **Automated from commits/PRs** (release-please, semantic-release, changesets — this
  applies to many repos): the notes are generated from your **conventional-commit
  messages and PR title/body**, not from a file you edit. Here the leverage is entirely
  *before* merge — make the PR title a clean conventional summary (`feat(upload): retry
  with backoff on network errors`) and write a body that reads well, since a squash merge
  and the release bot pull from exactly that. Editing the generated `CHANGELOG.md`
  directly is wasted work; the next release run overwrites it.
- **Changesets specifically**: add a changeset file (`.changeset/<name>.md`) describing
  the change in user-facing terms, rather than editing the changelog.
- **Manually curated changelog** (a Keep-a-Changelog `CHANGELOG.md` with an `Unreleased`
  section and no bot): offer to add a short human-readable entry under `Unreleased` as a
  small commit on the branch before merge.
- **No release notes at all**: skip this — don't introduce a changelog the repo never
  asked for.

Release notes are outward-facing, so **confirm the wording with the user before writing
or committing** it, and match the repo's existing tone and entry format. If unsure which
mechanism a repo uses, ask rather than guess — a wrong guess either gets overwritten or
adds noise a maintainer has to clean up.

## Common Mistakes

- Obeying a finding without verifying it against the code (Robin's model may be weak).
- Treating severity or `confidence: high` as proof a finding is real.
- Inventing a fix to satisfy a NOISE comment instead of replying with the reason.
- Looping past 5 passes / re-running Robin indefinitely instead of asking the user at the ceiling.
- Miscounting passes — forgetting the auto-triggered review counts, so the loop drifts to 6–7.
- One long blind `sleep` instead of polling ~30s and escalating to GitHub Actions after ~3 min.
- Treating a slow/flaky provider as a clean pass rather than checking the Actions run.
- Replying in one summary comment instead of separate inline replies.
- Using REST comments only and missing unresolved `reviewThreads`.
- Posting `/robin` right after PR creation and starting a duplicate run.
- Treating a failed Robin run (INFRA) as code feedback.
- Merging silently without telling the user it's ready and getting a go-ahead.
- Merging while outdated or unresolved threads remain.
- Leaving the user on the dead merged branch instead of checking out the default branch and deleting the local branch.
- Hand-editing a generated `CHANGELOG.md` that the release bot will overwrite.
- Staging unrelated dirty files while fixing PR feedback.

## References

- [references/github-pr-api-reference.md](references/github-pr-api-reference.md) — exact GitHub API queries and mutations.
- [references/lessons-learned.md](references/lessons-learned.md) — real failures that shaped this loop.
