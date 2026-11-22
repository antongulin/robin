import { parseExperimentSwitches } from "./experiment";

test("E1 parses switches, whitespace, duplicates and unknown ids", () => {
  expect(parseExperimentSwitches(undefined)).toEqual({ enabled: new Set(), unknown: [] });
  expect(parseExperimentSwitches(" , ")).toEqual({ enabled: new Set(), unknown: [] });
  expect(parseExperimentSwitches("read-skip, FINAL-REPAIR \tread-skip, mystery")).toEqual({ enabled: new Set(["read-skip", "final-repair"]), unknown: ["mystery"] });
});
