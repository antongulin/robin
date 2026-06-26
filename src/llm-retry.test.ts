import {
  computeRetryDelayMs,
  getLlmCompletionAttemptCount,
  isOpenRouterRouterModel,
  isRetriableLlmError,
  resolveLlmTimeoutMs,
  shouldUseJsonResponseMode,
} from "./llm-retry";
import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_RETRY_DELAY_MS,
  DEFAULT_LLM_ROUTER_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
} from "./config";

describe("resolveLlmTimeoutMs", () => {
  it("shortens the default timeout for OpenRouter routers", () => {
    expect(resolveLlmTimeoutMs("openrouter/free", DEFAULT_LLM_TIMEOUT_MS)).toBe(
      DEFAULT_LLM_ROUTER_TIMEOUT_MS
    );
    expect(resolveLlmTimeoutMs("gpt-4o", DEFAULT_LLM_TIMEOUT_MS)).toBe(DEFAULT_LLM_TIMEOUT_MS);
  });

  it("keeps an explicit consumer override", () => {
    expect(resolveLlmTimeoutMs("openrouter/free", 300000)).toBe(300000);
  });
});

describe("isOpenRouterRouterModel", () => {
  it("detects OpenRouter free and auto routers", () => {
    expect(isOpenRouterRouterModel("openrouter/free")).toBe(true);
    expect(isOpenRouterRouterModel("openrouter/auto")).toBe(true);
    expect(isOpenRouterRouterModel("gpt-4o")).toBe(false);
  });
});

describe("isRetriableLlmError", () => {
  it("retries rate limits and server errors", () => {
    expect(isRetriableLlmError({ status: 429 })).toBe(true);
    expect(isRetriableLlmError({ status: 502 })).toBe(true);
  });

  it("does not retry client auth or validation errors", () => {
    expect(isRetriableLlmError({ status: 401 })).toBe(false);
    expect(isRetriableLlmError({ status: 400 })).toBe(false);
  });

  it("retries network and timeout messages", () => {
    expect(isRetriableLlmError(new Error("Request timed out"))).toBe(true);
    expect(isRetriableLlmError(new Error("ECONNRESET"))).toBe(true);
    expect(
      isRetriableLlmError(new Error("OpenRouter stall: no first response within 45000 ms"), {
        model: "openrouter/free",
      })
    ).toBe(true);
  });

  it("retries OpenRouter provider 404s for router models", () => {
    expect(
      isRetriableLlmError(new Error("404 Provider returned error"), {
        model: "openrouter/free",
      })
    ).toBe(true);
    expect(isRetriableLlmError({ status: 404 }, { model: "openrouter/free" })).toBe(true);
    expect(isRetriableLlmError({ status: 404 }, { model: "gpt-4o" })).toBe(false);
  });
});

describe("shouldUseJsonResponseMode", () => {
  it("uses JSON only on the first attempt", () => {
    expect(shouldUseJsonResponseMode(1, true)).toBe(true);
    expect(shouldUseJsonResponseMode(2, true)).toBe(false);
    expect(shouldUseJsonResponseMode(1, false)).toBe(false);
  });
});

describe("computeRetryDelayMs", () => {
  it("backs off linearly by attempt", () => {
    expect(computeRetryDelayMs(1, {}, 1000)).toBe(1000);
    expect(computeRetryDelayMs(2, {}, 1000)).toBe(2000);
  });

  it("uses longer base delay for router models", () => {
    expect(computeRetryDelayMs(1, { model: "openrouter/free" })).toBe(
      DEFAULT_LLM_ROUTER_RETRY_DELAY_MS
    );
  });
});

describe("getLlmCompletionAttemptCount", () => {
  it("clamps invalid values to at least one", () => {
    expect(getLlmCompletionAttemptCount(0)).toBe(1);
    expect(getLlmCompletionAttemptCount(2.7)).toBe(2);
  });

  it("uses more attempts for OpenRouter router models by default", () => {
    expect(getLlmCompletionAttemptCount(DEFAULT_LLM_COMPLETION_ATTEMPTS, "openrouter/free")).toBe(
      DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS
    );
    expect(getLlmCompletionAttemptCount(DEFAULT_LLM_COMPLETION_ATTEMPTS, "gpt-4o")).toBe(
      DEFAULT_LLM_COMPLETION_ATTEMPTS
    );
  });
});
