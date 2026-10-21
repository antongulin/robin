jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as core from "@actions/core";
import { Response } from "node-fetch";
import { Readable } from "node:stream";
import { runAgentReview } from "./agent-review";
import { LLMClient } from "./llm-client";
import { DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS } from "./config";

const FINAL = '{"summary":"ok","high":[],"medium":[],"low":[],"suggestions":[]}';
const PRIVATE = "PRIVATE_REPLAY_SENTINEL \n Ω 🐦  ";
const tool = (id: string) => ({
  id, type: "function", function: { name: "read_file", arguments: '{ "path": "src/a.ts" }' },
});
const toolbox = () => ({
  describe: jest.fn(() => "Reading src/a.ts"),
  execute: jest.fn(async () => "file contents"),
});
const agentInput = { annotatedDiff: "diff", changedFiles: ["src/a.ts"], instructions: "" };

type WireMessage = Record<string, unknown>;
type WireRequest = Record<string, unknown> & { messages: WireMessage[] };

function completion(message: WireMessage) {
  return new Response(JSON.stringify({
    id: "offline", object: "chat.completion", created: 0, model: "resolved-model",
    choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message: { role: "assistant", ...message } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function rejection(status: number) {
  return new Response(JSON.stringify({ error: {
    type: "invalid_request_error",
    message: status === 400 ? "reasoning_content must be passed back with tools" : "Endpoint is unavailable",
  } }), { status, headers: { "content-type": "application/json" } });
}

/** Keep the installed SDK's serialization, JSON/SSE decoding and errors; replace only fetch. */
function offlineClient(
  handler: (body: WireRequest, index: number, signal?: AbortSignal | null) => Response | Promise<Response>,
  options: { baseUrl?: string; model?: string; maxAttempts?: number } = {},
) {
  const progress = jest.fn();
  const client = new LLMClient(options.baseUrl ?? "https://opencode.ai/zen/go/v1", "offline-not-a-key",
    options.model ?? "test-model", 1234, 60_000, options.maxAttempts ?? 1, 0.1, progress, "max");
  const sdk = (client as unknown as { client: { fetch: (url: unknown, init?: { body?: unknown; headers?: unknown; signal?: AbortSignal | null }) => Promise<Response> } }).client;
  const requests: WireRequest[] = [];
  const headers: Record<string, string>[] = [];
  sdk.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as WireRequest;
    requests.push(body);
    headers.push(init?.headers as Record<string, string>);
    return handler(body, requests.length - 1, init?.signal);
  };
  return { client, requests, headers, progress };
}

function expectPrivateOnlyOnAssistants(requests: WireRequest[]) {
  for (const { messages } of requests) {
    for (const message of messages) {
      if (message.role !== "assistant") expect(message).not.toHaveProperty("reasoning_content");
      expect(message).not.toHaveProperty("provider_secret");
    }
  }
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

it("RC01 replays two exact private strings through the real SDK and agent", async () => {
  const reasons = [PRIVATE, "\tSECOND private turn 中文\r\n "];
  const { client, requests, progress } = offlineClient((body, index) => {
    const assistants = body.messages.filter(message => message.role === "assistant");
    const results = body.messages.filter(message => message.role === "tool");
    if (assistants.length !== index || assistants.some((message, turn) =>
      message.reasoning_content !== reasons[turn] ||
      JSON.stringify(message.tool_calls) !== JSON.stringify([tool(`c${turn}`)]) ||
      results[turn]?.tool_call_id !== `c${turn}` || results[turn]?.content !== "file contents"
    )) return rejection(400);
    return index < 2
      ? completion({ content: null, reasoning_content: reasons[index], provider_secret: "DO_NOT_COPY", tool_calls: [tool(`c${index}`)] })
      : completion({ content: FINAL, reasoning_content: PRIVATE });
  });
  const tools = toolbox();
  const status = jest.fn();
  const result = await runAgentReview({ ...agentInput, llm: client, toolbox: tools, onProgress: status });
  expect(result).toEqual({ content: FINAL, turns: 3, toolCalls: 2, compactions: 0 });
  expect(requests).toHaveLength(3);
  expect(tools.execute.mock.calls).toEqual([
    ["read_file", '{ "path": "src/a.ts" }'], ["read_file", '{ "path": "src/a.ts" }'],
  ]);
  expectPrivateOnlyOnAssistants(requests);
  expect(JSON.stringify([result, progress.mock.calls, status.mock.calls,
    (core.info as jest.Mock).mock.calls, (core.warning as jest.Mock).mock.calls,
    (core.error as jest.Mock).mock.calls])).not.toContain("PRIVATE_REPLAY_SENTINEL");
});

it.each([undefined, null, 42, false, {}, [], "", " \t\n", "Ω 🐦"])(
  "RC02 validates private metadata without coercion (%j)", async value => {
    const results: unknown[] = [];
    const { client, requests } = offlineClient((_body, index) => index === 0
      ? completion({ content: null, ...(value === undefined ? {} : { reasoning_content: value }),
        tool_calls: [tool("c0")] })
      : completion({ content: FINAL }));
    const llm = {
      chatCompletion: client.chatCompletion.bind(client),
      chatWithTools: async (...args: Parameters<LLMClient["chatWithTools"]>) => {
        const result = await client.chatWithTools(...args);
        results.push(result);
        return result;
      },
    };
    await runAgentReview({ ...agentInput, llm, toolbox: toolbox() });
    const assistant = requests[1].messages.find(message => message.role === "assistant");
    if (typeof value === "string") {
      expect(results[0]).toHaveProperty("reasoningContent", value);
      expect(assistant).toHaveProperty("reasoning_content", value);
    } else {
      expect(results[0]).not.toHaveProperty("reasoningContent");
      expect(assistant).not.toHaveProperty("reasoning_content");
    }
    expect(results[1]).not.toHaveProperty("reasoningContent");
    expectPrivateOnlyOnAssistants(requests);
  },
);

it.each(["https://api.openai.com/v1", "https://api.anthropic.com/v1", "https://provider.invalid/v1"])(
  "RC03 keeps ordinary non-tool requests and visible answers compatible on %s", async baseUrl => {
    const { client, requests } = offlineClient((_body, index) => completion({ content: FINAL,
      ...(index === 0 ? {} : { reasoning_content: PRIVATE }) }), { baseUrl });
    const ordinary = await client.chatCompletion("system", "user", true);
    expect(ordinary.content).toBe(FINAL);
    expect(ordinary).not.toHaveProperty("reasoningContent");
    const reasoning = await client.chatCompletion("system", "user", true);
    expect(reasoning.content).toBe(FINAL);
    expect(reasoning).toHaveProperty("reasoningContent", PRIVATE);
    for (const body of requests) {
      expect(body.messages).toEqual([{ role: "system", content: "system" }, { role: "user", content: "user" }]);
      expect(body).not.toHaveProperty("tools");
    }
  },
);

it("RC03 never substitutes private reasoning for a missing visible answer", async () => {
  const { client, requests, progress } = offlineClient(() => completion({ content: null, reasoning_content: PRIVATE }));
  await expect(runAgentReview({ ...agentInput, llm: client, toolbox: toolbox() })).rejects.toThrow("Empty response from LLM");
  expect(requests).toHaveLength(1);
  expect(JSON.stringify([progress.mock.calls, (core.warning as jest.Mock).mock.calls,
    (core.error as jest.Mock).mock.calls])).not.toContain("PRIVATE_REPLAY_SENTINEL");
});

it("RC05 preserves replay, caps, effort and session headers across a 429 retry", async () => {
  jest.useFakeTimers();
  const { client, requests, headers } = offlineClient((_body, index) => {
    if (index === 0) return completion({ content: null, reasoning_content: PRIVATE, tool_calls: [tool("c0")] });
    if (index === 1) return rejection(429);
    return completion({ content: FINAL });
  }, { maxAttempts: 3 });
  const pending = runAgentReview({ ...agentInput, llm: client, toolbox: toolbox() });
  await jest.runAllTimersAsync();
  expect((await pending).content).toBe(FINAL);
  expect(requests).toHaveLength(3);
  expect(requests[2]).toEqual(requests[1]);
  expect(requests[2].messages.find(message => message.role === "assistant")).toHaveProperty("reasoning_content", PRIVATE);
  for (const body of requests) {
    expect(body).toMatchObject({ max_tokens: 1234, reasoning_effort: "max", temperature: 0.1 });
    expect(body).not.toHaveProperty("reasoning");
  }
  expect(headers[0]["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(new Set(headers.map(header => header["x-opencode-session"])).size).toBe(1);
  expect(headers.every(header => header["user-agent"] === "robin-review/2")).toBe(true);
});

it.each([400, 429])("RC05 bounds HTTP %i failures without leaking replay metadata", async status => {
  jest.useFakeTimers();
  const { client, requests, progress } = offlineClient((_body, index) => index === 0
    ? completion({ content: null, reasoning_content: PRIVATE, tool_calls: [tool("c0")] })
    : rejection(status), { maxAttempts: 3 });
  const pending = expect(runAgentReview({ ...agentInput, llm: client, toolbox: toolbox() }))
    .rejects.toThrow(status === 400 ? "reasoning_content must be passed back" : "Endpoint is unavailable");
  await jest.runAllTimersAsync();
  await pending;
  expect(requests).toHaveLength(status === 400 ? 2 : 4);
  for (const body of requests.slice(1)) {
    expect(body.messages.find(message => message.role === "assistant")).toHaveProperty("reasoning_content", PRIVATE);
    expect(body).toMatchObject({ max_tokens: 1234, reasoning_effort: "max" });
  }
  expect(JSON.stringify([progress.mock.calls, (core.info as jest.Mock).mock.calls,
    (core.warning as jest.Mock).mock.calls, (core.error as jest.Mock).mock.calls])).not.toContain("PRIVATE_REPLAY_SENTINEL");
});

/** Split the SSE bytes too, so the installed SDK decoder handles frame/Unicode boundaries. */
function sse(deltas: WireMessage[]) {
  const frames = deltas.map((delta, index) => ({
    id: "offline-stream", object: "chat.completion.chunk", created: 0, model: "resolved-model",
    choices: [{ index: 0, delta, finish_reason: index === deltas.length - 1 ? "stop" : null }],
  }));
  const bytes = Buffer.from(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 7) chunks.push(bytes.subarray(offset, offset + 7));
  return new Response(Readable.from(chunks), { headers: { "content-type": "text/event-stream" } });
}

it.each([
  { label: "split strings", values: ["", "PRIVATE_REPLAY_", null, "SENTINEL \n", 42, " Ω 🐦  "], expected: PRIVATE },
  { label: "valid empty", values: [null, "", {}], expected: "" },
  { label: "absent", values: [undefined, null, 42, false, {}, []], expected: undefined },
])("RC06 decodes and replays streaming $label without visible reasoning", async ({ values, expected }) => {
  const { client, requests } = offlineClient((_body, index) => index === 0
    ? sse([
      ...values.map(value => value === undefined ? {} : { reasoning_content: value }),
      { tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "read_", arguments: '{ "path":' } }] },
      { tool_calls: [{ index: 0, function: { name: "file", arguments: ' "src/a.ts" }' } }] },
    ])
    : sse([{ reasoning_content: PRIVATE }, { content: FINAL }]), { model: "openrouter/free" });
  const result = await runAgentReview({ ...agentInput, llm: client, toolbox: toolbox() });
  expect(result.content).toBe(FINAL);
  expect(requests).toHaveLength(2);
  expect(requests.every(body => body.stream === true)).toBe(true);
  const assistant = requests[1].messages.find(message => message.role === "assistant");
  expect(assistant).toMatchObject({ content: null, tool_calls: [tool("c0")] });
  if (expected === undefined) expect(assistant).not.toHaveProperty("reasoning_content");
  else expect(assistant).toHaveProperty("reasoning_content", expected);
  expectPrivateOnlyOnAssistants(requests);
});


it("RC06 retains the first-chunk abort and bounded retry before any SSE arrives", async () => {
  jest.useFakeTimers();
  const { client, requests } = offlineClient((_body, index, signal) => {
    if (index > 0) return sse([{ content: FINAL }]);
    return new Promise<Response>((_resolve, reject) => {
      if (!signal) return reject(new Error("missing SDK abort signal"));
      signal.addEventListener("abort", () => reject(new Error("offline aborted")), { once: true });
    });
  }, { model: "openrouter/free", maxAttempts: 3 });
  const pending = expect(client.chatCompletion("system", "user")).resolves.toMatchObject({ content: FINAL });
  await jest.advanceTimersByTimeAsync(DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS - 1);
  expect(requests).toHaveLength(1);
  expect(core.warning).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("OpenRouter stall"));
  await jest.runAllTimersAsync();
  await pending;
  expect(requests).toHaveLength(2);
});
