import { resolveExperimentAgentTurns } from "./experiment";

describe("turn-budget experiment", () => {
  it("T1 keeps the resolved budget for any diff size when the switch is off", () => {
    for (const diffChars of [0, 9_999, 10_000, 59_999, 60_000, 500_000]) {
      expect(resolveExperimentAgentTurns(40, diffChars, false)).toBe(40);
      expect(resolveExperimentAgentTurns(12, diffChars, false)).toBe(12);
    }
  });

  it("T2 caps by diff size and never raises the configured budget", () => {
    expect(resolveExperimentAgentTurns(40, 9_999, true)).toBe(20);
    expect(resolveExperimentAgentTurns(40, 10_000, true)).toBe(32);
    expect(resolveExperimentAgentTurns(40, 59_999, true)).toBe(32);
    expect(resolveExperimentAgentTurns(40, 60_000, true)).toBe(40);
    expect(resolveExperimentAgentTurns(12, 9_999, true)).toBe(12);
    expect(resolveExperimentAgentTurns(12, 10_000, true)).toBe(12);
  });
});
