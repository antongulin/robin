import { shouldRetryStructuredReview } from "./review-retry";
import { StructuredReview } from "./review-parser";

function emptyReview(overrides: Partial<StructuredReview> = {}): StructuredReview {
  return {
    summary: "",
    high: [],
    medium: [],
    low: [],
    suggestions: [],
    rawResponse: "",
    ...overrides,
  };
}

describe("shouldRetryStructuredReview", () => {
  it("returns true when every finding list is empty", () => {
    expect(
      shouldRetryStructuredReview(
        emptyReview({ summary: "A long summary alone should still trigger retry" })
      )
    ).toBe(true);
  });

  it("returns false when any severity bucket has findings", () => {
    expect(
      shouldRetryStructuredReview(
        emptyReview({
          medium: [
            {
              severity: "medium",
              category: "correctness",
              description: "Issue",
              recommendation: "Fix it",
            },
          ],
        })
      )
    ).toBe(false);
  });
});
