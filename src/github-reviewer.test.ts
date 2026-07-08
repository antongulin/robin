import { GitHubReviewer } from "./github-reviewer";

describe("GitHubReviewer", () => {
  it("resolves review event from high findings and request-changes mode", () => {
    expect(GitHubReviewer.resolveReviewEvent(true, true)).toBe("REQUEST_CHANGES");
    expect(GitHubReviewer.resolveReviewEvent(true, false)).toBe("COMMENT");
    expect(GitHubReviewer.resolveReviewEvent(false, true)).toBe("COMMENT");
    expect(GitHubReviewer.resolveReviewEvent(false, false)).toBe("COMMENT");
  });

  it("identifies stale Robin CHANGES_REQUESTED reviews to dismiss", () => {
    const robinBody = "## :bow_and_arrow: Robin\n\nfindings…";
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: robinBody }, 2)
    ).toBe(true);
    // the review just posted
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 2, state: "CHANGES_REQUESTED", body: robinBody }, 2)
    ).toBe(false);
    // non-blocking Robin review
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "COMMENTED", body: robinBody }, 2)
    ).toBe(false);
    // human review must never be dismissed
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: "LGTM-ish" }, 2)
    ).toBe(false);
    expect(GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: null }, 2)).toBe(false);
  });

  it("detects new-file line numbers present in the diff", () => {
    const reviewer = new GitHubReviewer({} as any);
    const isLineInNewDiff = (reviewer as any).isLineInNewDiff.bind(reviewer) as (
      patch: string,
      targetLine: number
    ) => boolean;

    const patch = [
      "@@ -1,3 +1,4 @@",
      " import value from './value';",
      "-const oldName = value;",
      "+const newName = value;",
      "+const enabled = true;",
      " export { newName };",
    ].join("\n");

    expect(isLineInNewDiff(patch, 2)).toBe(true);
    expect(isLineInNewDiff(patch, 3)).toBe(true);
    expect(isLineInNewDiff(patch, 4)).toBe(true);
    expect(isLineInNewDiff(patch, 99)).toBe(false);
  });

  it("uses line and side for inline review comments", () => {
    const reviewer = new GitHubReviewer({} as any);
    const buildReviewComments = (reviewer as any).buildReviewComments.bind(reviewer);

    const findings = {
      summary: "Summary",
      high: [],
      medium: [
        {
          severity: "medium",
          file: "src/example.ts",
          line: 3,
          description: "Finding",
        },
      ],
      low: [],
      suggestions: [],
    };

    const files = [
      {
        filename: "src/example.ts",
        patch: [
          "@@ -1,2 +1,3 @@",
          " const first = true;",
          "+const second = true;",
          "+const third = true;",
        ].join("\n"),
      },
    ];

    const { comments } = buildReviewComments(findings, files);

    expect(comments).toEqual([
      expect.objectContaining({
        path: "src/example.ts",
        line: 3,
        side: "RIGHT",
      }),
    ]);
    expect(comments[0]).not.toHaveProperty("position");
  });

  it("retries inline comment coordinate errors using response details", () => {
    const reviewer = new GitHubReviewer({} as any);
    const shouldRetryWithoutInlineComments = (
      reviewer as any
    ).shouldRetryWithoutInlineComments.bind(reviewer) as (error: unknown) => boolean;

    expect(shouldRetryWithoutInlineComments({
      status: 422,
      response: {
        data: {
          errors: [{ field: "comments.line", code: "invalid" }],
        },
      },
    })).toBe(true);

    expect(shouldRetryWithoutInlineComments({ status: 403, message: "Forbidden" })).toBe(false);
  });
});
