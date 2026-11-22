export const EXPERIMENT_IDS = ["read-skip", "final-repair", "rereview-memory", "plan-batch", "attach-files", "calibrate", "turn-budget"] as const;
export type ExperimentId = typeof EXPERIMENT_IDS[number];
export function parseExperimentSwitches(raw: string | undefined): { enabled: Set<ExperimentId>; unknown: string[] } {
  const enabled = new Set<ExperimentId>();
  const unknown: string[] = [];
  for (const id of (raw ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if ((EXPERIMENT_IDS as readonly string[]).includes(id)) enabled.add(id as ExperimentId);
    else if (!unknown.includes(id)) unknown.push(id);
  }
  return { enabled, unknown };
}
export function experimentEnabled(enabled: Set<ExperimentId>, id: ExperimentId): boolean { return enabled.has(id); }

/** Experiment `turn-budget`: turn caps chosen from the filtered diff size in characters. */
export const EXPERIMENT_SMALL_DIFF_CHARS = 10_000;
export const EXPERIMENT_MEDIUM_DIFF_CHARS = 60_000;

/**
 * Effective agent turn budget for the `turn-budget` experiment. Off returns the resolved
 * budget unchanged; on caps small and medium diffs and never raises the configured value.
 */
export function resolveExperimentAgentTurns(
  configured: number,
  diffChars: number,
  enabled: boolean
): number {
  if (!enabled) return configured;
  const cap =
    diffChars < EXPERIMENT_SMALL_DIFF_CHARS ? 20 : diffChars < EXPERIMENT_MEDIUM_DIFF_CHARS ? 32 : null;
  return cap === null ? configured : Math.min(configured, cap);
}
