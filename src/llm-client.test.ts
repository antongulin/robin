jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as core from "@actions/core";
import { LLMClient, ToolsUnsupportedError } from "./llm-client";

const warningMock = core.warning as unknown as jest.Mock;

interface StubbedOpenAI {
  chat: { completions: { create: jest.Mock } };
}

function buildRequest(client: LLMClient, jsonResponseMode = true) {
  return (
    client as unknown as {
      buildRequest(
        systemPrompt: string,
        userContent: string,
        jsonResponseMode: boolean,
      ): Record<string, unknown>;
    }
  ).buildRequest("system", "user", jsonResponseMode);
}

function stubOpenAI(client: LLMClient): jest.Mock {
  const create = jest.fn();
  (client as unknown as { client: StubbedOpenAI }).client = {
    chat: { completions: { create } },
  };
  return create;
}

function completionResponse(content: string) {
  return {
    model: "resolved-model",
    choices: [{ message: { content }, finish_reason: "stop" }],
  };
}

function reasoningRejection(
  status = 400,
  message = "Unsupported parameter: reasoning is not supported with this model",
) {
  return Object.assign(new Error(message), { status });
}

function streamOf(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function fallbackWarnings(): unknown[][] {
  return warningMock.mock.calls.filter(([message]) =>
    String(message).includes("Retrying once without the reasoning"),
  );
}

function parameterWarnings(): unknown[][] {
  return warningMock.mock.calls.filter(([message]) =>
    String(message).includes("Provider rejected the"),
  ).filter(([message]) => !String(message).includes("reasoning effort"));
}

function paramRejection(param: string, message: string, status = 400) {
  return Object.assign(new Error(message), { status, param, code: "unsupported_value" });
}

function makeClient(baseUrl: string, model: string, options: { maxOutputTokens?: number; effort?: string } = {}) {
  return new LLMClient(
    baseUrl,
    "test-key",
    model,
    options.maxOutputTokens,
    undefined,
    1,
    undefined,
    undefined,
    options.effort,
  );
}

describe("LLMClient provider-aware request shape", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("normalizes a bare Anthropic host to the /v1 compatibility endpoint", () => {
    const client = makeClient("https://api.anthropic.com", "claude-sonnet-4-5");
    const sdk = (client as unknown as { client: { baseURL: string } }).client;
    expect(sdk.baseURL).toBe("https://api.anthropic.com/v1");
  });

  it("strips a pasted full endpoint path from the base URL", () => {
    const client = makeClient("https://api.openai.com/v1/chat/completions", "gpt-4o");
    const sdk = (client as unknown as { client: { baseURL: string } }).client;
    expect(sdk.baseURL).toBe("https://api.openai.com/v1");
  });

  it("leaves self-hosted and proxy base URLs untouched", () => {
    const client = makeClient("http://my-server:11434/v1", "llama3.2");
    const sdk = (client as unknown as { client: { baseURL: string } }).client;
    expect(sdk.baseURL).toBe("http://my-server:11434/v1");
  });

  it("sends OpenAI-native reasoning_effort to api.openai.com", () => {
    const client = makeClient("https://api.openai.com/v1", "gpt-4o", { effort: "high" });
    const request = buildRequest(client);
    expect(request).toHaveProperty("reasoning_effort", "high");
    expect(request).not.toHaveProperty("reasoning");
  });

  it("keeps the OpenRouter reasoning object for other hosts", () => {
    const client = makeClient("https://openrouter.ai/api/v1", "openai/gpt-4o", { effort: "high" });
    expect(buildRequest(client)).toMatchObject({ reasoning: { effort: "high", exclude: true } });
  });

  it("sends no reasoning control to Anthropic, whose compatibility layer ignores it", () => {
    const client = makeClient("https://api.anthropic.com/v1", "claude-sonnet-4-5", {
      effort: "high",
    });
    const request = buildRequest(client);
    expect(request).not.toHaveProperty("reasoning");
    expect(request).not.toHaveProperty("reasoning_effort");
    expect(request).toHaveProperty("temperature", 0.1);
  });

  it.each(["gpt-5", "gpt-5-mini", "gpt-5.1-codex", "o3", "o4-mini", "openai/o1-preview", "codex-mini-latest"])(
    "omits temperature and uses max_completion_tokens for OpenAI reasoning model %s",
    (model) => {
      const client = makeClient("https://api.openai.com/v1", model, { maxOutputTokens: 4000 });
      const request = buildRequest(client);
      expect(request).not.toHaveProperty("temperature");
      expect(request).not.toHaveProperty("max_tokens");
      expect(request).toHaveProperty("max_completion_tokens", 4000);
    },
  );

  it.each(["gpt-4o", "gpt-4.1-mini", "claude-sonnet-4-5", "llama3.2", "openrouter/free"])(
    "keeps temperature and max_tokens for %s",
    (model) => {
      const client = makeClient("https://example.test/v1", model, { maxOutputTokens: 4000 });
      const request = buildRequest(client);
      expect(request).toHaveProperty("temperature", 0.1);
      expect(request).toHaveProperty("max_tokens", 4000);
      expect(request).not.toHaveProperty("max_completion_tokens");
    },
  );
});

describe("LLMClient unsupported parameter fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("retries without temperature when the provider rejects it with a structured param", async () => {
    const client = makeClient("https://api.openai.com/v1", "some-new-model");
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        paramRejection(
          "temperature",
          "400 Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported.",
        ),
      )
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toHaveProperty("temperature", 0.1);
    expect(create.mock.calls[1][0]).not.toHaveProperty("temperature");
    expect(parameterWarnings()).toHaveLength(1);
    expect(String(parameterWarnings()[0][0])).toContain("temperature");
  });

  it("switches max_tokens to max_completion_tokens when the provider asks for it", async () => {
    const client = makeClient("https://api.openai.com/v1", "some-new-model", {
      maxOutputTokens: 3000,
    });
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            "400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          ),
          { status: 400, param: "max_tokens", code: "unsupported_parameter" },
        ),
      )
      .mockResolvedValueOnce(completionResponse("review text"));

    await client.chatCompletion("system", "user");

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toHaveProperty("max_tokens", 3000);
    expect(create.mock.calls[1][0]).not.toHaveProperty("max_tokens");
    expect(create.mock.calls[1][0]).toHaveProperty("max_completion_tokens", 3000);
  });

  it("drops the token cap entirely when max_completion_tokens is also rejected", async () => {
    const client = makeClient("https://example.test/v1", "gpt-5", { maxOutputTokens: 3000 });
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        Object.assign(new Error("Unknown parameter: max_completion_tokens"), { status: 400 }),
      )
      .mockResolvedValueOnce(completionResponse("review text"));

    await client.chatCompletion("system", "user");

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("max_tokens");
    expect(create.mock.calls[1][0]).not.toHaveProperty("max_completion_tokens");
  });

  it("steps down from the review JSON schema to JSON-object mode, then drops response_format", async () => {
    const client = makeClient("https://example.test/v1", "model");
    const create = stubOpenAI(client);
    const rejection = () =>
      Object.assign(new Error("response_format is not supported by this model"), { status: 400 });
    create
      .mockRejectedValueOnce(rejection())
      .mockRejectedValueOnce(rejection())
      .mockResolvedValueOnce(completionResponse("review text"));

    await client.chatCompletion("system", "user", true);

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0][0].response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "robin_review", strict: true },
    });
    expect(create.mock.calls[1][0].response_format).toEqual({ type: "json_object" });
    expect(create.mock.calls[2][0]).not.toHaveProperty("response_format");
  });

  it("drops a rejected schema straight away on Anthropic, which has no plain JSON mode", async () => {
    const client = makeClient("https://api.anthropic.com/v1", "claude-opus-5-5");
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        Object.assign(new Error("response_format.json_schema: structured outputs are not supported for this model"), {
          status: 400,
        })
      )
      .mockResolvedValueOnce(completionResponse("review text"));

    await client.chatCompletion("system", "user", true);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].response_format).toMatchObject({ type: "json_schema" });
    expect(create.mock.calls[1][0]).not.toHaveProperty("response_format");
  });

  it("recovers from several rejected parameters in one completion", async () => {
    const client = makeClient("https://api.openai.com/v1", "some-new-model", {
      maxOutputTokens: 3000,
    });
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(paramRejection("temperature", "Unsupported value: 'temperature'"))
      .mockRejectedValueOnce(paramRejection("max_tokens", "Unsupported parameter: 'max_tokens'"))
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0]).not.toHaveProperty("temperature");
    expect(create.mock.calls[2][0]).toHaveProperty("max_completion_tokens", 3000);
  });

  it("keeps the adjusted shape for later completions", async () => {
    const client = makeClient("https://api.openai.com/v1", "some-new-model");
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(paramRejection("temperature", "Unsupported value: 'temperature'"))
      .mockResolvedValueOnce(completionResponse("first"))
      .mockResolvedValueOnce(completionResponse("second"));

    await client.chatCompletion("system", "user");
    await client.chatCompletion("system", "user");

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0]).not.toHaveProperty("temperature");
    expect(parameterWarnings()).toHaveLength(1);
  });

  it("surfaces the error when the same parameter is rejected again after being dropped", async () => {
    const client = makeClient("https://api.openai.com/v1", "some-new-model");
    const create = stubOpenAI(client);
    create.mockRejectedValue(paramRejection("temperature", "Unsupported value: 'temperature'"));

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not drop parameters on auth or server errors", async () => {
    const client = makeClient("https://api.openai.com/v1", "some-new-model");
    const create = stubOpenAI(client);
    create.mockRejectedValue(
      Object.assign(new Error("temperature backend failed"), { status: 500 }),
    );

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(parameterWarnings()).toHaveLength(0);
  });

  it("handles both a rejected reasoning control and a rejected temperature", async () => {
    const client = makeClient("https://api.openai.com/v1", "some-new-model", { effort: "high" });
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection(400, "Unsupported parameter: 'reasoning_effort'"))
      .mockRejectedValueOnce(paramRejection("temperature", "Unsupported value: 'temperature'"))
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0][0]).toHaveProperty("reasoning_effort", "high");
    expect(create.mock.calls[2][0]).not.toHaveProperty("reasoning_effort");
    expect(create.mock.calls[2][0]).not.toHaveProperty("temperature");
    expect(fallbackWarnings()).toHaveLength(1);
    expect(parameterWarnings()).toHaveLength(1);
  });

  it("surfaces a rejected parameter on the streaming path instead of a stall", async () => {
    const client = makeClient("https://openrouter.ai/api/v1", "openrouter/free");
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(paramRejection("temperature", "Unsupported value: 'temperature'"))
      .mockResolvedValueOnce(
        streamOf([{ model: "vendor/model", choices: [{ delta: { content: "streamed review" } }] }]),
      );

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("streamed review");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("temperature");
  });
});

describe("LLMClient reasoning request shape", () => {
  it("preserves the default request shape when effort is unset", () => {
    const client = new LLMClient("https://example.test/v1", "test-key", "model");
    const request = buildRequest(client);

    expect(request).not.toHaveProperty("reasoning");
    expect(request).toMatchObject({
      model: "model",
      temperature: 0.1,
      response_format: { type: "json_schema", json_schema: { name: "robin_review", strict: true } },
    });
    expect(request).not.toHaveProperty("max_tokens");
  });

  it.each(["", "   "])("does not emit reasoning for whitespace effort %j", (effort) => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      effort,
    );
    expect(buildRequest(client)).not.toHaveProperty("reasoning");
  });

  it("adds trimmed effort with hidden reasoning excluded", () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "  high  ",
    );
    expect(buildRequest(client).reasoning).toEqual({ effort: "high", exclude: true });
  });

  it("passes provider-specific effort names through unchanged", () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "provider-custom",
    );
    expect(buildRequest(client).reasoning).toEqual({
      effort: "provider-custom",
      exclude: true,
    });
  });
});

describe("LLMClient reasoning fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("retries once without reasoning when the provider rejects the parameter", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection())
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      reasoning: { effort: "high", exclude: true },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
    expect(client.getReasoningFallbackReason()).toBe("unsupported");
  });

  it("keeps reasoning off for later completions after one fallback", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection(422, "reasoning_effort is not supported"))
      .mockResolvedValueOnce(completionResponse("first"))
      .mockResolvedValueOnce(completionResponse("second"));

    await client.chatCompletion("system", "user");
    await client.chatCompletion("system", "user");

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("does not fall back on auth errors", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(Object.assign(new Error("Invalid API key"), { status: 401 }));

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("drops temperature rather than reasoning when the provider rejects the temperature", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(
      Object.assign(new Error("Invalid temperature: only 1 is allowed"), { status: 400 }),
    );

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    // One temperature-less retry, then the error surfaces; reasoning is never dropped.
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toHaveProperty("temperature", 0.1);
    expect(create.mock.calls[1][0]).not.toHaveProperty("temperature");
    expect(create.mock.calls[1][0]).toMatchObject({ reasoning: { effort: "high" } });
    expect(fallbackWarnings()).toHaveLength(0);
    expect(client.getReasoningFallbackReason()).toBeUndefined();
  });

  it("does not fall back on unrelated 400 validation errors", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(
      Object.assign(new Error("messages: content is required"), { status: 400 }),
    );

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("retries without reasoning when the configured effort is invalid", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "extreme",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        Object.assign(new Error("reasoning effort must be one of low, medium, high"), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      reasoning: { effort: "extreme", exclude: true },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
    expect(client.getReasoningFallbackReason()).toBe("invalid-value");
  });

  it("retries without reasoning when a value rejection repeats the configured value", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "extreme",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        reasoningRejection(400, "reasoning effort 'extreme' is not supported by this model"),
      )
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
    expect(client.getReasoningFallbackReason()).toBe("invalid-value");
  });

  it("falls back when the provider rejects the exclude sub-key", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection(400, "Unsupported parameter: exclude"))
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("propagates the error when the fallback retry also rejects", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(reasoningRejection());

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("keeps reasoning off for the outer retry after a failed fallback", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      2,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection())
      .mockRejectedValueOnce(Object.assign(new Error("backend unavailable"), { status: 500 }))
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[0][0]).toMatchObject({
      reasoning: { effort: "high", exclude: true },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(create.mock.calls[2][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("does not fall back on server errors", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(Object.assign(new Error("reasoning backend failed"), { status: 500 }));

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("does not fall back when no effort was configured", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(reasoningRejection());

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "Failed to get response from LLM",
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("falls back for a rejected reasoning parameter on the streaming router path", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "openrouter/free",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection(422, "reasoning_effort is not supported"))
      .mockResolvedValueOnce(
        streamOf([
          { model: "vendor/model", choices: [{ delta: { content: "streamed review" } }] },
        ]),
      );

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("streamed review");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      reasoning: { effort: "high", exclude: true },
    });
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("logs the provider message for plain-object rejections", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "model",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce({
        status: 400,
        message: "Unsupported parameter: reasoning is not supported",
      })
      .mockResolvedValueOnce(completionResponse("review text"));

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("review text");
    const warnings = fallbackWarnings();
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain("Unsupported parameter: reasoning is not supported");
    expect(String(warnings[0][0])).not.toContain("[object Object]");
  });

  it("falls back when reasoning controls are explicitly rejected on the streaming path", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "openrouter/free",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(
        Object.assign(new Error("reasoning controls rejected by the selected provider"), {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(
        streamOf([
          { model: "vendor/model", choices: [{ delta: { content: "streamed review" } }] },
        ]),
      );

    const result = await client.chatCompletion("system", "user");

    expect(result.content).toBe("streamed review");
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });

  it("surfaces a persistent validation error that mentions reasoning context on the streaming path", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "openrouter/free",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create.mockRejectedValue(
      Object.assign(new Error("temperature must be 1 for reasoning models"), { status: 400 }),
    );

    // Temperature is dropped once; when the provider still rejects, the real error surfaces
    // instead of being mistaken for a router stall.
    await expect(client.chatCompletion("system", "user")).rejects.toThrow(
      "temperature must be 1 for reasoning models",
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0]).not.toHaveProperty("temperature");
    expect(fallbackWarnings()).toHaveLength(0);
  });

  it("keeps the stall retry path after a fallback when a reasoning-flavored 400 arrives", async () => {
    const client = new LLMClient(
      "https://example.test/v1",
      "test-key",
      "openrouter/free",
      undefined,
      undefined,
      1,
      undefined,
      undefined,
      "high",
    );
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(reasoningRejection(422, "reasoning_effort is not supported"))
      .mockResolvedValueOnce(
        streamOf([
          { model: "vendor/model", choices: [{ delta: { content: "first review" } }] },
        ]),
      )
      .mockRejectedValueOnce(reasoningRejection());

    await client.chatCompletion("system", "user");
    await expect(client.chatCompletion("system", "user")).rejects.toThrow("OpenRouter stall");

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[2][0]).not.toHaveProperty("reasoning");
    expect(fallbackWarnings()).toHaveLength(1);
  });
});

describe("LLMClient tool calling", () => {
  const tools = [
    {
      type: "function" as const,
      function: { name: "read_file", parameters: { type: "object", properties: {} } },
    },
  ];
  const messages = [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "user" },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("sends tools and tool_choice without response_format", async () => {
    const client = makeClient("https://api.openai.com/v1", "gpt-4o");
    const create = stubOpenAI(client);
    create.mockResolvedValueOnce(completionResponse("done"));

    await client.chatWithTools(messages, tools, { toolChoice: "none" });

    const request = create.mock.calls[0][0];
    expect(request.tools).toEqual(tools);
    expect(request.tool_choice).toBe("none");
    expect(request).not.toHaveProperty("response_format");
    expect(request.messages).toEqual(messages);
  });

  it("returns tool calls from a blocking response with empty content", async () => {
    const client = makeClient("https://api.openai.com/v1", "gpt-4o");
    const create = stubOpenAI(client);
    create.mockResolvedValueOnce({
      model: "gpt-4o",
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const result = await client.chatWithTools(messages, tools);

    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }]);
    expect(warningMock).not.toHaveBeenCalledWith(expect.stringContaining("no text content"));
  });

  it("assembles streamed tool-call deltas for router models", async () => {
    const client = makeClient("https://openrouter.ai/api/v1", "openrouter/free");
    const create = stubOpenAI(client);
    create.mockResolvedValueOnce(
      streamOf([
        {
          model: "vendor/model",
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "grep", arguments: '{"pat' } }] } }],
        },
        {
          model: "vendor/model",
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] } }],
        },
        {
          model: "vendor/model",
          choices: [{ delta: { tool_calls: [{ index: 1, function: { name: "list_files", arguments: "{}" } }] } }],
        },
      ]),
    );

    const result = await client.chatWithTools(messages, tools);

    expect(result.toolCalls).toEqual([
      { id: "call_a", name: "grep", arguments: '{"pattern":"x"}' },
      { id: "call_1", name: "list_files", arguments: "{}" },
    ]);
  });

  it("throws ToolsUnsupportedError without retrying when a router has no tool-capable endpoint", async () => {
    const client = new LLMClient("https://openrouter.ai/api/v1", "k", "openrouter/free");
    const create = stubOpenAI(client);
    create.mockRejectedValue(
      Object.assign(new Error("404 No endpoints found that support tool use. Try disabling \"read_file\"."), {
        status: 404,
      }),
    );

    await expect(client.chatWithTools(messages, tools)).rejects.toBeInstanceOf(ToolsUnsupportedError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps normal router 404 retries for plain completions", async () => {
    const client = makeClient("https://openrouter.ai/api/v1", "openrouter/free");
    const create = stubOpenAI(client);
    create.mockRejectedValue(
      Object.assign(new Error("404 No endpoints found that support tool use."), { status: 404 }),
    );

    await expect(client.chatCompletion("system", "user")).rejects.not.toBeInstanceOf(ToolsUnsupportedError);
  });
});

describe("LLMClient context-length errors on router streams", () => {
  it("surfaces a context-length rejection instead of treating it as a router stall", async () => {
    const client = makeClient("https://openrouter.ai/api/v1", "openrouter/free");
    const create = stubOpenAI(client);
    create.mockRejectedValue(
      Object.assign(new Error("400 This endpoint's maximum context length is 131072 tokens."), { status: 400 }),
    );

    await expect(client.chatCompletion("system", "user")).rejects.toThrow(/maximum context length/);
  });
});

describe("REVIEW_JSON_SCHEMA", () => {
  const { REVIEW_JSON_SCHEMA } = jest.requireActual("./prompts/review-schema");

  const objects = (schema: any): any[] =>
    schema && typeof schema === "object"
      ? [
          ...(schema.type === "object" ? [schema] : []),
          ...Object.values(schema).flatMap((value) => (Array.isArray(value) ? value.flatMap(objects) : objects(value))),
        ]
      : [];

  it("satisfies OpenAI and Anthropic strict mode: closed objects with every property required", () => {
    const all = objects(REVIEW_JSON_SCHEMA);
    expect(all.length).toBeGreaterThan(1);
    for (const object of all) {
      expect(object.additionalProperties).toBe(false);
      expect([...object.required].sort()).toEqual(Object.keys(object.properties).sort());
    }
  });
});
