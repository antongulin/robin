jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import { Readable } from "node:stream";
import { Response } from "node-fetch";
import { LLMClient } from "./llm-client";
import { LlmRequestCancelledError } from "./llm-retry";
import { UsageLedger } from "./usage-report";

/**
 * Real cancellation through the installed SDK: a parent signal must abort the physical
 * request (blocking and streaming), the retry wait, and compatibility work. It must never
 * be serialized into the request body and must not be reclassified as a retry or stall.
 */

type WireRequest = Record<string, unknown> & { messages: unknown[] };
interface FetchInit {
  body?: unknown;
  signal?: AbortSignal | null;
}

function completion(content = "review text") {
  return new Response(JSON.stringify({
    id: "offline", object: "chat.completion", created: 0, model: "resolved-model",
    usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function failure(status: number, message: string, param?: string) {
  return new Response(JSON.stringify({ error: { type: "invalid_request_error", message, ...(param ? { param } : {}) } }), {
    status, headers: { "content-type": "application/json" },
  });
}

function offlineClient(
  handler: (body: WireRequest, init: FetchInit, index: number) => Response | Promise<Response>,
  options: { model?: string; maxAttempts?: number; output?: number; ledger?: UsageLedger; onProgress?: (detail: string) => void } = {}
) {
  const client = new LLMClient(
    "https://offline.invalid/v1", "offline-not-a-key", options.model ?? "test-model", options.output,
    60_000, options.maxAttempts ?? 1, undefined, options.onProgress, undefined, options.ledger
  );
  const sdk = (client as unknown as {
    client: { fetch: (url: unknown, init?: FetchInit) => Promise<Response> };
  }).client;
  const requests: WireRequest[] = [];
  sdk.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as WireRequest;
    requests.push(body);
    return handler(body, init ?? {}, requests.length - 1);
  };
  return { client, requests };
}

/** A request that never answers; it rejects only when the SDK's signal aborts. */
function pendingUntilAborted(init: FetchInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
  });
}

test("A6-4 aborts a blocking request without retrying and keeps prior usage", async () => {
  const controller = new AbortController();
  const ledger = new UsageLedger();
  const { client, requests } = offlineClient((_body, init, index) => {
    if (index === 0) return completion("first answer");
    controller.abort();
    return pendingUntilAborted(init);
  }, { maxAttempts: 3, ledger });

  await expect(client.chatCompletion("s", "first", false)).resolves.toHaveProperty("content", "first answer");
  await expect(client.chatCompletion("s", "second", false, undefined, { signal: controller.signal }))
    .rejects.toBeInstanceOf(LlmRequestCancelledError);

  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests)).not.toContain("AbortSignal");
  expect(Object.keys(requests[1])).not.toContain("signal");
  const report = ledger.report();
  expect(report.full.ledger).toHaveLength(2);
  expect(report.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 100, unknown_attempts: 1 });
});

test("A6-4 aborts a streaming request instead of reporting a router stall", async () => {
  const controller = new AbortController();
  const ledger = new UsageLedger();
  const { client, requests } = offlineClient((_body, init) => {
    const stream = new Readable({ read() { /* stays open until aborted */ } });
    stream.push(`data: ${JSON.stringify({ model: "partial-model", usage: { prompt_tokens: 100, completion_tokens: 2 },
      choices: [{ index: 0, delta: { content: "unfinished review" } }] })}\n\n`);
    const abort = () => stream.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    setImmediate(() => controller.abort());
    return new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  }, { model: "openrouter/free", ledger });

  await expect(client.chatCompletion("s", "u", false, undefined, { signal: controller.signal }))
    .rejects.toBeInstanceOf(LlmRequestCancelledError);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ stream: true });
  const report = ledger.report();
  expect(report.full.ledger[0].outcome).toBe("error");
  expect(report.compact.metrics.prompt_tokens).toMatchObject({
    observed_sum: 100, nonfinal_attempts: 1, final_attempts: 0, complete: false,
  });
});

test("A6-4 stops an outer retry wait when the signal aborts", async () => {
  const controller = new AbortController();
  let retryAnnounced = false;
  const { client, requests } = offlineClient(() => failure(503, "server overloaded"), {
    maxAttempts: 3,
    onProgress: detail => {
      if (detail.includes("Retrying in")) {
        retryAnnounced = true;
        // Let the progress callback return and the retry timer start before aborting.
        setImmediate(() => controller.abort());
      }
    },
  });

  await expect(client.chatCompletion("s", "u", false, undefined, { signal: controller.signal }))
    .rejects.toBeInstanceOf(LlmRequestCancelledError);
  expect(requests).toHaveLength(1);
  expect(retryAnnounced).toBe(true);
});

test("A6-4 stops a rate-limit retry wait when the signal aborts", async () => {
  const controller = new AbortController();
  let retryAnnounced = false;
  const { client, requests } = offlineClient(() => failure(429, "429 inference_failed"), {
    maxAttempts: 3,
    onProgress: detail => {
      if (detail.includes("Retrying in")) {
        retryAnnounced = true;
        // Let the longer rate-limit wait start, then abort it mid-wait.
        setImmediate(() => controller.abort());
      }
    },
  });

  const startedAt = Date.now();
  await expect(client.chatCompletion("s", "u", false, undefined, { signal: controller.signal }))
    .rejects.toBeInstanceOf(LlmRequestCancelledError);
  expect(requests).toHaveLength(1);
  expect(retryAnnounced).toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(2000);
});

test("A6-4 does not dispatch a compatibility rebuild after the signal aborts", async () => {
  const controller = new AbortController();
  const { client, requests } = offlineClient(() => {
    controller.abort();
    return failure(400, "Unsupported parameter: 'max_tokens'", "max_tokens");
  }, { output: 1234 });

  await expect(client.chatCompletion("s", "u", false, undefined, { signal: controller.signal }))
    .rejects.toBeInstanceOf(LlmRequestCancelledError);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ max_tokens: 1234 });
});
