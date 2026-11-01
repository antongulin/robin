jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import { Response } from "node-fetch";
import { runAgentReview } from "./agent-review";
import { LLMClient } from "./llm-client";
import { AgentDeadlineError } from "./llm-retry";
import { serializedJsonBytes } from "./request-budget";
import { UsageLedger } from "./usage-report";

/**
 * Agent recovery through the installed SDK's real serialization and error decoding.
 * Only `fetch` is replaced, so the wrapper/cause shape the agent sees is the production one.
 */

const FINAL = '{"summary":"ok","high":[],"medium":[],"low":[],"suggestions":[]}';
const NOTES = "NOTES: src/a.ts line 3 drops the token check.";
const tool = (id: string) => ({
  id, type: "function", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
});
const toolbox = () => ({
  describe: jest.fn(() => "Reading src/a.ts"),
  execute: jest.fn(async () => "SMALL_TOOL_RESULT"),
});

type WireMessage = Record<string, unknown>;
type WireRequest = Record<string, unknown> & { messages: WireMessage[] };
type FetchInit = { body?: unknown; signal?: AbortSignal };

function completion(message: WireMessage) {
  return new Response(JSON.stringify({
    id: "offline", object: "chat.completion", created: 0, model: "resolved-model",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [{
      index: 0,
      finish_reason: message.tool_calls ? "tool_calls" : "stop",
      message: { role: "assistant", ...message },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

/** A real HTTP-shaped rejection with no context wording at all. */
function generic413() {
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Request rejected" } }), {
    status: 413, headers: { "content-type": "application/json" },
  });
}

function badTemperature() {
  return new Response(JSON.stringify({
    error: { type: "invalid_request_error", message: "temperature must be 1 for reasoning models" },
  }), { status: 400, headers: { "content-type": "application/json" } });
}

function offlineAgent(
  handler: (body: WireRequest, index: number, init?: FetchInit) => Response | Promise<Response>,
  options: { model?: string; maxOutputTokens?: number; budget?: number } = {}
) {
  const ledger = new UsageLedger();
  const client = new LLMClient(
    "https://offline.invalid/v1", "offline-not-a-key", options.model ?? "test-model",
    options.maxOutputTokens ?? 1234, 60_000, 1, 0.1,
    undefined, undefined, ledger, options.budget
  );
  const sdk = (client as unknown as {
    client: { fetch: (url: unknown, init?: FetchInit) => Promise<Response> };
  }).client;
  const requests: WireRequest[] = [];
  sdk.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as WireRequest;
    requests.push(body);
    return handler(body, requests.length - 1, init);
  };
  return { client, requests, ledger };
}

test("A5-1 a generic HTTP 413 after a tool exchange triggers bounded compaction", async () => {
  const { client, requests, ledger } = offlineAgent((body, index) => {
    if (index === 0) return completion({ content: null, tool_calls: [tool("c0")] });
    if (index === 1) return generic413();
    if (!body.tools) return completion({ content: NOTES });
    return completion({ content: FINAL });
  });
  const tools = toolbox();
  tools.execute.mockResolvedValue("SMALL_TOOL_RESULT_" + "x".repeat(2_000));
  const result = await runAgentReview({
    llm: client, toolbox: tools, annotatedDiff: "diff", changedFiles: ["src/a.ts"], instructions: "",
  });

  expect(result).toEqual({ content: FINAL, turns: 2, toolCalls: 1, compactions: 1 });
  expect(requests).toHaveLength(4);
  expect(requests[1].tools).toBeDefined();
  expect(requests[1].messages).toContainEqual(expect.objectContaining({
    role: "tool", content: expect.stringContaining("SMALL_TOOL_RESULT"),
  }));
  // The recovery is a summary request, not a diff-only fallback: the agent keeps its tools.
  expect(requests[2].tools).toBeUndefined();
  expect(String((requests[2].messages[0] as WireMessage).content)).toContain("compress the working notes");
  expect(requests[3].tools).toBeDefined();
  expect(JSON.stringify(requests[3].messages)).toContain(NOTES);
  expect(tools.execute).toHaveBeenCalledTimes(1);
  expect(ledger.report().full.ledger.map((attempt) => [attempt.phase, attempt.outcome])).toEqual([
    ["agent", "accepted"], ["agent", "error"], ["compaction", "accepted"], ["agent", "accepted"],
  ]);
});

test("A3-1 keeps the complete summary transcript inside the provider cap while shrinking the agent body", async () => {
  // Fixture adjustment from the accepted plan: 320k pretty-JSON bytes, not 260k. With a
  // 300k assistant message the summary transcript itself is ~302k, so a 260k cap could only
  // be met by clipping evidence, which the accepted contract forbids.
  const CAP = 320_000;
  const assistantContent = "VISIBLE_INVESTIGATION " + "v".repeat(300_000);
  const privateContent = "PRIVATE_RECOVERY_SENTINEL" + "p".repeat(60_000);
  const diff = "d".repeat(40_000);
  const newestResult = "NEWEST_TOOL_EVIDENCE " + "s".repeat(1_000);
  let acceptedAgentTurns = 0;
  const { client, requests } = offlineAgent((body) => {
    const bytes = serializedJsonBytes(body);
    if (bytes > CAP) return generic413();
    if (body.tools) {
      // Two complete exchanges BEFORE rejection: the newest group has large assistant
      // content/private replay but tiny tool output, which previously kept it unchanged.
      acceptedAgentTurns++;
      if (acceptedAgentTurns === 1) return completion({ content: "FIRST_LOOK", tool_calls: [tool("c0")] });
      if (acceptedAgentTurns === 2) return completion({ content: assistantContent, reasoning_content: privateContent, tool_calls: [tool("c1")] });
      return completion({ content: FINAL });
    }
    return completion({ content: NOTES });
  });
  const tools = toolbox();
  tools.execute.mockResolvedValueOnce("TOOL_RESULT " + "r".repeat(1_000))
    .mockResolvedValueOnce(newestResult);

  const result = await runAgentReview({
    llm: client,
    toolbox: tools,
    annotatedDiff: diff,
    changedFiles: ["src/a.ts"],
    instructions: "",
  });

  expect(result).toEqual({ content: FINAL, turns: 3, toolCalls: 2, compactions: 1 });
  expect(requests).toHaveLength(5);
  const summaryRequests = requests.filter((request) => !request.tools);
  expect(summaryRequests).toHaveLength(1);
  expect(serializedJsonBytes(requests[2])).toBeGreaterThan(CAP);
  expect(requests[2].messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  for (const request of requests.filter((_, index) => index !== 2)) {
    expect(serializedJsonBytes(request)).toBeLessThanOrEqual(CAP);
  }
  expect(String(summaryRequests[0].messages[1].content)).toContain(assistantContent);
  expect(String(summaryRequests[0].messages[1].content)).toContain(newestResult);
  expect(JSON.stringify(summaryRequests[0])).not.toContain("PRIVATE_RECOVERY_SENTINEL");
  expect(JSON.stringify(requests[4].messages)).toContain(NOTES);
  expect(requests[4].messages.slice(2)).toEqual([]);
  expect(serializedJsonBytes(requests[4]) * 2).toBeLessThan(serializedJsonBytes(requests[2]));
  for (const request of requests.filter((request) => request.tools)) {
    expect(String(request.messages[1].content)).toContain(diff);
  }
  expect(tools.execute).toHaveBeenCalledTimes(2);
});

test("A4-2 explicit 64000 output cap survives summary, forced final and compatibility rebuilds", async () => {
  const { client, requests } = offlineAgent((body, index) => {
    if (index === 0) return badTemperature();
    if (index === 1) return completion({ content: null, tool_calls: [tool("c0")] });
    if (index === 2) return generic413();
    if (!body.tools) return completion({ content: NOTES });
    return completion({ content: FINAL });
  }, { maxOutputTokens: 64_000, budget: undefined });
  const tools = toolbox();
  tools.execute.mockResolvedValue("TOOL_RESULT " + "x".repeat(2_000));

  const result = await runAgentReview({
    llm: client,
    toolbox: tools,
    annotatedDiff: "diff",
    changedFiles: ["src/a.ts"],
    instructions: "",
    budgets: { maxTurns: 1 },
  });

  expect(result).toEqual({ content: FINAL, turns: 2, toolCalls: 1, compactions: 1 });
  expect(requests.length).toBeGreaterThanOrEqual(5);
  for (const body of requests) {
    expect(body.max_tokens).toBe(64_000);
    expect(body).not.toHaveProperty("max_completion_tokens");
  }
  // The first rejection dropped temperature and the rebuilt request kept the explicit cap.
  expect(requests[1]).not.toHaveProperty("temperature");
  expect(requests.at(-1)?.tool_choice).toBe("none");
});

test.each([
  { transport: "blocking", model: "test-model" },
  { transport: "streaming", model: "openrouter/free" },
])("A6-4 aborts a $transport transport at the agent deadline instead of waiting forever", async ({ model }) => {
  jest.useFakeTimers({ now: 0 });
  try {
    let aborts = 0;
    let markStarted!: () => void;
    const transportStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const { client, requests } = offlineAgent((_body, _index, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);
      signal?.addEventListener("abort", () => {
        aborts++;
        reject(new Error("synthetic abort"));
      }, { once: true });
      markStarted();
    }), { model });

    const pending = expect(runAgentReview({
      llm: client,
      toolbox: toolbox(),
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { deadlineMs: 300 },
    })).rejects.toBeInstanceOf(AgentDeadlineError);

    // Start the real SDK transport before advancing time, regardless of host scheduling.
    await transportStarted;
    expect(requests).toHaveLength(1);
    expect(aborts).toBe(0);
    await jest.advanceTimersByTimeAsync(300);
    await pending;
    // Both investigation and forced-final requests receive an actual abort signal.
    expect(aborts).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests[1].tool_choice).toBe("none");
  } finally {
    jest.useRealTimers();
  }
});
