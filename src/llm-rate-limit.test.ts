jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as core from "@actions/core";
import { LLMClient } from "./llm-client";

const infoMock = core.info as unknown as jest.Mock;

interface StubbedOpenAI {
  chat: { completions: { create: jest.Mock } };
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

function providerError(status: number, message: string, headers?: Record<string, string>) {
  return Object.assign(new Error(message), {
    status,
    ...(headers ? { headers: new Headers(headers) } : {}),
  });
}

function makeClient(maxAttempts?: number) {
  return new LLMClient(
    "https://provider.invalid/v1",
    "test-key",
    "test-model",
    undefined,
    undefined,
    maxAttempts
  );
}

/** The announced retry waits, with the attempt labels the client logged. */
function retryWaits(): Array<{ waitMs: number; attempt: number; limit: number }> {
  const pattern = /^Retrying LLM request in (\d+) ms \(attempt (\d+)\/(\d+)\)\.\.\.$/;
  return infoMock.mock.calls
    .map(([message]) => pattern.exec(String(message)))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      waitMs: Number(match[1]),
      attempt: Number(match[2]),
      limit: Number(match[3]),
    }));
}

function rateLimited(message = "429 inference_failed", headers?: Record<string, string>) {
  return providerError(429, message, headers);
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

/** A streamed success: the first chunk proves the router routed, then the final text. */
function streamedResponse(content: string) {
  return streamOf([
    { model: "resolved-router-model", choices: [{ delta: { content }, finish_reason: "stop" }] },
  ]);
}

function makeRouterClient(maxAttempts?: number) {
  return new LLMClient(
    "https://provider.invalid/v1",
    "test-key",
    "openrouter/free",
    undefined,
    undefined,
    maxAttempts
  );
}

describe("LLMClient rate-limit retries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("R1 recovers from four 429s on the fifth attempt", async () => {
    jest.useFakeTimers();
    const client = makeClient(3);
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(completionResponse("review text"));

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).resolves.toMatchObject({ content: "review text" }),
      jest.runAllTimersAsync(),
    ]);

    expect(create).toHaveBeenCalledTimes(5);
    expect(retryWaits()).toEqual([
      { waitMs: 5000, attempt: 2, limit: 6 },
      { waitMs: 10000, attempt: 3, limit: 6 },
      { waitMs: 20000, attempt: 4, limit: 6 },
      { waitMs: 40000, attempt: 5, limit: 6 },
    ]);
    expect(String(jest.mocked(core.error).mock.calls)).not.toContain("LLM API error");
  });

  it("R2 fails after six 429s with the existing error shape", async () => {
    jest.useFakeTimers();
    const client = makeClient(3);
    const create = stubOpenAI(client);
    create.mockRejectedValue(rateLimited());

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).rejects.toThrow(
        "Failed to get response from LLM: Provider rate limit exceeded (HTTP 429)"
      ),
      jest.runAllTimersAsync(),
    ]);

    expect(create).toHaveBeenCalledTimes(6);
    expect(retryWaits().map((retry) => retry.waitMs)).toEqual([5000, 10000, 20000, 40000, 60000]);
    expect(jest.mocked(core.error)).toHaveBeenCalledWith(
      "LLM API error: Provider rate limit exceeded (HTTP 429)"
    );
  });

  it("R3 honors a provider Retry-After hint", async () => {
    jest.useFakeTimers();
    const client = makeClient(3);
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(rateLimited("429 inference_failed", { "retry-after": "7" }))
      .mockRejectedValueOnce(rateLimited("429 inference_failed", { "retry-after": "600" }))
      .mockResolvedValueOnce(completionResponse("review text"));

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).resolves.toMatchObject({ content: "review text" }),
      jest.runAllTimersAsync(),
    ]);

    expect(retryWaits().map((retry) => retry.waitMs)).toEqual([7000, 60000]);
  });

  it("R4 keeps three attempts and 2/4 s delays for non-429 server errors", async () => {
    jest.useFakeTimers();
    const client = makeClient(3);
    const create = stubOpenAI(client);
    create.mockRejectedValue(providerError(500, "server error"));

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).rejects.toThrow(
        "Failed to get response from LLM: Provider server error (HTTP 500)"
      ),
      jest.runAllTimersAsync(),
    ]);

    expect(create).toHaveBeenCalledTimes(3);
    expect(retryWaits()).toEqual([
      { waitMs: 2000, attempt: 2, limit: 3 },
      { waitMs: 4000, attempt: 3, limit: 3 },
    ]);
  });

  it("R5 keeps SDK-internal retries disabled so attempts are not multiplied", () => {
    const client = makeClient(3);
    expect((client as unknown as { client: { maxRetries: number } }).client.maxRetries).toBe(0);
  });

  it("R6 keeps an explicit attempt count below the rate-limit default", async () => {
    jest.useFakeTimers();
    const client = makeClient(2);
    const create = stubOpenAI(client);
    create.mockRejectedValue(rateLimited());

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).rejects.toThrow(
        "Failed to get response from LLM: Provider rate limit exceeded (HTTP 429)"
      ),
      jest.runAllTimersAsync(),
    ]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(retryWaits()).toEqual([{ waitMs: 5000, attempt: 2, limit: 2 }]);
  });

  it("R7 never shortens a scheduled wait for a smaller Retry-After hint", async () => {
    jest.useFakeTimers();
    const client = makeClient(3);
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(rateLimited("429 inference_failed", { "retry-after": "1" }))
      .mockRejectedValueOnce(rateLimited("429 inference_failed", { "retry-after": "0" }))
      .mockResolvedValueOnce(completionResponse("review text"));

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).resolves.toMatchObject({ content: "review text" }),
      jest.runAllTimersAsync(),
    ]);

    expect(retryWaits().map((retry) => retry.waitMs)).toEqual([5000, 10000]);
  });

  it("R8 applies the rate-limit schedule and hint to a router streaming 429", async () => {
    jest.useFakeTimers();
    const client = makeRouterClient(3);
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(rateLimited("429 inference_failed", { "retry-after": "7" }))
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(streamedResponse("review text"));

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).resolves.toMatchObject({ content: "review text" }),
      jest.runAllTimersAsync(),
    ]);

    expect(create).toHaveBeenCalledTimes(3);
    expect(retryWaits()).toEqual([
      { waitMs: 7000, attempt: 2, limit: 6 },
      { waitMs: 10000, attempt: 3, limit: 6 },
    ]);
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining("OpenRouter stall: no first response")
    );
  });

  it("R9 stops a 429-then-500 sequence at the ordinary attempt cap", async () => {
    jest.useFakeTimers();
    const client = makeClient(3);
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(providerError(500, "server error"))
      .mockRejectedValueOnce(providerError(500, "server error"));

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).rejects.toThrow(
        "Failed to get response from LLM: Provider server error (HTTP 500)"
      ),
      jest.runAllTimersAsync(),
    ]);

    expect(create).toHaveBeenCalledTimes(3);
    expect(retryWaits()).toEqual([
      { waitMs: 5000, attempt: 2, limit: 6 },
      { waitMs: 4000, attempt: 3, limit: 3 },
    ]);
  });

  it("R10 stops a 429-then-empty sequence at the ordinary attempt cap", async () => {
    jest.useFakeTimers();
    const client = makeClient(3);
    const create = stubOpenAI(client);
    create
      .mockRejectedValueOnce(rateLimited())
      .mockResolvedValueOnce(completionResponse(""))
      .mockResolvedValueOnce(completionResponse(""));

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).rejects.toThrow(
        "Empty response from LLM after 3 attempts (finish_reason=stop)"
      ),
      jest.runAllTimersAsync(),
    ]);

    expect(create).toHaveBeenCalledTimes(3);
    expect(retryWaits()).toEqual([
      { waitMs: 5000, attempt: 2, limit: 6 },
      { waitMs: 4000, attempt: 3, limit: 3 },
    ]);
  });
});
