import { shouldSkipSynchronizeEvent } from "./trigger";

describe("shouldSkipSynchronizeEvent", () => {
  it("skips pushes to an existing PR unless the caller opts in", () => {
    expect(shouldSkipSynchronizeEvent("synchronize", false)).toBe(true);
    expect(shouldSkipSynchronizeEvent("synchronize", true)).toBe(false);
  });

  it.each(["opened", "reopened", "ready_for_review", undefined])(
    "does not skip a %s pull_request action",
    (action) => {
      expect(shouldSkipSynchronizeEvent(action, false)).toBe(false);
    },
  );
});
