import {
  computeRetryDelayMs,
  findUnsupportedRequestParam,
  getLlmCompletionAttemptCount,
  isInvalidReasoningEffortError,
  isOpenRouterRouterModel,
  isContextLengthError,
  isRetriableLlmError,
  isToolsUnsupportedError,
  isUnsupportedReasoningEffortError,
  openRouterStallError,
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

describe("openRouterStallError", () => {
  it("produces a retriable stall message", () => {
    const error = openRouterStallError(45000);
    expect(error.message).toContain("OpenRouter stall");
    expect(isRetriableLlmError(error, { model: "openrouter/free" })).toBe(true);
  });
});

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

describe("isUnsupportedReasoningEffortError", () => {
  it("detects 400/422 responses that report the reasoning/effort parameter as unknown", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Unsupported parameter: 'reasoning' is not supported with this model",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError(
        Object.assign(new Error("reasoning_effort is not supported"), { status: 422 })
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({ status: 400, message: "Unknown parameter: effort" })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Unrecognized request argument supplied: reasoning",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "This model does not support reasoning",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "The reasoning effort control is not supported for this model",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning not supported by this model",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "The reasoning parameter is not allowed for this model",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning: Extra inputs are not permitted",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: 'Unknown name "reasoning": Cannot bind field.',
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message:
          "Invalid JSON payload received. Unknown name \"reasoning\" at 'reasoning': Cannot find field.",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning: Input should be a valid string",
      })
    ).toBe(true);
  });

  it("lets an explicit parameter rejection win over value words elsewhere", () => {
    expect(
      isUnsupportedReasoningEffortError(
        {
          status: 400,
          message: "Unsupported parameter: reasoning; valid values are low, medium, high",
        },
        "low"
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError(
        { status: 400, message: "This model does not support high-effort reasoning" },
        "high"
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError(
        { status: 400, message: "reasoning is not supported with this model for effort high" },
        "high"
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning is not one of the supported parameters",
      })
    ).toBe(true);
  });

  it("does not cross a comma from an unrelated rejected parameter", () => {
    expect(
      isUnsupportedReasoningEffortError(
        {
          status: 400,
          message: "Unsupported parameter: temperature, reasoning models require temperature 1",
        },
        "high"
      )
    ).toBe(false);
  });

  it("keeps a mixed invalid-value message on the value path", () => {
    const mixed = {
      status: 400,
      message: "Unsupported value for parameter reasoning: must be one of low, medium, high",
    };
    expect(isUnsupportedReasoningEffortError(mixed, "extreme")).toBe(false);
    expect(isUnsupportedReasoningEffortError(mixed, "low")).toBe(false);
  });

  it("keeps a structured-param value complaint on the value path", () => {
    expect(
      isUnsupportedReasoningEffortError(
        {
          status: 400,
          message: "Invalid value: 'extreme'. Supported values are: low, medium, high",
          param: "reasoning_effort",
        },
        "extreme"
      )
    ).toBe(false);
  });

  it("matches explicit parameter rejections with underscored and hyphenated names", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Unsupported parameter: reasoning_effort",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning-effort is not supported",
      })
    ).toBe(true);
  });

  it("matches an explicit rejection of reasoning controls", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning controls rejected by the selected provider",
      })
    ).toBe(true);
  });

  it("uses a structured param naming the reasoning field when message text is inconclusive", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Request validation failed",
        param: "reasoning_effort",
      })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Invalid value for 'reasoning_effort': 'extreme'",
        param: "reasoning_effort",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Request validation failed",
        param: "temperature",
      })
    ).toBe(false);
  });

  it("treats a message repeating the configured effort value as a value complaint", () => {
    const valueRejection = {
      status: 400,
      message: "reasoning effort 'extreme' is not supported by this model",
    };
    expect(isUnsupportedReasoningEffortError(valueRejection, "extreme")).toBe(false);
    expect(
      isUnsupportedReasoningEffortError(
        { status: 400, message: "reasoning is not supported with this model" },
        "extreme"
      )
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError(
        { status: 400, message: "Unsupported parameter: reasoning; follow the docs" },
        "low"
      )
    ).toBe(true);
  });

  it("detects a rejected exclude sub-key of the reasoning request", () => {
    expect(
      isUnsupportedReasoningEffortError({ status: 400, message: "Unsupported parameter: exclude" })
    ).toBe(true);
    expect(
      isUnsupportedReasoningEffortError({ status: 400, message: "Invalid API key" })
    ).toBe(false);
  });

  it("ignores auth, rate-limit, server, timeout, and unrelated validation errors", () => {
    expect(
      isUnsupportedReasoningEffortError({ status: 401, message: "Invalid API key" })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({ status: 429, message: "reasoning rate limit" })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({ status: 500, message: "reasoning backend failed" })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({ status: 400, message: "Invalid temperature" })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "temperature 2 is not supported; reasoning models require 1",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "temperature 2 is not supported for reasoning models",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning models do not support temperature 0.1",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Unknown parameter: temperature; reasoning models require temperature 1",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "This model does not support temperature; reasoning models need 1",
      })
    ).toBe(false);
    expect(isUnsupportedReasoningEffortError(new Error("reasoning rejected"))).toBe(false);
    expect(isUnsupportedReasoningEffortError(undefined)).toBe(false);
  });

  it("does not treat invalid, out-of-range, or missing reasoning values as unsupported", () => {
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning effort must be one of low, medium, high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning effort should be one of low, medium, high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 422,
        message: "reasoning_effort: invalid value; expected one of low, medium, high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Invalid value for 'reasoning_effort': 'extreme' is not one of [low, medium, high]",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning_effort 'extreme' is not allowed; use low, medium, or high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning effort out of range: allowed values are low, medium, high",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "Missing required parameter: reasoning_effort",
      })
    ).toBe(false);
    expect(
      isUnsupportedReasoningEffortError({
        status: 400,
        message: "reasoning effort is required",
      })
    ).toBe(false);
  });
});

describe("isInvalidReasoningEffortError", () => {
  it("detects clear reasoning-effort value rejections", () => {
    expect(
      isInvalidReasoningEffortError(
        { status: 400, message: "reasoning effort must be one of low, medium, high" },
        "extreme"
      )
    ).toBe(true);
    expect(
      isInvalidReasoningEffortError(
        {
          status: 422,
          message: "Invalid value: 'extreme'. Supported values are low, medium, high",
          param: "reasoning_effort",
        },
        "extreme"
      )
    ).toBe(true);
    expect(
      isInvalidReasoningEffortError(
        { status: 400, message: "reasoning effort 'extreme' is not supported by this model" },
        "extreme"
      )
    ).toBe(true);
  });

  it("does not mask unsupported parameters or unrelated failures", () => {
    expect(
      isInvalidReasoningEffortError(
        { status: 400, message: "Unsupported parameter: reasoning" },
        "high"
      )
    ).toBe(false);
    expect(
      isInvalidReasoningEffortError(
        { status: 400, message: "Invalid temperature: only 1 is allowed" },
        "high"
      )
    ).toBe(false);
    expect(
      isInvalidReasoningEffortError(
        { status: 401, message: "Invalid reasoning effort" },
        "high"
      )
    ).toBe(false);
  });
});

describe("findUnsupportedRequestParam", () => {
  const sent = ["temperature", "max_tokens", "response_format"] as const;

  it("uses the structured param when the SDK provides one", () => {
    expect(
      findUnsupportedRequestParam(
        { status: 400, param: "temperature", message: "Unsupported value" },
        sent
      )
    ).toBe("temperature");
    expect(
      findUnsupportedRequestParam(
        {
          status: 400,
          param: "max_tokens",
          message:
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        },
        sent
      )
    ).toBe("max_tokens");
  });

  it("matches Anthropic's deprecated-temperature rejection for newer Claude models", () => {
    expect(
      findUnsupportedRequestParam({ status: 400, message: "400 `temperature` is deprecated for this model." }, sent)
    ).toBe("temperature");
  });

  it("matches the live OpenAI messages without a structured param", () => {
    expect(
      findUnsupportedRequestParam(
        {
          status: 400,
          message:
            "400 Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported.",
        },
        sent
      )
    ).toBe("temperature");
    expect(
      findUnsupportedRequestParam(
        {
          status: 400,
          message:
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        },
        sent
      )
    ).toBe("max_tokens");
  });

  it("matches provider phrasing that names the parameter bare", () => {
    expect(
      findUnsupportedRequestParam(
        { status: 400, message: "temperature must be 1 for reasoning models" },
        sent
      )
    ).toBe("temperature");
    expect(
      findUnsupportedRequestParam(
        { status: 400, message: "Invalid temperature: only 1 is allowed" },
        sent
      )
    ).toBe("temperature");
    expect(
      findUnsupportedRequestParam(
        { status: 422, message: "response_format: Extra inputs are not permitted" },
        sent
      )
    ).toBe("response_format");
  });

  it("only reports parameters that were actually sent", () => {
    expect(
      findUnsupportedRequestParam(
        { status: 400, message: "Unsupported parameter: 'max_tokens'" },
        ["temperature"]
      )
    ).toBeUndefined();
    expect(
      findUnsupportedRequestParam(
        { status: 400, param: "max_completion_tokens", message: "Unknown parameter" },
        ["max_tokens"]
      )
    ).toBeUndefined();
    expect(findUnsupportedRequestParam({ status: 400, message: "Unsupported parameter: 'temperature'" }, [])).toBeUndefined();
  });

  it("does not match max_tokens inside max_completion_tokens", () => {
    expect(
      findUnsupportedRequestParam(
        { status: 400, message: "Unknown parameter: max_completion_tokens" },
        ["max_tokens"]
      )
    ).toBeUndefined();
  });

  it("ignores non-validation statuses and unrelated validation errors", () => {
    expect(
      findUnsupportedRequestParam({ status: 500, message: "temperature service failed" }, sent)
    ).toBeUndefined();
    expect(
      findUnsupportedRequestParam({ status: 401, message: "Invalid API key" }, sent)
    ).toBeUndefined();
    expect(
      findUnsupportedRequestParam({ status: 400, message: "Invalid API key" }, sent)
    ).toBeUndefined();
    expect(
      findUnsupportedRequestParam(
        {
          status: 400,
          message:
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
        },
        sent
      )
    ).toBeUndefined();
    expect(findUnsupportedRequestParam(new Error("temperature unsupported"), sent)).toBeUndefined();
    expect(findUnsupportedRequestParam(undefined, sent)).toBeUndefined();
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

describe("isToolsUnsupportedError", () => {
  const withStatus = (status: number, message: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), { status, ...extra });

  it.each([
    withStatus(404, "404 No endpoints found that support tool use. Try disabling \"read_file\"."),
    withStatus(400, "registry.ollama.ai/library/llama2:latest does not support tools"),
    withStatus(400, "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"),
    withStatus(400, "Function calling is not supported by this model"),
    withStatus(422, "Extra inputs are not permitted: tools"),
    withStatus(400, "Invalid request", { param: "tool_choice" }),
  ])("detects %s", (error) => {
    expect(isToolsUnsupportedError(error)).toBe(true);
  });

  it.each([
    withStatus(429, "Rate limit exceeded while using tools"),
    withStatus(500, "tools not available right now"),
    withStatus(400, "temperature must be 1"),
    withStatus(404, "Provider returned error"),
    withStatus(401, "Invalid API key"),
  ])("ignores unrelated error %s", (error) => {
    expect(isToolsUnsupportedError(error)).toBe(false);
  });
});

describe("isContextLengthError", () => {
  const withStatus = (status: number, message: string) => Object.assign(new Error(message), { status });

  it.each([
    withStatus(400, "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens."),
    withStatus(400, "prompt is too long: 210000 tokens > 200000 maximum"),
    withStatus(400, "context_length_exceeded"),
    withStatus(413, "Request Entity Too Large"),
    new Error("Failed to get response from LLM: Error: 400 Input is too long for requested model."),
  ])("detects %s", (error) => {
    expect(isContextLengthError(error)).toBe(true);
  });

  it.each([
    withStatus(429, "Too many requests"),
    withStatus(400, "temperature must be 1"),
    withStatus(500, "maximum context length exceeded"),
  ])("ignores %s", (error) => {
    expect(isContextLengthError(error)).toBe(false);
  });
});
