import {
  assertRequestFits, EstimatedRequestBudgetError, parseEstimatedRequestTokenBudget,
  positiveSafeInteger, resolveOutputTokenCap,
} from "./request-budget";
import { parseRepoConfigYaml, resolveEstimatedRequestTokenBudget, resolveMaxDiffSize, resolveAgentMaxDiffSize } from "./repo-config";

describe("RB01 configuration and safe arithmetic", () => {
  test("defaults and explicit old caller values have unambiguous precedence", () => {
    const config = parseRepoConfigYaml('estimated-request-token-budget: "1000" # small endpoint\nmax-diff-size: 25000\nagent-max-diff-size: 30000');
    expect(resolveEstimatedRequestTokenBudget("", {})).toBe(256000);
    expect(resolveMaxDiffSize("", {})).toBe(500000);
    expect(resolveAgentMaxDiffSize("", {})).toBe(500000);
    expect(resolveEstimatedRequestTokenBudget("", config)).toBe(1000);
    expect(resolveEstimatedRequestTokenBudget("512000", config)).toBe(512000);
    expect(resolveMaxDiffSize("50000", config)).toBe(50000);
    expect(resolveMaxDiffSize("", config)).toBe(25000);
    expect(resolveAgentMaxDiffSize("", config)).toBe(30000);
    expect(resolveEstimatedRequestTokenBudget("", parseRepoConfigYaml("estimated-request-token-budget: 'off' # compatibility"))).toBe("off");
  });
  test.each(["", "0", "-1", "1.5", "123junk", "1e5", "9007199254740992", "[]", '"unterminated', "true"])("malformed config fails without echo: %s", value => {
    expect(() => resolveEstimatedRequestTokenBudget("", parseRepoConfigYaml(`estimated-request-token-budget: ${value}`))).toThrow(/Invalid estimated-request-token-budget/);
    expect(() => positiveSafeInteger(value, "max-output-tokens")).toThrow("Invalid max-output-tokens; use a positive safe integer.");
    if (value) expect(() => parseEstimatedRequestTokenBudget(value)).toThrow();
  });
  test("output cap scales, keeps explicit values, and off restores absent output", () => {
    expect(resolveOutputTokenCap(undefined, 256000)).toBe(32000);
    expect(resolveOutputTokenCap(undefined, 1000)).toBe(125);
    expect(resolveOutputTokenCap(undefined, 1)).toBe(1);
    expect(resolveOutputTokenCap(45000, 1000)).toBe(45000);
    expect(resolveOutputTokenCap(undefined, "off")).toBeUndefined();
    expect(resolveOutputTokenCap(123, "off")).toBe(123);
  });
  test.each([
    ["max-diff-size", resolveMaxDiffSize],
    ["agent-max-diff-size", resolveAgentMaxDiffSize],
  ] as const)("RC1 %s preserves explicit malformed YAML and accepts quoted caps", (setting, resolve) => {
    for (const value of ["", "25k"]) {
      expect(() => resolve("", parseRepoConfigYaml(`${setting}: ${value}`)))
        .toThrow(new RegExp(`^Invalid ${setting}; use a positive safe integer[.]$`));
    }
    expect(resolve("", parseRepoConfigYaml(`${setting}: "25000" # smaller cap`))).toBe(25000);
  });
  test("unsafe sums cannot round into acceptance", () => {
    expect(() => assertRequestFits({}, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toThrow(EstimatedRequestBudgetError);
    expect(() => assertRequestFits({}, 100, 94)).toThrow(EstimatedRequestBudgetError);
  });
});

describe("RB02 complete UTF-8 JSON estimate", () => {
  // Literal serialized bodies: '{}' is 2 bytes; '{\n  "a": "é"\n}' is 15 bytes.
  test("independent literal fixtures pass equality and reject one estimated token more", () => {
    expect(Buffer.byteLength('{\n  "a": "é"\n}', "utf8")).toBe(15);
    expect(() => assertRequestFits({ a: "é" }, 16, 10)).not.toThrow(); // 5+10+1
    expect(() => assertRequestFits({ a: "éxxx" }, 16, 10)).toThrow(expect.objectContaining({
      facts: { budget: 16, estimatedInput: 6, outputReserve: 10, safetyHeadroom: 1 },
    }));
    expect(() => assertRequestFits({}, 16, 14)).not.toThrow(); // 1+14+1
    expect(() => assertRequestFits({ a: "😀" }, 16, 10)).toThrow(EstimatedRequestBudgetError);
  });
  test("serializes history/private replay/tools/schema and escaped content rather than diff alone", () => {
    const base = { model: "arbitrary-local-model", stream: true, messages: [{ role: "user", content: "diff" }] };
    expect(() => assertRequestFits(base, 1000, 125)).not.toThrow();
    for (const extra of [
      { messages: [...base.messages, { role: "system", content: "instruction".repeat(500) }] },
      { messages: [...base.messages, { role: "assistant", content: null, reasoning_content: "private".repeat(1000) }] },
      { tools: [{ type: "function", function: { parameters: { description: "schema".repeat(1000) } } }] },
      { response_format: { type: "json_schema", json_schema: { schema: { description: "schema".repeat(1000) } } } },
      { messages: [{ role: "user", content: "😀".repeat(1000) }] },
    ]) expect(() => assertRequestFits({ ...base, ...extra }, 1000, 125)).toThrow(EstimatedRequestBudgetError);
  });
});
