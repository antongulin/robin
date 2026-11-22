jest.mock("@actions/core", () => ({ info: jest.fn(), warning: jest.fn(), error: jest.fn() }));
import * as core from "@actions/core";
import { Response } from "node-fetch";
import { Readable } from "node:stream";
import { runAgentReview } from "./agent-review";
import { UsageLedger } from "./usage-report";
import { LLMClient } from "./llm-client";
import { isMistralEndpoint, normalizeMistralErrorBody } from "./llm-provider";

const reasoningObject = "{\"object\":\"error\",\"message\":{\"detail\":[{\"type\":\"extra_forbidden\",\"loc\":[\"body\",\"reasoning\"],\"msg\":\"Extra inputs are not permitted\",\"input\":{\"effort\":\"max\",\"exclude\":true}}]},\"type\":\"invalid_request_error\",\"param\":null,\"code\":null,\"raw_status_code\":422}";
const nativeMedium = "{\"object\":\"error\",\"message\":\"reasoning_effort 'medium' is not supported for this model; supported values: ['none', 'low', 'high', 'xhigh', 'max']\",\"type\":\"invalid_request_invalid_args\",\"param\":null,\"code\":\"3051\",\"raw_status_code\":400}";
const nativeMax = "{\"id\":\"bfc700324f0f4ae8be329788dc427ff1\",\"created\":1795329102,\"model\":\"deepseek-v4-1-flash-1017\",\"usage\":{\"prompt_tokens\":37,\"total_tokens\":50,\"completion_tokens\":13,\"prompt_tokens_details\":{\"cached_tokens\":0},\"completion_tokens_details\":{\"reasoning_tokens\":10}},\"object\":\"chat.completion\",\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"tool_calls\":null,\"content\":[{\"type\":\"thinking\",\"thinking\":[{\"type\":\"text\",\"text\":\"We need answer single word ok. Must comply.\"}],\"closed\":true},{\"type\":\"text\",\"text\":\"ok\"}]},\"response_error\":{\"format_error\":null,\"content_validation\":[\"valid_think_chunk\",\"valid_text_chunk\"],\"tool_calls_validation\":[],\"extra_tags\":[]}}]}";
const nativeMaxStream = "data: {\"id\":\"c8a710cf1b7e4583a2e8bb3de8a663d8\",\"object\":\"chat.completion.chunk\",\"created\":1795329103,\"model\":\"deepseek-v4-1-flash-1017\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"c8a710cf1b7e4583a2e8bb3de8a663d8\",\"object\":\"chat.completion.chunk\",\"created\":1795329103,\"model\":\"deepseek-v4-1-flash-1017\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"index\":0,\"content\":\"\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"c8a710cf1b7e4583a2e8bb3de8a663d8\",\"object\":\"chat.completion.chunk\",\"created\":1795329103,\"model\":\"deepseek-v4-1-flash-1017\",\"choices\":[{\"index\":0,\"delta\":{\"index\":0,\"content\":[{\"type\":\"thinking\",\"thinking\":[{\"type\":\"text\",\"text\":\"We\"}],\"closed\":true}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"c8a710cf1b7e4583a2e8bb3de8a663d8\",\"object\":\"chat.completion.chunk\",\"created\":1795329103,\"model\":\"deepseek-v4-1-flash-1017\",\"choices\":[{\"index\":0,\"delta\":{\"index\":0,\"content\":[{\"type\":\"thinking\",\"thinking\":[{\"type\":\"text\",\"text\":\" need answer single\"}],\"closed\":true}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"c8a710cf1b7e4583a2e8bb3de8a663d8\",\"object\":\"chat.completion.chunk\",\"created\":1795329103,\"model\":\"deepseek-v4-1-flash-1017\",\"choices\":[{\"index\":0,\"delta\":{\"index\":0,\"content\":[{\"type\":\"thinking\",\"thinking\":[{\"type\":\"text\",\"text\":\" word \\\"ok\\\". Need comply\"}],\"closed\":true}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"c8a710cf1b7e4583a2e8bb3de8a663d8\",\"object\":\"chat.completion.chunk\",\"created\":1795329103,\"model\":\"deepseek-v4-1-flash-1017\",\"choices\":[{\"index\":0,\"delta\":{\"index\":0,\"content\":[{\"type\":\"thinking\",\"thinking\":[{\"type\":\"text\",\"text\":\".\"}],\"closed\":true},{\"type\":\"text\",\"text\":\"ok\"}]},\"finish_reason\":\"stop\",\"response_error\":{\"format_error\":null,\"content_validation\":[\"valid_think_chunk\",\"valid_text_chunk\"],\"tool_calls_validation\":[],\"extra_tags\":[]}}],\"usage\":{\"prompt_tokens\":37,\"total_tokens\":51,\"completion_tokens\":14,\"prompt_tokens_details\":{\"cached_tokens\":0},\"completion_tokens_details\":{\"reasoning_tokens\":11}}}\n\ndata: [DONE]\n\n";
const nativeMaxSchema = "{\"id\":\"e7bed177488d477e8bbdb1e20f8db813\",\"created\":1795329104,\"model\":\"deepseek-v4-1-flash-1017\",\"usage\":{\"prompt_tokens\":37,\"total_tokens\":66,\"completion_tokens\":29,\"prompt_tokens_details\":{\"cached_tokens\":0},\"completion_tokens_details\":{\"reasoning_tokens\":22}},\"object\":\"chat.completion\",\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"tool_calls\":null,\"content\":[{\"type\":\"thinking\",\"thinking\":[{\"type\":\"text\",\"text\":\"We need answer exact JSON. Need comply. Return JSON {\\\"a\\\":\\\"ok\\\"}. No markdown likely.\"}],\"closed\":true},{\"type\":\"text\",\"text\":\"{\\\"a\\\":\\\"ok\\\"}\"}]},\"response_error\":{\"format_error\":null,\"content_validation\":[\"valid_think_chunk\",\"valid_json\"],\"tool_calls_validation\":[],\"extra_tags\":[]}}]}";

type Wire = Record<string, unknown>;
type Fixture = { body: string; status: number; contentType?: string };

function offline(base: string, bodies: Fixture[], effort = "max", model = "test-model", attempts = 1) {
  const progress = jest.fn();
  const client = new LLMClient(base, "offline-key", model, 1234, 60000, attempts, 0.1, progress, effort);
  const requests: Wire[] = [];
  const sdk = (client as unknown as {
    client: { fetch: (url: unknown, init: { body: string }) => Promise<Response> };
  }).client;
  sdk.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const result = bodies[Math.min(requests.length - 1, bodies.length - 1)];
    const body = result.contentType === "text/event-stream" ? Readable.from([result.body]) : result.body;
    return new Response(body, {
      status: result.status,
      headers: { "content-type": result.contentType ?? "application/json" },
    });
  };
  return { client, requests, progress };
}

function reply(content: unknown, toolCalls?: unknown): string {
  return JSON.stringify({
    id: "offline", object: "chat.completion", created: 0, model: "test-model",
    choices: [{
      index: 0, finish_reason: toolCalls ? "tool_calls" : "stop",
      message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
    }],
  });
}

function stream(deltas: unknown[]): string {
  return deltas.map(delta => {
    const chunk = {
      id: "offline", object: "chat.completion.chunk", created: 0, model: "openrouter/free",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }).join("") + "data: [DONE]\n\n";
}

function visible(progress: jest.Mock, result?: unknown): string {
  return JSON.stringify([
    result, progress.mock.calls, (core.info as jest.Mock).mock.calls,
    (core.warning as jest.Mock).mock.calls, (core.error as jest.Mock).mock.calls,
  ]);
}

const ok = { body: nativeMax, status: 200 };
const plain = { body: reply("ok"), status: 200 };
const mistral = "https://api.mistral.ai/v1";
const call = { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } };
const messages = [{ role: "system", content: "system" }, { role: "user", content: "user" }];

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

describe("host scope", () => {
  it.each([
    ["https://api.mistral.ai/v1", true],
    ["https://api.mistral.ai/v1/", true],
    ["https://API.MISTRAL.AI:443/v1/chat/completions", true],
    ["https://api.mistral.ai", false],
    ["https://api.mistral.ai/chat/completions", false],
    ["https://api.mistral.ai/v2", false],
    ["https://api.mistral.ai:8443/v1", false],
    ["http://api.mistral.ai/v1", false],
    ["https://x.api.mistral.ai", false],
    ["https://api.mistral.ai.example.com", false],
    ["bad", false],
  ])("T1 host scope %s", (url, expected) => {
    expect(isMistralEndpoint(url)).toBe(expected);
  });
});

describe("non-Mistral compatibility", () => {
  it.each([
    ["https://api.openai.com/v1", { reasoning_effort: "high" }],
    ["https://openrouter.ai/api/v1", { reasoning: { effort: "high", exclude: true } }],
    ["https://opencode.ai/zen/go/v1", { reasoning_effort: "high" }],
    ["https://api.anthropic.com/v1", {}],
    ["https://provider.invalid/v1", { reasoning: { effort: "high", exclude: true } }],
    ["https://api.mistral.ai", { reasoning: { effort: "high", exclude: true } }],
  ])("T2 wire compatibility %s", async (base, controls) => {
    const { client, requests } = offline(base, [plain], "high");
    await client.chatCompletion("system", "user");
    expect(requests[0]).toEqual({
      model: "test-model", messages, stream: false, temperature: 0.1, max_tokens: 1234, ...controls,
    });
    expect((core.info as jest.Mock).mock.calls.filter(([s]) => String(s).includes("Mistral API detected")))
      .toHaveLength(0);
  });

  it.each([400, 422])("T8 leaves non-Mistral %s error unchanged", async status => {
    const body = status === 400 ? nativeMedium : reasoningObject;
    const { client, requests } = offline("https://provider.invalid/v1", [{ body, status }]);
    const error = await client.chatCompletion("s", "u").catch(e => e);
    expect(error.cause.message).toBe(`${status} status code (no body)`);
    expect(requests).toHaveLength(1);
    expect(client.getReasoningFallbackReason()).toBeUndefined();
  });
});

describe("Mistral requests and fallback", () => {
  it("T3 sends native effort and logs a notice", async () => {
    const { client, requests } = offline(mistral, [ok]);
    await client.chatCompletion("system", "user");
    expect(requests[0]).toMatchObject({ reasoning_effort: "max" });
    expect(requests[0]).not.toHaveProperty("reasoning");
    expect((core.info as jest.Mock).mock.calls.filter(([s]) => String(s).includes("Mistral API detected")))
      .toHaveLength(1);
  });

  it("T3 omits controls and notice when effort is absent", async () => {
    const { client, requests } = offline(mistral, [plain], "");
    await client.chatCompletion("system", "user");
    expect(requests[0]).toEqual({ model: "test-model", messages, stream: false, temperature: 0.1, max_tokens: 1234 });
    expect((core.info as jest.Mock).mock.calls.filter(([s]) => String(s).includes("Mistral API detected")))
      .toHaveLength(0);
  });

  it.each([
    ["T4", nativeMedium, 400, "medium", "invalid-value", "invalid"],
    ["T5", reasoningObject, 422, "max", "unsupported", "unsupported"],
  ] as const)("%s captured error falls back and stays off", async (_id, body, status, effort, reason, label) => {
    const { client, requests, progress } = offline(mistral, [{ body, status }, ok], effort);
    const result = await client.chatCompletion("system", "user");
    expect(result.content).toBe("ok");
    await client.chatCompletion("system", "user");
    expect(requests).toHaveLength(3);
    expect(requests[0]).toHaveProperty("reasoning_effort", effort);
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
    expect(requests[2]).not.toHaveProperty("reasoning_effort");
    expect(client.getReasoningFallbackReason()).toBe(reason);
    const warning = `Provider rejected the configured reasoning effort as ${label} ` +
      `(Provider rejected request parameters (HTTP ${status})). ` +
      "Retrying once without the reasoning parameter and continuing this run without reasoning controls.";
    expect((core.warning as jest.Mock).mock.calls.filter(([text]) => text === warning)).toHaveLength(1);
    const progressText = reason === "invalid-value"
      ? "Provider rejected the configured reasoning effort — retrying without it…"
      : "Provider rejected reasoning controls — retrying without them…";
    expect(progress.mock.calls.filter(([text]) => text === progressText)).toHaveLength(1);
    const output = visible(progress, result);
    const raw = status === 400 ? JSON.parse(body).message : "Extra inputs are not permitted";
    expect(output).not.toContain(raw);
    expect(output).not.toContain("3051");
  });

  it("T4b retries an always-invalid response only once", async () => {
    const { client, requests, progress } = offline(mistral, [{ body: nativeMedium, status: 400 }], "medium");
    const error = await client.chatCompletion("system", "user").catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(JSON.parse(nativeMedium).message);
    expect(error.message).not.toContain("3051");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("reasoning_effort", "medium");
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
    expect(client.getReasoningFallbackReason()).toBe("invalid-value");
    expect(visible(progress, error.message)).not.toContain("3051");
  });

  it.each([429, 500])("T9 preserves retry behavior for status %i", async status => {
    jest.useFakeTimers();
    const { client, requests } = offline(mistral, [{ body: nativeMedium, status }, ok], "max", "test-model", 2);
    const pending = client.chatCompletion("s", "u");
    await jest.runAllTimersAsync();
    expect((await pending).content).toBe("ok");
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(client.getReasoningFallbackReason()).toBeUndefined();
  });

  it("T20 falls back on synthetic flat-field rejection", async () => {
    const body = reasoningObject.replace('"reasoning"', '"reasoning_effort"');
    const { client, requests } = offline(mistral, [{ body, status: 422 }, ok]);
    await client.chatCompletion("s", "u");
    expect(requests).toHaveLength(2);
    expect(client.getReasoningFallbackReason()).toBe("unsupported");
  });
});

describe("error normalization", () => {
  it("T6 normalizes detail without input", () => {
    expect(normalizeMistralErrorBody(422, JSON.parse(reasoningObject))).toEqual({
      error: { message: "reasoning: Extra inputs are not permitted", type: "invalid_request_error",
        code: undefined, param: "reasoning" },
    });
  });

  it("T6 joins multiple validation details without input", () => {
    const body = {
      object: "error", param: "fallback", message: { detail: [
        { loc: ["body", "one"], msg: "bad", input: "secret" },
        { loc: ["body", "nested", 1], msg: "wrong" },
      ] },
    };
    expect(normalizeMistralErrorBody(422, body)).toEqual({
      error: { message: "one: bad; nested.1: wrong", type: undefined, code: undefined, param: "fallback" },
    });
  });

  it.each([401, 429, 500])("T7 leaves other status %s alone", status => {
    const body = JSON.parse(reasoningObject);
    expect(normalizeMistralErrorBody(status, body)).toBe(body);
  });

  it.each([
    { object: "wrong", message: "bad" },
    { object: "error", message: " " },
    { object: "error", message: { detail: [null, {}] } },
    { object: "error", message: "bad", error: undefined },
  ])("T7 ignores malformed or enveloped errors %j", body => {
    expect(normalizeMistralErrorBody(422, body)).toBe(body);
  });
});

describe("content parts", () => {
  it("T10 reads captured parts without thinking", async () => {
    const { client, progress } = offline(mistral, [ok]);
    const result = await client.chatCompletion("s", "u");
    expect(result.content).toBe("ok");
    expect(result.reasoningContent).toBeUndefined();
    const thinking = JSON.parse(nativeMax).choices[0].message.content[0].thinking[0].text;
    expect(visible(progress, result)).not.toContain(thinking);
  });

  it("T11 reads captured schema text", async () => {
    const { client } = offline(mistral, [{ body: nativeMaxSchema, status: 200 }]);
    expect(JSON.parse((await client.chatCompletion("s", "u", true)).content)).toEqual({ a: "ok" });
  });

  it("T12 reads captured stream parts without publishing thinking", async () => {
    const fixture = { body: nativeMaxStream, status: 200, contentType: "text/event-stream" };
    const { client, progress } = offline(mistral, [fixture], "max", "openrouter/free");
    const result = await client.chatCompletion("s", "u");
    expect(result.content).toBe("ok");
    for (const thinking of [" need answer single", ' word "ok". Need comply']) {
      expect(visible(progress, result)).not.toContain(thinking);
    }
  });

  it("T13 streaming strings and tool calls take precedence over array text", async () => {
    const part = [{ type: "text", text: "new" }];
    const stringFixture = {
      body: stream([{ content: part }, { content: "old" }]), status: 200, contentType: "text/event-stream",
    };
    const a = offline(mistral, [stringFixture], "max", "openrouter/free");
    expect((await a.client.chatCompletion("s", "u")).content).toBe("old");
    const blankWithParts = offline(mistral, [{
      body: stream([{ content: "\n" }, { content: part }]), status: 200, contentType: "text/event-stream",
    }], "max", "openrouter/free");
    expect((await blankWithParts.client.chatCompletion("s", "u")).content).toBe("new");
    const blankOnly = offline(mistral, [{
      body: stream([{ content: "\n" }]), status: 200, contentType: "text/event-stream",
    }], "max", "openrouter/free");
    expect((await blankOnly.client.chatCompletion("s", "u")).content).toBe("\n");
    const toolFixture = {
      body: stream([{ content: part }, { tool_calls: [{ index: 0, ...call }] }]),
      status: 200, contentType: "text/event-stream",
    };
    const b = offline(mistral, [toolFixture], "max", "openrouter/free");
    const result = await b.client.chatWithTools([{ role: "user", content: "u" }], []);
    expect(result.content).toBe("");
    expect(result.toolCalls?.[0].name).toBe("read_file");
  });

  it("T14 tool calls take precedence over nonstream parts", async () => {
    const { client } = offline(mistral, [{ body: reply([{ type: "text", text: "ignored" }], [call]), status: 200 }]);
    const result = await client.chatWithTools([{ role: "user", content: "u" }], []);
    expect(result.content).toBe("");
    expect(result.toolCalls?.[0].name).toBe("read_file");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it.each([
    [[]],
    [[{ type: "thinking", thinking: [{ type: "text", text: "private" }] }]],
    [[{ type: "text", text: 4 }]],
    [[{ type: "text", text: "  " }]],
  ])("T15 empty parts retain warning %j", async parts => {
    const { client } = offline(mistral, [{ body: reply(parts), status: 200 }]);
    await expect(client.chatCompletion("s", "u")).rejects.toThrow("Empty response from LLM");
    expect(core.warning).toHaveBeenCalledWith("LLM choice has no text content (finish_reason=stop).");
  });

  it("T16 existing nonblank string remains byte identical", async () => {
    const { client } = offline(mistral, [{ body: reply("  original \n"), status: 200 }]);
    expect((await client.chatCompletion("s", "u")).content).toBe("  original \n");
  });
});

describe("agent and accounting", () => {
  it("T17 agent carries tool result into final parts response", async () => {
    const final = '{"summary":"ok","high":[],"medium":[],"low":[],"suggestions":[]}';
    const parts = [{ type: "thinking", thinking: [{ type: "text", text: "private" }] }, { type: "text", text: final }];
    const { client, requests } = offline(mistral, [
      { body: reply(null, [call]), status: 200 }, { body: reply(parts), status: 200 },
    ]);
    const toolbox = { describe: jest.fn(() => "Reading"), execute: jest.fn(async () => "file contents") };
    const result = await runAgentReview({
      annotatedDiff: "diff", changedFiles: ["src/a.ts"], instructions: "", llm: client, toolbox,
    });
    expect(result.content).toBe(final);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", content: "file contents" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("T18 request budget prevents dispatch and preserves accounting", async () => {
    const ledger = new UsageLedger();
    const client = new LLMClient(mistral, "key", "test-model", undefined, 60000, 1, 0.1, undefined, "max", ledger, 1);
    const sdk = (client as unknown as { client: { fetch: jest.Mock } }).client;
    sdk.fetch = jest.fn();
    await expect(client.chatCompletion("system", "user")).rejects.toThrow();
    expect(sdk.fetch).not.toHaveBeenCalled();
    expect(ledger.report().compact.attempts).toBe(0);
  });

  it("T18 records successful native effort and usage with a fitting budget", async () => {
    const ledger = new UsageLedger();
    const client = new LLMClient(mistral, "offline-key", "test-model", 1234, 60000, 1, 0.1, undefined,
      "max", ledger, 20000);
    const sdk = (client as unknown as {
      client: { fetch: (url: unknown, init: { body: string }) => Promise<Response> };
    }).client;
    let sent: Wire = {};
    sdk.fetch = async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response(nativeMax, { status: 200, headers: { "content-type": "application/json" } });
    };
    expect((await client.chatCompletion("s", "u")).content).toBe("ok");
    expect(sent).toHaveProperty("reasoning_effort", "max");
    expect(ledger.report().full.ledger[0]).toMatchObject({
      outcome: "accepted", sent_effort: { field: "reasoning_effort", value: "max" },
    });
    expect(ledger.report().compact.attempts).toBe(1);
  });
});
