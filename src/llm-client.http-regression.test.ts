jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as http from "http";
import { AddressInfo } from "net";
import { IncomingHttpHeaders } from "http";
import { LLMClient } from "./llm-client";

/**
 * Real local HTTP regressions for the max-output-tokens compatibility contract.
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
  handler: (body: Body, headers: IncomingHttpHeaders) => { status: number; body: unknown },
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
      const { status, body } = handler(parsed, req.headers);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
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

function makeClient(baseUrl: string, model: string, maxOutputTokens: number): LLMClient {
  // maxAttempts:1 isolates the in-request parameter fallback from the outer retry loop.
  return new LLMClient(baseUrl, "test-key", model, maxOutputTokens, undefined, 1);
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
