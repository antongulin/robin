import { ReviewParser } from "./review-parser";

describe("ReviewParser", () => {
  it("parses strict JSON review output", () => {
    const review = ReviewParser.parse(
      JSON.stringify({
        summary: "Good structure, but one risky auth path needs work.",
        high: [
          {
            file: "src/auth.ts",
            line: 42,
            category: "security",
            description: "Missing authorization check before returning account data.",
            recommendation: "Check that the requester owns the account before returning it.",
            codeSnippet: "if (account.userId !== user.id) throw new Error('Forbidden');",
          },
        ],
        medium: [],
        low: [],
        suggestions: [],
      })
    );

    expect(review.summary).toContain("Good structure");
    expect(review.high).toHaveLength(1);
    expect(review.high[0]).toMatchObject({
      severity: "high",
      file: "src/auth.ts",
      line: 42,
      category: "security",
    });
  });

  it("parses confidence when present and ignores invalid values", () => {
    const review = ReviewParser.parse(
      JSON.stringify({
        summary: "ok",
        high: [
          { line: 1, description: "real bug", recommendation: "fix", confidence: "High" },
        ],
        medium: [
          { line: 2, description: "maybe", recommendation: "fix", confidence: "definitely" },
        ],
        low: [],
        suggestions: [],
      })
    );

    expect(review.high[0].confidence).toBe("high");
    expect(review.medium[0].confidence).toBeUndefined();
  });

  it("parses JSON inside a code fence", () => {
    const review = ReviewParser.parse(`Here is the review:\n\n\`\`\`json
{
  "summary": "Looks safe overall.",
  "high": [],
  "medium": [
    {
      "file": "src/main.ts",
      "line": "12",
      "category": "reliability",
      "description": "Timeout errors are not handled.",
      "recommendation": "Catch timeout errors and retry once."
    }
  ],
  "low": [],
  "suggestions": []
}
\`\`\``);

    expect(review.medium).toHaveLength(1);
    expect(review.medium[0].line).toBe(12);
  });

  it("accepts legacy critical and important JSON keys as high and medium", () => {
    const review = ReviewParser.parse(
      JSON.stringify({
        summary: "Legacy shape.",
        critical: [
          {
            file: "src/auth.ts",
            line: 42,
            category: "security",
            description: "Missing authorization check.",
            recommendation: "Add an authorization guard.",
          },
        ],
        important: [
          {
            file: "src/main.ts",
            line: 12,
            category: "reliability",
            description: "No timeout handling.",
            recommendation: "Catch timeout errors.",
          },
        ],
        suggestions: [],
      })
    );

    expect(review.high).toHaveLength(1);
    expect(review.high[0].severity).toBe("high");
    expect(review.medium).toHaveLength(1);
    expect(review.medium[0].severity).toBe("medium");
  });

  it("falls back to markdown headings and bullet findings", () => {
    const review = ReviewParser.parse(`### Summary
The change is focused and easy to follow.

### High Issues (must fix)
- src/auth.ts:42 -- Missing authorization check before returning account data.

### Medium Issues (should fix)
- None

### Low Issues
- src/index.ts:2 -- Export name is slightly unclear.

### Suggestions (nice to have)
1. README.md:12 - Clarify the setup instructions.
`);

    expect(review.summary).toContain("focused");
    expect(review.high).toHaveLength(1);
    expect(review.high[0]).toMatchObject({
      file: "src/auth.ts",
      line: 42,
      description: "Missing authorization check before returning account data.",
    });
    expect(review.medium).toHaveLength(0);
    expect(review.low).toHaveLength(1);
    expect(review.suggestions).toHaveLength(1);
    expect(review.suggestions[0].file).toBe("README.md");
  });
});
