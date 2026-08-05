import {
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_TIMEOUT_MS,
  parseLLMTemperature,
  parseLLMTimeout,
} from "./config";

describe("parseLLMTimeout", () => {
  it("returns the default for empty input", () => {
    const result = parseLLMTimeout("");
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(result.valid).toBe(true);
  });

  it("parses a valid positive integer string", () => {
    const result = parseLLMTimeout("300000");
    expect(result.value).toBe(300000);
    expect(result.valid).toBe(true);
  });

  it("parses a positive float string", () => {
    // Number() preserves 5000.5 -> 5000.5
    const result = parseLLMTimeout("5000.5");
    expect(result.value).toBe(5000.5);
    expect(result.valid).toBe(true);
  });

  it("falls back for NaN string", () => {
    const result = parseLLMTimeout("not-a-number");
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(result.valid).toBe(false);
  });

  it("falls back for negative values", () => {
    const result = parseLLMTimeout("-1000");
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(result.valid).toBe(false);
  });

  it("falls back for zero", () => {
    const result = parseLLMTimeout("0");
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(result.valid).toBe(false);
  });

  it("falls back for whitespace-only string", () => {
    const result = parseLLMTimeout("   ");
    expect(result.value).toBe(DEFAULT_LLM_TIMEOUT_MS);
    expect(result.valid).toBe(false);
  });
});

describe("parseLLMTemperature", () => {
  it("returns the default for empty input", () => {
    const result = parseLLMTemperature("");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(true);
  });

  it("returns the default for whitespace-only input", () => {
    const result = parseLLMTemperature("  ");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(true);
  });

  it("parses the fixed temperature some models require", () => {
    const result = parseLLMTemperature("1");
    expect(result.value).toBe(1);
    expect(result.valid).toBe(true);
  });

  it("accepts zero as a real value, not a fallback", () => {
    const result = parseLLMTemperature("0");
    expect(result.value).toBe(0);
    expect(result.valid).toBe(true);
  });

  it("parses a float string", () => {
    const result = parseLLMTemperature("0.7");
    expect(result.value).toBe(0.7);
    expect(result.valid).toBe(true);
  });

  it("accepts the OpenAI-compatible upper bound", () => {
    const result = parseLLMTemperature("2");
    expect(result.value).toBe(2);
    expect(result.valid).toBe(true);
  });

  it("falls back above the upper bound", () => {
    const result = parseLLMTemperature("2.5");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(false);
  });

  it("falls back for negative values", () => {
    const result = parseLLMTemperature("-1");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(false);
  });

  it("falls back for NaN string", () => {
    const result = parseLLMTemperature("hot");
    expect(result.value).toBe(DEFAULT_LLM_TEMPERATURE);
    expect(result.valid).toBe(false);
  });
});
