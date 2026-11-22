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
