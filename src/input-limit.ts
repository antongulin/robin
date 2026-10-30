/**
 * Fail-closed diff input selection.
 *
 * Every model request receives the complete filtered diff or does not happen at all. A
 * configured diff cap that cannot include the complete diff fails the run before the
 * request, because a cut-off diff can never be reviewed or summarized completely.
 */

/** The request path whose configured cap applies. */
export type DiffInputMode = "single-shot review" | "agent review" | "summary";

export interface DiffInputLimit {
  mode: DiffInputMode;
  /** Action input / repo-config name that supplied the cap, used for remediation. */
  setting: "max-diff-size" | "agent-max-diff-size";
  /** Cap actually applied to this request path, in JavaScript string characters. */
  limit: number;
  /** Established fallback reason, for example "repository snapshot unavailable". */
  detail?: string;
}

/** A configured diff cap cannot include the complete filtered diff. */
export class DiffInputLimitError extends Error {
  readonly mode: DiffInputMode;
  readonly setting: DiffInputLimit["setting"];
  readonly limit: number;
  readonly observedChars: number;

  constructor(observedChars: number, target: DiffInputLimit) {
    const mode = target.detail ? `${target.mode} (${target.detail})` : target.mode;
    super(
      `The ${mode} did not run: the complete filtered diff is ${observedChars} characters, ` +
        `but \`${target.setting}\` allows ${target.limit} characters. ` +
        "Robin does not send a partial diff, so it stops instead of reviewing an incomplete one. " +
        `Raise \`${target.setting}\` in the workflow/action input or applicable base-branch repo configuration, ` +
        "or split the change into smaller logically complete PRs."
    );
    this.name = "DiffInputLimitError";
    this.mode = target.mode;
    this.setting = target.setting;
    this.limit = target.limit;
    this.observedChars = observedChars;
  }
}

/**
 * Throws before the request when `diff` is larger than the cap selected for `target`.
 * `diff` must already be the diff after intentional path filtering.
 */
export function assertDiffFits(diff: string, target: DiffInputLimit): void {
  if (diff.length > target.limit) {
    throw new DiffInputLimitError(diff.length, target);
  }
}
