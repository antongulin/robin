/**
 * Pull-request trigger policy.
 *
 * A `pull_request` `synchronize` event fires on every push to an existing PR. By default Robin
 * reviews a PR when it opens (and on `/review`), not on every push, so `synchronize` is skipped
 * unless the caller explicitly sets `review-on-synchronize: true`. Other pull_request actions
 * (opened, reopened, ready_for_review) always run.
 */
export function shouldSkipSynchronizeEvent(
  action: string | undefined,
  reviewOnSynchronize: boolean
): boolean {
  return action === "synchronize" && !reviewOnSynchronize;
}
