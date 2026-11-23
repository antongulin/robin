jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as http from "http";
import { AddressInfo, Socket } from "net";
import * as core from "@actions/core";
import { LLMClient } from "./llm-client";

/**
 * Real local HTTP regression: a gateway that reads the request and never answers must end as a
 * visible timeout, not as an anonymous provider failure. The real OpenAI SDK is required here
 * because its own `llm-timeout-ms` timer produces the native error the diagnostics key on.
 */

interface StallGateway {
  baseUrl: string;
  requests: Array<Record<string, unknown>>;
  answerNext: (body: unknown) => void;
  close: () => Promise<void>;
}

function startGateway(): Promise<StallGateway> {
  const requests: Array<Record<string, unknown>> = [];
  const sockets = new Set<Socket>();
  let answer: unknown;
  let answering = false;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      requests.push(parsed);
      if (!answering) return; // Stall: accept the request, then send nothing at all.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
        answerNext: (body) => {
          answer = body;
          answering = true;
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
          }),
      });
    });
  });
}

function completion(model: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "review text" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

const infoMessages = (): string[] =>
  jest.mocked(core.info).mock.calls.map(([message]) => String(message));
const warningMessages = (): string[] =>
  jest.mocked(core.warning).mock.calls.map(([message]) => String(message));

beforeEach(() => {
  jest.clearAllMocks();
});

test(
  "W6 reports an SDK timeout for a gateway that reads the request and never responds",
  async () => {
    const gateway = await startGateway();
    try {
      const client = new LLMClient(gateway.baseUrl, "test-key", "test-model", undefined, 300, 2);

      await expect(client.chatCompletion("system", "user")).rejects.toMatchObject({
        name: "LLMRequestError",
        message: "Failed to get response from LLM: Provider request failed",
      });

      expect(warningMessages()).toEqual([
        expect.stringMatching(
          /^LLM attempt 1\/2 timed out after \d+ s with no response from the provider\.$/
        ),
        "LLM attempt 1/2 failed: Provider request failed",
        expect.stringMatching(
          /^LLM attempt 2\/2 timed out after \d+ s with no response from the provider\.$/
        ),
        "LLM attempt 2/2 failed: Provider request failed",
      ]);
      expect(infoMessages()).toContain("Retrying LLM request in 2000 ms (attempt 2/2)...");
      expect(gateway.requests).toHaveLength(2);

      // Same client, same call: the stalled attempts added no field to the wire body.
      gateway.answerNext(completion("test-model"));
      await expect(client.chatCompletion("system", "normal")).resolves.toMatchObject({
        content: "review text",
      });
      expect(gateway.requests).toHaveLength(3);
      expect(Object.keys(gateway.requests[2]).sort()).toEqual(Object.keys(gateway.requests[0]).sort());
    } finally {
      await gateway.close();
    }
  },
  15_000
);
