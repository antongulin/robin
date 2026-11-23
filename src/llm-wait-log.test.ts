jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as core from "@actions/core";
import { APIConnectionError, APIConnectionTimeoutError } from "openai";
import { LLMClient, LLMRequestError } from "./llm-client";
import { LlmRequestCancelledError, openRouterStallError, requestTimeoutPhase } from "./llm-retry";

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

function makeClient(
  onProgress?: (detail: string) => Promise<void>,
  maxAttempts?: number,
  baseUrl = "https://provider.invalid/v1"
) {
  return new LLMClient(
    baseUrl,
    "test-key",
    "test-model",
    undefined,
    undefined,
    maxAttempts,
    undefined,
    onProgress
  );
}

const infoMessages = (): string[] =>
  jest.mocked(core.info).mock.calls.map(([message]) => String(message));

/** Info lines after the one-time client initialization banner. */
const runtimeInfoMessages = (): string[] =>
  infoMessages().filter((message) => !message.startsWith("Initializing LLM client"));

const warningMessages = (): string[] =>
  jest.mocked(core.warning).mock.calls.map(([message]) => String(message));

/** Only the periodic visibility lines, so other info output cannot mask them. */
const waitLines = (): string[] => infoMessages().filter((message) => message.includes("still waiting for provider"));

function loggedText(): string {
  return [
    ...jest.mocked(core.info).mock.calls,
    ...jest.mocked(core.warning).mock.calls,
    ...jest.mocked(core.error).mock.calls,
  ]
    .flat()
    .map((argument) => String(argument))
    .join(" ");
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

it("W1 repeats a wait line every 60 s while one attempt is in flight and stops on success", async () => {
  jest.useFakeTimers();
  const progress = jest.fn().mockResolvedValue(undefined);
  const client = makeClient(progress);
  const create = stubOpenAI(client);
  let resolveCreate: (value: unknown) => void = () => undefined;
  create.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
  );

  const completion = client.chatCompletion("system", "user");
  await jest.advanceTimersByTimeAsync(150_000);

  expect(waitLines()).toEqual([
    "LLM attempt 1/3: still waiting for provider (60 s elapsed)",
    "LLM attempt 1/3: still waiting for provider (120 s elapsed)",
  ]);

  resolveCreate(completionResponse("review text"));
  const result = await completion;

  expect(result).toMatchObject({ content: "review text", finishReason: "stop" });
  jest.advanceTimersByTime(300_000);
  expect(waitLines()).toHaveLength(2);
  expect(progress.mock.calls.map(([detail]) => detail)).toEqual(["Waiting for provider (attempt 1/3)…"]);
});

it("W2 keeps every log line identical when the provider answers immediately", async () => {
  const progress = jest.fn().mockResolvedValue(undefined);
  const client = makeClient(progress);
  const create = stubOpenAI(client);
  create.mockResolvedValue(completionResponse("review text"));

  const result = await client.chatCompletion("system", "user");

  expect(result).toMatchObject({ content: "review text", finishReason: "stop" });
  expect(create).toHaveBeenCalledTimes(1);
  expect(runtimeInfoMessages()).toEqual([
    "LLM attempt 1/3: waiting for provider...",
    "LLM resolved model: resolved-model (requested: test-model)",
  ]);
  expect(warningMessages()).toEqual([]);
  expect(progress.mock.calls.map(([detail]) => detail)).toEqual(["Waiting for provider (attempt 1/3)…"]);
});

it("W3 names a pre-response timeout before the unchanged failure lines and still retries", async () => {
  jest.useFakeTimers();
  const client = makeClient();
  const create = stubOpenAI(client);
  create
    .mockImplementationOnce(async () => {
      jest.setSystemTime(Date.now() + 600_000);
      throw new APIConnectionTimeoutError();
    })
    .mockResolvedValueOnce(completionResponse("review text"));

  const completion = client.chatCompletion("system", "user");
  await Promise.all([
    expect(completion).resolves.toMatchObject({ content: "review text" }),
    jest.runAllTimersAsync(),
  ]);

  expect(warningMessages()).toEqual([
    "LLM attempt 1/3 timed out after 600 s with no response from the provider.",
    "LLM attempt 1/3 failed: Provider request failed",
  ]);
  expect(infoMessages()).toContain("Retrying LLM request in 2000 ms (attempt 2/3)...");
  expect(create).toHaveBeenCalledTimes(2);
});

it("W3 keeps today's failure message when every attempt times out", async () => {
  jest.useFakeTimers();
  const client = makeClient();
  const create = stubOpenAI(client);
  create.mockImplementation(async () => {
    jest.setSystemTime(Date.now() + 600_000);
    throw new APIConnectionTimeoutError();
  });

  const completion = client.chatCompletion("system", "user");
  await Promise.all([
    expect(completion).rejects.toMatchObject({
      name: "LLMRequestError",
      message: "Failed to get response from LLM: Provider request failed",
    }),
    expect(completion).rejects.toBeInstanceOf(LLMRequestError),
    jest.runAllTimersAsync(),
  ]);

  expect(create).toHaveBeenCalledTimes(3);
  expect(warningMessages()).toEqual([
    "LLM attempt 1/3 timed out after 600 s with no response from the provider.",
    "LLM attempt 1/3 failed: Provider request failed",
    "LLM attempt 2/3 timed out after 600 s with no response from the provider.",
    "LLM attempt 2/3 failed: Provider request failed",
    "LLM attempt 3/3 timed out after 600 s with no response from the provider.",
    "LLM attempt 3/3 failed: Provider request failed",
  ]);
});

describe("W4 keeps non-timeout failures exactly as today", () => {
  const rateLimitWarnings = [
    "LLM attempt 1/3 failed: Provider rate limit exceeded (HTTP 429)",
    "LLM attempt 2/6 failed: Provider rate limit exceeded (HTTP 429)",
    "LLM attempt 3/6 failed: Provider rate limit exceeded (HTTP 429)",
    "LLM attempt 4/6 failed: Provider rate limit exceeded (HTTP 429)",
    "LLM attempt 5/6 failed: Provider rate limit exceeded (HTTP 429)",
    "LLM attempt 6/6 failed: Provider rate limit exceeded (HTTP 429)",
  ];
  const serverErrorWarnings = (status: number) => [
    `LLM attempt 1/3 failed: Provider server error (HTTP ${status})`,
    `LLM attempt 2/3 failed: Provider server error (HTTP ${status})`,
    `LLM attempt 3/3 failed: Provider server error (HTTP ${status})`,
  ];

  it.each([
    {
      name: "HTTP 500",
      error: () => Object.assign(new Error("server error"), { status: 500 }),
      warnings: serverErrorWarnings(500),
      message: "Failed to get response from LLM: Provider server error (HTTP 500)",
      attempts: 3,
    },
    {
      name: "HTTP 429",
      error: () => Object.assign(new Error("rate limited"), { status: 429 }),
      warnings: rateLimitWarnings,
      message: "Failed to get response from LLM: Provider rate limit exceeded (HTTP 429)",
      attempts: 6,
    },
    {
      name: "HTTP 400",
      error: () => Object.assign(new Error("bad request"), { status: 400 }),
      warnings: ["LLM attempt 1/3 failed: Provider rejected request parameters (HTTP 400)"],
      message: "Failed to get response from LLM: Provider rejected request parameters (HTTP 400)",
      attempts: 1,
    },
    {
      name: "SDK connection reset",
      error: () => new APIConnectionError({}),
      warnings: ["LLM attempt 1/3 failed: Provider request failed"],
      message: "Failed to get response from LLM: Provider request failed",
      attempts: 1,
    },
    {
      name: "OpenRouter stall",
      error: () => openRouterStallError(45_000),
      warnings: [
        "LLM attempt 1/3 failed: OpenRouter stall: no first response",
        "LLM attempt 2/3 failed: OpenRouter stall: no first response",
        "LLM attempt 3/3 failed: OpenRouter stall: no first response",
      ],
      message: "Failed to get response from LLM: OpenRouter stall: no first response",
      attempts: 3,
    },
    {
      name: "message text with an HTTP status",
      error: () => Object.assign(new Error("upstream timed out"), { status: 504 }),
      warnings: serverErrorWarnings(504),
      message: "Failed to get response from LLM: Provider server error (HTTP 504)",
      attempts: 3,
    },
  ])("W4 logs no timeout line for $name", async ({ error, warnings, message, attempts }) => {
    jest.useFakeTimers();
    const client = makeClient();
    const create = stubOpenAI(client);
    create.mockImplementation(async () => {
      throw error();
    });

    const completion = client.chatCompletion("system", "user");
    await Promise.all([
      expect(completion).rejects.toMatchObject({ name: "LLMRequestError", message }),
      jest.runAllTimersAsync(),
    ]);

    expect(create).toHaveBeenCalledTimes(attempts);
    expect(warningMessages()).toEqual(warnings);
    expect(loggedText()).not.toContain("timed out after");
  });

  it("W4 classifies an SDK pre-response timeout and a stalled body, and refuses HTTP errors", () => {
    const socketTimeout = () =>
      Object.assign(
        new Error(
          "Invalid response body while trying to fetch https://provider.invalid/v1/chat/completions: Socket timeout"
        ),
        { name: "FetchError", code: "ERR_SOCKET_TIMEOUT", type: "system" }
      );

    expect(requestTimeoutPhase(new APIConnectionTimeoutError())).toBe("before-response");
    expect(requestTimeoutPhase(new Error("Request timed out."))).toBe("before-response");
    expect(requestTimeoutPhase(socketTimeout())).toBe("during-response");
    expect(requestTimeoutPhase(Object.assign(new Error("Request timed out."), { status: 504 }))).toBeUndefined();
    expect(requestTimeoutPhase(new Error("plain connection error"))).toBeUndefined();
    expect(requestTimeoutPhase(openRouterStallError(45_000))).toBeUndefined();
    expect(requestTimeoutPhase(new LlmRequestCancelledError())).toBeUndefined();
  });

  it("W4 walks a wrapped cause for both timeout shapes", () => {
    const before = new LLMRequestError("Failed to get response from LLM: Provider request failed", {
      cause: new APIConnectionTimeoutError(),
    });
    const during = new LLMRequestError("Failed to get response from LLM: Provider request failed", {
      cause: Object.assign(new Error("Invalid response body: Socket timeout"), { code: "ERR_SOCKET_TIMEOUT" }),
    });

    expect(requestTimeoutPhase(before)).toBe("before-response");
    expect(requestTimeoutPhase(during)).toBe("during-response");
  });

  it("W4 stays cycle-safe on a self-referencing cause chain", () => {
    const loop: Error & { cause?: unknown } = new Error("wrapper");
    loop.cause = loop;
    expect(requestTimeoutPhase(loop)).toBeUndefined();

    const outer: Error & { cause?: unknown } = new Error("wrapper");
    const timeout = new APIConnectionTimeoutError();
    (timeout as Error & { cause?: unknown }).cause = outer;
    outer.cause = timeout;
    expect(requestTimeoutPhase(outer)).toBe("before-response");
  });
});

/** Local cancellation stand-in: same name check as the client's AbortError handling. */
it("W5 stops the wait lines and the timeout line when the caller aborts mid-wait", async () => {
  jest.useFakeTimers();
  const controller = new AbortController();
  const client = makeClient();
  const create = stubOpenAI(client);
  create.mockImplementation((_request: unknown, options?: { signal?: AbortSignal }) => {
    const signal = options?.signal;
    return new Promise((_resolve, reject) => {
      if (!signal) throw new Error("expected the SDK request signal");
      signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))
      );
    });
  });

  const completion = client.chatCompletion("system", "user", false, undefined, {
    signal: controller.signal,
  });
  const assertion = expect(completion).rejects.toMatchObject({ name: "LlmRequestCancelledError" });

  await jest.advanceTimersByTimeAsync(90_000);
  expect(waitLines()).toEqual([
    "LLM attempt 1/3: still waiting for provider (60 s elapsed)",
  ]);

  controller.abort();
  await assertion;
  const linesAtAbort = waitLines().length;

  jest.advanceTimersByTime(300_000);
  expect(waitLines()).toHaveLength(linesAtAbort);
  expect(warningMessages().filter((message) => message.includes("timed out after"))).toEqual([]);
  expect(create).toHaveBeenCalledTimes(1);
});

it("W7 names a response that started and then stalled without leaking provider text", async () => {
  jest.useFakeTimers();
  const client = makeClient(undefined, undefined, "https://llm-gateway.test/v1");
  const create = stubOpenAI(client);
  create.mockRejectedValue(
    Object.assign(
      new Error(
        "Invalid response body while trying to fetch https://provider.invalid/v1/chat/completions: Socket timeout"
      ),
      { name: "FetchError", code: "ERR_SOCKET_TIMEOUT", type: "system" }
    )
  );

  const completion = client.chatCompletion("system", "user");
  await Promise.all([
    expect(completion).rejects.toMatchObject({
      name: "LLMRequestError",
      message: "Failed to get response from LLM: Provider request failed",
    }),
    jest.runAllTimersAsync(),
  ]);

  const timeoutWarnings = warningMessages().filter((message) => message.includes("timed out after"));
  expect(timeoutWarnings).toHaveLength(3);
  for (const message of timeoutWarnings) {
    expect(message).toMatch(
      /^LLM attempt \d+\/3 timed out after \d+ s: the provider started a response, then stopped sending data\.$/
    );
  }
  expect(warningMessages()).toEqual([
    expect.stringMatching(/timed out after \d+ s: the provider started a response/),
    "LLM attempt 1/3 failed: Provider request failed",
    expect.stringMatching(/timed out after \d+ s: the provider started a response/),
    "LLM attempt 2/3 failed: Provider request failed",
    expect.stringMatching(/timed out after \d+ s: the provider started a response/),
    "LLM attempt 3/3 failed: Provider request failed",
  ]);
  expect(create).toHaveBeenCalledTimes(3);
  expect(loggedText()).not.toContain("provider.invalid");
  expect(loggedText()).not.toContain("Socket timeout");
});
