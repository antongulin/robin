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
    const bot = { type: "Bot" };
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, 2)
    ).toBe(true);
    // the review just posted
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 2, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, 2)
    ).toBe(false);
    // non-blocking Robin review
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "COMMENTED", body: robinBody, user: bot }, 2)
    ).toBe(false);
    // human review must never be dismissed — even one quoting Robin's signature
    expect(
      GitHubReviewer.isStaleRobinReview(
        { id: 1, state: "CHANGES_REQUESTED", body: robinBody, user: { type: "User" } },
        2
      )
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: "LGTM-ish", user: bot }, 2)
    ).toBe(false);
    expect(
      GitHubReviewer.isStaleRobinReview({ id: 1, state: "CHANGES_REQUESTED", body: null, user: bot }, 2)
    ).toBe(false);
  });

  it("dismisses only stale Robin CHANGES_REQUESTED reviews after posting", async () => {
    const robinBody = "## :bow_and_arrow: Robin\n\nfindings…";
    const bot = { type: "Bot" };
    const reviews = [
      { id: 10, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, // stale — dismiss
      { id: 11, state: "COMMENTED", body: robinBody, user: bot }, // non-blocking — keep
      { id: 12, state: "CHANGES_REQUESTED", body: "human review", user: { type: "User" } }, // human — keep
      { id: 20, state: "CHANGES_REQUESTED", body: robinBody, user: bot }, // the new review itself
    ];
    const dismissReview = jest.fn().mockResolvedValue({});
    const octokit = {
      paginate: jest.fn().mockResolvedValue(reviews),
      rest: { pulls: { listReviews: {}, dismissReview } },
    };

    const reviewer = new GitHubReviewer(octokit as any);
    await (reviewer as any).dismissStaleRobinReviews("o", "r", 1, 20);

    expect(dismissReview).toHaveBeenCalledTimes(1);
    expect(dismissReview).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: 10, pull_number: 1 })
    );
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

  describe("suggested changes", () => {
    const patch = [
      "@@ -1,2 +1,4 @@",
      " const first = true;",
      "+const second = true;",
      "+const third = true;",
      " const fourth = true;",
      "@@ -20,2 +22,3 @@",
      " const later = 1;",
      "+const added = 2;",
      " const end = 3;",
    ].join("\n");
    const files = [{ filename: "src/example.ts", patch }];

    function build(finding: Record<string, unknown>) {
      const reviewer = new GitHubReviewer({} as any);
      return (reviewer as any).buildReviewComments(
        {
          summary: "",
          high: [{ severity: "high", file: "src/example.ts", description: "Bug", recommendation: "", ...finding }],
          medium: [],
          low: [],
          suggestions: [],
        },
        files
      ).comments;
    }

    it("posts a single-line suggestion block", () => {
      const [comment] = build({ line: 2, suggestion: "const second = false;" });
      expect(comment).toMatchObject({ path: "src/example.ts", line: 2, side: "RIGHT" });
      expect(comment).not.toHaveProperty("start_line");
      expect(comment.body).toContain("```suggestion\nconst second = false;\n```");
    });

    it("posts a multi-line suggestion within one hunk with start_line", () => {
      const [comment] = build({ line: 3, startLine: 2, suggestion: "const second = 2;\nconst third = 3;" });
      expect(comment).toMatchObject({ start_line: 2, start_side: "RIGHT", line: 3, side: "RIGHT" });
      expect(comment.body).toContain("```suggestion\nconst second = 2;\nconst third = 3;\n```");
    });

    it("falls back to a plain code block when the range spans hunks", () => {
      const [comment] = build({ line: 23, startLine: 3, suggestion: "replacement" });
      expect(comment).toMatchObject({ line: 23 });
      expect(comment).not.toHaveProperty("start_line");
      expect(comment.body).not.toContain("```suggestion");
      expect(comment.body).toContain("```\nreplacement\n```");
    });

    it("uses a longer fence when the suggestion contains backticks", () => {
      const [comment] = build({ line: 2, suggestion: "const md = \"```\";" });
      expect(comment.body).toContain("````suggestion\nconst md = \"```\";\n````");
    });
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
