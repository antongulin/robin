/**
 * JSON Schema for the single-shot review object described in `reviewCriteriaAndFormat`.
 * Kept inside the subset both OpenAI and Anthropic strict mode accept: every property is
 * required (optional values are empty strings or null), every object closes with
 * `additionalProperties: false`, and no numeric or string-length constraints are used.
 */
const FINDING_SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
    line: { anyOf: [{ type: "integer" }, { type: "null" }] },
    category: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    description: { type: "string" },
    recommendation: { type: "string" },
    codeSnippet: { type: "string" },
  },
  required: ["file", "line", "category", "confidence", "description", "recommendation", "codeSnippet"],
  additionalProperties: false,
} as const;

export const REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    high: { type: "array", items: FINDING_SCHEMA },
    medium: { type: "array", items: FINDING_SCHEMA },
    low: { type: "array", items: FINDING_SCHEMA },
    suggestions: { type: "array", items: FINDING_SCHEMA },
  },
  required: ["summary", "high", "medium", "low", "suggestions"],
  additionalProperties: false,
} as const;
