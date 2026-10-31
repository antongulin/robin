jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as http from "http";
import { AddressInfo } from "net";
import { IncomingHttpHeaders } from "http";
import { UsageLedger } from "./usage-report";
import * as retry from "./llm-retry";
import { LLMClient } from "./llm-client";

/**
 * Real local HTTP regressions for token caps and reasoning-effort compatibility.
 *
 * These deliberately use a real socket and the real OpenAI SDK: the failure being
 * guarded against is the *emitted body* losing a configured cap (by being renamed or
 * omitted), which a `create()` stub cannot observe. The gateway is request-driven — it
 * decides its response from the request body — rather than a fixed success/failure queue.
 */

type Body = Record<string, unknown>;

interface Gateway {
  baseUrl: string;
  requests: Body[];
  headers: IncomingHttpHeaders[];
  close: () => Promise<void>;
}

function startGateway(
  handler: (body: Body, headers: IncomingHttpHeaders) => { status: number; body?: unknown; sse?: string },
): Promise<Gateway> {
  const requests: Body[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      requests.push(parsed);
      headers.push(req.headers);
      const { status, body, sse } = handler(parsed, req.headers);
      res.writeHead(status, { "content-type": sse === undefined ? "application/json" : "text/event-stream" });
      res.end(sse === undefined ? JSON.stringify(body) : sse);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        headers,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function completion(model: string, content = "review text") {
  return {
    status: 200,
    body: {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  };
}

function unsupportedField(param: string, hint: string) {
  return {
    status: 400,
    body: {
      error: {
        message: `Unsupported parameter: '${param}' is not supported with this model. ${hint}`,
        type: "invalid_request_error",
        param,
        code: "unsupported_parameter",
      },
    },
  };
}

function makeClient(baseUrl: string, model: string, maxOutputTokens: number, reasoningEffort?: string): LLMClient {
  // maxAttempts:1 isolates the in-request parameter fallback from the outer retry loop.
  return new LLMClient(baseUrl, "test-key", model, maxOutputTokens, undefined, 1, undefined, undefined, reasoningEffort);
}

const hasAnyTokenField = (body: Body) =>
  body.max_tokens !== undefined || body.max_completion_tokens !== undefined;

function redirectSdkClientToGateway(client: LLMClient, gateway: Gateway): () => void {
  type SdkTransport = (input: string | URL | { url: string }, init?: RequestInit) => Promise<Response>;
  const sdkClient = (client as unknown as { client: { fetch: SdkTransport } }).client;
  const originalFetch = sdkClient.fetch;
  const localAgent = new http.Agent();
  sdkClient.fetch = (input, init) => {
    const source = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (source.origin !== "https://opencode.ai") {
      throw new Error(`Unexpected SDK test transport origin: ${source.origin}`);
    }
    const target = new URL(`${source.pathname}${source.search}`, gateway.baseUrl);
    const localInit = Object.assign({}, init, { agent: localAgent }) as RequestInit;
    return originalFetch(target.href, localInit);
  };
  return () => {
    sdkClient.fetch = originalFetch;
    localAgent.destroy();
  };
}

describe("max-output-tokens compatibility (real local endpoint)", () => {
  it("keeps the cap by switching to max_tokens on a max_tokens-only gateway (reasoning-family name)", async () => {
    const gateway = await startGateway((body) =>
      body.max_completion_tokens !== undefined
        ? unsupportedField("max_completion_tokens", "Use 'max_tokens' instead.")
        : completion("gpt-5"),
    );
    try {
      const client = makeClient(gateway.baseUrl, "gpt-5", 1234);
      const result = await client.chatCompletion("system", "user");

      expect(result.content).toBe("review text");
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[0]).toHaveProperty("max_completion_tokens", 1234);
      expect(gateway.requests[1]).not.toHaveProperty("max_completion_tokens");
      expect(gateway.requests[1]).toHaveProperty("max_tokens", 1234);
      expect(gateway.requests.every(hasAnyTokenField)).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("keeps the cap by switching to max_completion_tokens on a max_completion_tokens-only gateway", async () => {
    const gateway = await startGateway((body) =>
      body.max_tokens !== undefined
        ? unsupportedField("max_tokens", "Use 'max_completion_tokens' instead.")
        : completion("gpt-4o"),
    );
    try {
      const client = makeClient(gateway.baseUrl, "gpt-4o", 1234);
      const result = await client.chatCompletion("system", "user");

      expect(result.content).toBe("review text");
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[0]).toHaveProperty("max_tokens", 1234);
      expect(gateway.requests[1]).not.toHaveProperty("max_tokens");
      expect(gateway.requests[1]).toHaveProperty("max_completion_tokens", 1234);
      expect(gateway.requests.every(hasAnyTokenField)).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("keeps the adjusted cap for later chatCompletion and chatWithTools turns in the same run", async () => {
    const gateway = await startGateway((body) =>
      body.max_completion_tokens !== undefined
        ? unsupportedField("max_completion_tokens", "Use 'max_tokens' instead.")
        : completion("gpt-5"),
    );
    try {
      const client = makeClient(gateway.baseUrl, "gpt-5", 1234);
      await client.chatCompletion("system", "first");
      await client.chatCompletion("system", "second");
      await client.chatWithTools(
        [
          { role: "system", content: "system" },
          { role: "user", content: "user" },
        ],
        [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      );

      // Exactly one request needed the incompatible field; every later turn keeps max_tokens.
      expect(gateway.requests.filter((body) => body.max_completion_tokens !== undefined)).toHaveLength(1);
      const last = gateway.requests[gateway.requests.length - 1];
      expect(last).toHaveProperty("max_tokens", 1234);
      expect(last).not.toHaveProperty("max_completion_tokens");
      expect(gateway.requests.slice(1).every(hasAnyTokenField)).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it("surfaces the provider error and never sends an uncapped request when both token fields are rejected", async () => {
    const gateway = await startGateway((body) =>
      unsupportedField(
        body.max_tokens !== undefined ? "max_tokens" : "max_completion_tokens",
        "No output-token cap is supported.",
      ),
    );
    try {
      const client = makeClient(gateway.baseUrl, "gpt-5", 3000);

      await expect(client.chatCompletion("system", "user")).rejects.toThrow(
        /Failed to get response from LLM/,
      );
      expect(gateway.requests.length).toBeLessThanOrEqual(2);
      expect(gateway.requests.every(hasAnyTokenField)).toBe(true);
    } finally {
      await gateway.close();
    }
  });

  it.each([
    ["gpt-5", "max_completion_tokens", 400],
    ["gpt-5", "max_completion_tokens", 422],
    ["gpt-4o", "max_tokens", 400],
    ["gpt-4o", "max_tokens", 422],
  ])(
    "surfaces an invalid token-limit value for %s (%s, HTTP %i) without dropping the cap",
    async (model, field, status) => {
      const gateway = await startGateway((body) => {
        const value = body[field] as number | undefined;
        if (value !== undefined && value < 16) {
          return {
            status,
            body: {
              error: {
                message: `Invalid value for '${field}': Expected a value >= 16, but got ${value} instead.`,
                type: "invalid_request_error",
                param: field,
                code: "integer_below_min_value",
              },
            },
          };
        }
        return completion(model);
      });
      try {
        const client = makeClient(gateway.baseUrl, model, 8);

        await expect(client.chatCompletion("system", "user")).rejects.toThrow(
          /Invalid value for/,
        );
        expect(gateway.requests).toHaveLength(1);
        expect(gateway.requests[0]).toHaveProperty(field, 8);
        expect(hasAnyTokenField(gateway.requests[0])).toBe(true);
      } finally {
        await gateway.close();
      }
    },
  );

  it("surfaces an unsupported_value token-limit error without swapping fields or dropping the cap", async () => {
    // Both field spellings are accepted, but values below 16 are invalid. The structured value
    // error must surface after exactly one capped request instead of trying the other spelling.
    const gateway = await startGateway((body) => {
      const field = body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
      const value = body[field] as number | undefined;
      if (value !== undefined && value < 16) {
        return {
          status: 400,
          body: {
            error: {
              message: `Unsupported value for ${field}: must be at least 16, but got ${value}.`,
              type: "invalid_request_error",
              param: field,
              code: "unsupported_value",
            },
          },
        };
      }
      return completion("gpt-5");
    });
    try {
      const client = makeClient(gateway.baseUrl, "gpt-5", 1);

      await expect(client.chatCompletion("system", "user")).rejects.toThrow(
        /Unsupported value for/,
      );
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]).toHaveProperty("max_completion_tokens", 1);
      expect(gateway.requests[0]).not.toHaveProperty("max_tokens");
    } finally {
      await gateway.close();
    }
  });
});

describe("OpenCode Go session headers (real OpenAI SDK and local endpoint)", () => {
  it("keeps one session ID across calls, tool turns, and a parameter fallback retry", async () => {
    const gateway = await startGateway((body, headers) => {
      if (!headers["x-opencode-session"]) {
        return {
          status: 400,
          body: {
            error: {
              message: "Request is missing x-opencode-session",
              type: "invalid_request_error",
            },
          },
        };
      }
      return body.max_completion_tokens !== undefined
        ? unsupportedField("max_completion_tokens", "Use 'max_tokens' instead.")
        : completion("gpt-5");
    });
    try {
      const client = makeClient(
        "https://opencode.ai/zen/go/v1/chat/completions/",
        "gpt-5",
        1234,
      );
      const restoreFetch = redirectSdkClientToGateway(client, gateway);

      try {
        await client.chatCompletion("system", "first");
        await client.chatCompletion("system", "second");
        await client.chatWithTools(
          [
            { role: "system", content: "system" },
            { role: "user", content: "user" },
          ],
          [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
        );
      } finally {
        restoreFetch();
      }

      expect(gateway.requests).toHaveLength(4);
      expect(gateway.requests[0]).toHaveProperty("max_completion_tokens", 1234);
      expect(gateway.requests[1]).toHaveProperty("max_tokens", 1234);
      const sessionIds = gateway.headers.map((headers) => headers["x-opencode-session"]);
      expect(sessionIds[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(new Set(sessionIds).size).toBe(1);
      expect(gateway.headers.every((headers) => headers["user-agent"] === "robin-review/2")).toBe(
        true,
      );
    } finally {
      await gateway.close();
    }
  });

  it("uses a distinct session for another Go client and leaves other providers' headers unchanged", async () => {
    const gateway = await startGateway(() => completion("gpt-4o"));
    try {
      const first = makeClient("https://opencode.ai/zen/go/v1", "gpt-4o", 1234);
      const second = makeClient("https://opencode.ai/zen/go/v1", "gpt-4o", 1234);
      const restoreFirst = redirectSdkClientToGateway(first, gateway);
      const restoreSecond = redirectSdkClientToGateway(second, gateway);
      try {
        await first.chatCompletion("system", "first client");
        await second.chatCompletion("system", "second client");
      } finally {
        restoreFirst();
        restoreSecond();
      }
      const goSessionIds = gateway.headers.map((headers) => headers["x-opencode-session"]);
      expect(goSessionIds.every((value) => typeof value === "string")).toBe(true);
      expect(new Set(goSessionIds).size).toBe(2);
    } finally {
      await gateway.close();
    }

    const otherGateway = await startGateway(() => completion("gpt-4o"));
    try {
      await makeClient(otherGateway.baseUrl, "gpt-4o", 1234).chatCompletion("system", "other");
      expect(otherGateway.headers[0]["x-opencode-session"]).toBeUndefined();
      expect(otherGateway.headers[0]["user-agent"]).not.toBe("robin-review/2");
    } finally {
      await otherGateway.close();
    }
  });
});

describe("OpenCode Go max effort (real OpenAI SDK and local endpoint)", () => {
  const model = "deepseek-v4.1-flash";
  const endpoint = "https://opencode.ai/zen/go/v1/chat/completions/";

  function expectStableHeaders(gateway: Gateway): void {
    const sessions = gateway.headers.map((headers) => headers["x-opencode-session"]);
    expect(sessions[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(new Set(sessions).size).toBe(1);
    expect(gateway.headers.every((headers) => headers["user-agent"] === "robin-review/2")).toBe(true);
  }

  it("MAX-01 emits flat trimmed max for JSON review, tool turns, and non-JSON summaries", async () => {
    const gateway = await startGateway((body) =>
      body.reasoning_effort === "max" && body.reasoning === undefined
        ? completion(model)
        : unsupportedField("reasoning", "Expected flat reasoning_effort: max."),
    );
    const client = makeClient(endpoint, model, 1234, " max ");
    const restore = redirectSdkClientToGateway(client, gateway);
    try {
      expect((await client.chatCompletion("system", "review", true)).content).toBe("review text");
      const tools = [{ type: "function" as const, function: { name: "read_file", parameters: { type: "object" } } }];
      expect((await client.chatWithTools([{ role: "user", content: "inspect" }], tools)).content).toBe("review text");
      expect((await client.chatCompletion("system", "summarize", false)).content).toBe("review text");
      expect(gateway.requests).toHaveLength(3);
      for (const body of gateway.requests) {
        expect(body).toHaveProperty("reasoning_effort", "max");
        expect(body).not.toHaveProperty("reasoning");
      }
      expect(gateway.requests[0]).toHaveProperty("response_format.type", "json_schema");
      expect(gateway.requests[1]).toHaveProperty("tools", tools);
      expect(gateway.requests[1]).not.toHaveProperty("response_format");
      expect(gateway.requests[2]).not.toHaveProperty("response_format");
      expectStableHeaders(gateway);
    } finally {
      restore();
      await gateway.close();
    }
  });

  it.each([
    [400, "unsupported_parameter", "Unsupported parameter: reasoning_effort", "max"],
    [422, "invalid_value", "Invalid value for reasoning_effort: max is not supported", "max"],
    [400, "unsupported_parameter", "Unsupported parameter: reasoning_effort", "high"],
  ])("MAX-02 surfaces HTTP %i %s (%s), preserving explicit effort %s", async (status, code, message, effort) => {
    // The gateway would succeed after omission, exposing both an immediate downgrade and
    // a persistent disable flag on the next call. Reject the old nested shape too.
    const gateway = await startGateway((body) =>
      body.reasoning_effort !== undefined || body.reasoning !== undefined
        ? { status, body: { error: { message, type: "invalid_request_error", param: "reasoning_effort", code } } }
        : completion(model, "unwanted downgrade"),
    );
    const client = makeClient(endpoint, model, 1234, effort);
    const restore = redirectSdkClientToGateway(client, gateway);
    try {
      for (const user of ["first", "second"]) {
        await expect(client.chatCompletion("system", user)).rejects.toThrow(/reasoning_effort/);
      }
      expect(gateway.requests).toHaveLength(2);
      for (const body of gateway.requests) {
        expect(body).toHaveProperty("reasoning_effort", effort);
        expect(body).not.toHaveProperty("reasoning");
      }
      expect(client.getReasoningFallbackReason()).toBeUndefined();
      expectStableHeaders(gateway);
    } finally {
      restore();
      await gateway.close();
    }
  });

  it("MAX-03 retains max while retrying an unrelated rejected temperature", async () => {
    const gateway = await startGateway((body) =>
      body.temperature !== undefined
        ? unsupportedField("temperature", "Use the model default.")
        : completion(model),
    );
    const client = makeClient(endpoint, model, 1234, "max");
    const restore = redirectSdkClientToGateway(client, gateway);
    try {
      expect((await client.chatCompletion("system", "review")).content).toBe("review text");
      expect(gateway.requests).toHaveLength(2);
      expect(gateway.requests[0]).toHaveProperty("temperature");
      expect(gateway.requests[1]).not.toHaveProperty("temperature");
      for (const body of gateway.requests) {
        expect(body).toHaveProperty("reasoning_effort", "max");
        expect(body).not.toHaveProperty("reasoning");
      }
      expectStableHeaders(gateway);
    } finally {
      restore();
      await gateway.close();
    }
  });

  it.each([undefined, "", "   "])("MAX-04 leaves effort unset for %p", async (effort) => {
    const gateway = await startGateway(() => completion(model));
    const client = makeClient(endpoint, model, 1234, effort);
    const restore = redirectSdkClientToGateway(client, gateway);
    try {
      expect((await client.chatCompletion("system", "review")).content).toBe("review text");
      expect(gateway.requests).toHaveLength(1);
      expect(gateway.requests[0]).not.toHaveProperty("reasoning_effort");
      expect(gateway.requests[0]).not.toHaveProperty("reasoning");
      expectStableHeaders(gateway);
    } finally {
      restore();
      await gateway.close();
    }
  });
});


test("UR03 physical ledger spans compatibility and outer retry at real SDK wire", async () => {
  const delay = jest.spyOn(retry, "delayMs").mockResolvedValue();
  let accepted = 0;
  const gateway = await startGateway(body => {
    if (body.max_tokens !== undefined) return unsupportedField("max_tokens", "Use max_completion_tokens instead.");
    accepted++;
    const value = completion("reported-backend", accepted === 1 ? "" : "review");
    value.body.usage = { prompt_tokens: accepted * 100, completion_tokens: accepted * 10, total_tokens: accepted * 110 };
    return value;
  });
  const ledger = new UsageLedger();
  try {
    const client = new LLMClient(gateway.baseUrl, "synthetic-key", "requested-model", 1234, undefined, 2, undefined, undefined, "high", ledger);
    await client.chatCompletion("synthetic system", "synthetic user", true);
    const r = ledger.report();
    expect(gateway.requests).toHaveLength(3);
    expect(r.full.ledger.map(a => [a.logical_call, a.outer_attempt, a.compatibility_attempt, a.trigger, a.compatibility_adjustment])).toEqual([
      [1, 1, 1, "initial", "output-limit"], [1, 1, 2, "compatibility-retry", null], [1, 2, 1, "outer-empty-retry", null],
    ]);
    expect(r.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 300, unknown_attempts: 1, complete: false });
    expect(r.compact.metrics.completion_tokens.observed_sum).toBe(30);
    expect(gateway.requests.every(body => hasAnyTokenField(body) && (body.reasoning as any).effort === "high" && !body.stream_options && !body.usageContext)).toBe(true);
  } finally { delay.mockRestore(); await gateway.close(); }
});

test.each([false, true])("UR09 actual SDK SSE terminal usage and interruption (interrupted %s)", async interrupted => {
  const chunks = [
    { model: "backend", choices: [{ index: 0, delta: { content: "review" }, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 5 } },
    { model: "backend", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { model: "backend", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
  ];
  const gateway = await startGateway(() => ({ status: 200, sse: chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    (interrupted ? 'data: {"error":{"message":"synthetic stream failure","type":"server_error"}}\n\n' : "data: [DONE]\n\n") }));
  const ledger = new UsageLedger();
  try {
    const client = new LLMClient(gateway.baseUrl, "synthetic-key", "openrouter/free", 1234, undefined, 1, undefined, undefined, undefined, ledger);
    if (interrupted) await expect(client.chatCompletion("s", "u")).rejects.toThrow("synthetic stream failure");
    else expect((await client.chatCompletion("s", "u")).content).toBe("review");
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]).toMatchObject({ stream: true, max_tokens: 1234 });
    expect(gateway.requests[0]).not.toHaveProperty("stream_options");
    const r = ledger.report();
    expect(r.compact.attempts).toBe(1);
    expect(r.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 100, final_attempts: interrupted ? 0 : 1, complete: !interrupted });
    expect(r.compact.metrics.completion_tokens.observed_sum).toBe(10);
  } finally { await gateway.close(); }
});
