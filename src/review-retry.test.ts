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
  it("does not retry valid JSON with empty findings and a summary", () => {
    expect(
      shouldRetryStructuredReview(
        emptyReview({ summary: "No issues found in this focused change." }),
        true
      )
    ).toBe(false);
  });

  it("retries when JSON was not used and there are no findings", () => {
    expect(shouldRetryStructuredReview(emptyReview(), false)).toBe(true);
  });

  it("does not retry markdown fallback with a substantive summary", () => {
    expect(
      shouldRetryStructuredReview(
        emptyReview({
          summary:
            "This pull request updates documentation only. No code risks were identified in the diff.",
        }),
        false
      )
    ).toBe(false);
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
        }),
        false
      )
    ).toBe(false);
  });
});
