jest.mock("@actions/core", () => ({
  info: jest.fn(), warning: jest.fn(), error: jest.fn(), setOutput: jest.fn(),
  summary: { addRaw: jest.fn().mockReturnThis(), write: jest.fn().mockResolvedValue(undefined) },
}));

import * as core from "@actions/core";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionLengthError, LLMClient } from "./llm-client";
import { UsageLedger, normalizeUsage, publishUsageReport } from "./usage-report";

const usage = (prompt = 100, completion = 10) => ({ prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
  prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 3 } });
const response = (content = "review", counts: unknown = usage()) => ({ model: "actual-model", usage: counts,
  choices: [{ message: { content }, finish_reason: "stop" }] });
function setup(stream = false, attempts = 1, effort?: string) {
  const ledger = new UsageLedger(["test-key"]);
  ledger.configure({ requested_model: stream ? "openrouter/free" : "requested-model", requested_effort: { state: effort ? "configured" : "unset", value: effort ?? null } });
  const client = new LLMClient("https://provider.invalid/v1", "test-key", stream ? "openrouter/free" : "requested-model", 2048, undefined, attempts, undefined, undefined, effort, ledger);
  const create = jest.fn();
  (client as any).client = { chat: { completions: { create } } };
  return { ledger, client, create };
}
function streamOf(chunks: unknown[], error?: Error) {
  return { [Symbol.asyncIterator]: async function* () { yield* chunks; if (error) throw error; } };
}

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => { jest.useRealTimers(); });

test("UR01 real response arithmetic, subsets, zeros and requested/reported model separation", async () => {
  const { client, create, ledger } = setup();
  create.mockResolvedValue(response());
  const result = await client.chatCompletion("source sentinel", "private user sentinel");
  expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_input_tokens: 40, reasoning_tokens: 3 });
  const report = ledger.report();
  expect(report.compact.attempts).toBe(1);
  for (const [key, expected] of Object.entries({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cached_input_tokens: 40, reasoning_tokens: 3 })) {
    expect(report.compact.metrics[key as keyof typeof report.compact.metrics]).toMatchObject({ observed_sum: expected, complete: true, final_attempts: 1 });
  }
  expect(report.full.ledger[0]).toMatchObject({ sent_model: "requested-model", reported_model: "actual-model", outcome: "accepted" });
  expect(JSON.stringify(report)).not.toMatch(/source sentinel|private user sentinel|test-key/);
  create.mockResolvedValue(response("zero", usage(0, 0)));
  await client.chatCompletion("system", "user");
  expect(ledger.report().full.ledger[1].usage.prompt_tokens).toMatchObject({ value: 0, final: true });
});

test("UR01 invalid counts stay unknown; safe integer overflow is explicit", async () => {
  expect(normalizeUsage({ prompt_tokens: "1", completion_tokens: -1, total_tokens: Infinity,
    prompt_tokens_details: { cached_tokens: 1.5 }, completion_tokens_details: { reasoning_tokens: NaN } })).toEqual({});
  const { client, create, ledger } = setup();
  create.mockResolvedValue(response("ok", { prompt_tokens: Number.MAX_SAFE_INTEGER }));
  await client.chatCompletion("s", "u");
  create.mockResolvedValue(response("ok", { prompt_tokens: 1 }));
  await client.chatCompletion("s", "u");
  expect(ledger.report().compact.metrics.prompt_tokens).toMatchObject({ observed_sum: null, overflow: true, complete: false, observed_attempts: 2 });
  expect(ledger.report().compact.metrics.completion_tokens).toMatchObject({ observed_sum: null, unknown_attempts: 2 });
});

test.each([false, true])("UR02 empty outer retry retains both attempts (stream %s)", async streaming => {
  jest.useFakeTimers();
  const { client, create, ledger } = setup(streaming, 2, "high");
  const deliver = (content: string, counts: unknown) => streaming ? streamOf([{ ...response(content, counts), choices: [{ delta: { content }, finish_reason: "stop" }] }]) : response(content, counts);
  create.mockResolvedValueOnce(deliver("", usage())).mockResolvedValueOnce(deliver("accepted", usage(200, 20)));
  const pending = client.chatCompletion("system", "user", true);
  await Promise.all([pending, jest.runAllTimersAsync()]);
  expect(create).toHaveBeenCalledTimes(2);
  const r = ledger.report();
  expect(r.full.ledger.map(a => [a.logical_call, a.outer_attempt, a.compatibility_attempt, a.trigger, a.outcome])).toEqual([
    [1, 1, 1, "initial", "empty"], [1, 2, 1, "outer-empty-retry", "accepted"],
  ]);
  expect(r.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 300, complete: true });
  expect(r.compact.metrics.completion_tokens.observed_sum).toBe(30);
  expect(r.compact.metrics.total_tokens.observed_sum).toBe(330);
  expect(create.mock.calls.every(([body]) => body.max_tokens === 2048 && body.reasoning.effort === "high" && !body.usageContext && !body.stream_options)).toBe(true);
});

test("UR07 blocking extraction failure preserves usage before malformed tool calls throw", async () => {
  const { client, create, ledger } = setup();
  create.mockResolvedValue({ ...response(), choices: [{ message: { tool_calls: { malformed: true } }, finish_reason: "stop" }] });
  await expect(client.chatCompletion("s", "u")).rejects.toThrow("filter is not a function");
  const r = ledger.report();
  expect(r.compact.attempts).toBe(1);
  expect(r.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 100, complete: true });
  expect(r.full.ledger[0]).toMatchObject({ outcome: "error", finish_reason: "stop" });
});

test("UR07 preceding work and SDK-preserved error usage survive without raw errors", async () => {
  const { client, create, ledger } = setup();
  create.mockResolvedValueOnce(response()).mockRejectedValueOnce(Object.assign(new Error("secret raw error"), { status: 401,
    error: { usage: { prompt_tokens: 5, completion_tokens: "invalid" }, private: "private body" } }));
  await client.chatCompletion("s", "u");
  await expect(client.chatCompletion("s", "u")).rejects.toThrow("secret raw error");
  const r = ledger.report();
  expect(r.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 105, nonfinal_attempts: 1, complete: false });
  expect(r.compact.metrics.completion_tokens).toMatchObject({ observed_sum: 10, unknown_attempts: 1 });
  expect(r.full.ledger.map(a => a.outcome)).toEqual(["accepted", "error"]);
  expect(JSON.stringify(r)).not.toMatch(/secret raw error|private body/);
});

test.each(["cumulative", "missing", "partial", "decreasing", "interrupted", "length interrupted", "zero"])("UR08 stream %s coverage", async kind => {
  const { client, create, ledger } = setup(true);
  let chunks: unknown[] = [{ model: "backend-one", choices: [{ delta: { content: "review" }, finish_reason: "stop" }], usage: usage(100, 5) }];
  let error: Error | undefined;
  if (kind === "cumulative") chunks.push({ usage: usage() }, { usage: usage() });
  if (kind === "missing") chunks = [{ choices: [{ delta: { content: "review" } }], usage: null }];
  if (kind === "partial") chunks.push({ usage: { prompt_tokens: 110 }, model: "backend-two" });
  if (kind === "decreasing") chunks.push({ usage: usage(90, 4) });
  if (kind.includes("interrupted")) error = new Error("synthetic interruption");
  if (kind === "length interrupted") chunks.push({ choices: [{ finish_reason: "length" }] });
  if (kind === "zero") chunks = [{ choices: [{ delta: { content: "review" } }], usage: usage(0, 0) }];
  create.mockResolvedValue(streamOf(chunks, error));
  if (error) {
    const pending = client.chatCompletion("s", "u");
    if (kind === "length interrupted") await expect(pending).rejects.toBeInstanceOf(CompletionLengthError);
    else await expect(pending).rejects.toThrow("synthetic interruption");
  } else await client.chatCompletion("s", "u");
  const r = ledger.report();
  expect(r.compact.attempts).toBe(1);
  const p = r.compact.metrics.prompt_tokens;
  expect(p.observed_sum).toBe(kind === "missing" ? null : kind === "partial" ? 110 : kind === "decreasing" ? 90 : kind === "zero" ? 0 : 100);
  expect(p.complete).toBe(!["missing", "decreasing", "interrupted", "length interrupted"].includes(kind));
  if (kind === "cumulative") expect(r.compact.metrics.completion_tokens.observed_sum).toBe(10);
  if (kind === "partial") {
    expect(r.compact.metrics.completion_tokens).toMatchObject({ observed_sum: 5, final_attempts: 0, nonfinal_attempts: 1 });
    expect(r.full.ledger[0].model_conflict).toBe(true);
  }
  if (kind === "missing") expect(r.full.ledger[0].reported_model).toBeNull();
  if (kind === "length interrupted") expect(r.full.ledger[0].outcome).toBe("length");
});

test("UR11 hostile observation cannot alter completion or lose surviving report sinks", async () => {
  const { client, create, ledger } = setup();
  let first = true;
  const payload = response();
  Object.defineProperty(payload, "model", { get() { if (first) { first = false; throw new Error("private getter error"); } return "actual-model"; } });
  create.mockResolvedValue(payload);
  expect((await client.chatCompletion("s", "u")).content).toBe("review");
  expect(ledger.report().compact.collector_incomplete).toBe(true);
});

async function withFiles(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "robin-usage-test-"));
  const previous = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = root;
  try { await fn(root); } finally {
    if (previous === undefined) delete process.env.RUNNER_TEMP; else process.env.RUNNER_TEMP = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("UR10 real Actions output/summary files and local ledger contain sanitized correlated observations", async () => {
  await withFiles(async root => {
    const actual = jest.requireActual<typeof core>("@actions/core");
    const oldOutput = process.env.GITHUB_OUTPUT, oldSummary = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_OUTPUT = join(root, "output"); process.env.GITHUB_STEP_SUMMARY = join(root, "summary");
    await writeFile(process.env.GITHUB_OUTPUT, ""); await writeFile(process.env.GITHUB_STEP_SUMMARY, "");
    jest.mocked(core.setOutput).mockImplementation(actual.setOutput);
    jest.mocked(core.summary.addRaw).mockImplementation(text => { actual.summary.addRaw(text); return core.summary; });
    jest.mocked(core.summary.write).mockImplementation(async () => { await actual.summary.write(); return core.summary; });
    try {
      const ledger = new UsageLedger(["credential-sentinel"]);
      ledger.configure({ repository: "owner/repo", pr_number: 7, head_sha: "a".repeat(40), head_provenance: "observed", command: "summary",
        requested_model: "model/credential-sentinel", requested_effort: { state: "configured", value: "<script>private</script>" }, run_id: "123", run_attempt: "2" });
      const a = ledger.begin({ phase: "summary" }, ledger.startCall(), 1, 1, "initial", { model: "safe-model", stream: false, effortRemoved: false });
      ledger.capture(a, { model: "<script>source-sentinel</script>", usage: usage(), reasoning_content: "private reasoning", content: "source sentinel" });
      ledger.received(a); ledger.finish(a, "accepted"); ledger.state = "completed";
      await publishUsageReport(ledger);
      const outputs = await readFile(process.env.GITHUB_OUTPUT, "utf8");
      const compact = JSON.parse(jest.mocked(core.setOutput).mock.calls.find(([name]) => name === "usage-report")![1]);
      const path = jest.mocked(core.setOutput).mock.calls.find(([name]) => name === "usage-report-path")![1];
      const full = JSON.parse(await readFile(path, "utf8"));
      const summary = await readFile(process.env.GITHUB_STEP_SUMMARY, "utf8");
      expect(full.metrics).toEqual(compact.metrics);
      expect(compact).toMatchObject({ head_provenance: "observed", run_id: "123", run_attempt: "2", requested_model: null, requested_effort: { value: null } });
      expect(summary).toContain("Hood of code review");
      expect(summary).toContain("&quot;schema_version&quot;");
      expect(summary).toContain("100 (0 missing, 0 nonfinal)");
      expect(outputs).toContain("usage-report<<");
      expect(JSON.stringify(full) + outputs + summary).not.toMatch(/credential-sentinel|source.sentinel|private reasoning|<script>/);
    } finally {
      actual.summary.emptyBuffer();
      for (const [name, previous] of [["GITHUB_OUTPUT", oldOutput], ["GITHUB_STEP_SUMMARY", oldSummary]]) {
        if (previous === undefined) delete process.env[name!]; else process.env[name!] = previous;
      }
      jest.mocked(core.setOutput).mockReset();
      jest.mocked(core.summary.addRaw).mockReset().mockReturnValue(core.summary);
      jest.mocked(core.summary.write).mockReset().mockResolvedValue(core.summary);
    }
  });
});

test.each(["file", "output", "summary"])("UR11 %s sink failure leaves other sinks available and never rejects", async sink => {
  await withFiles(async root => {
    if (sink === "file") process.env.RUNNER_TEMP = join(root, "missing", "directory");
    if (sink === "output") jest.mocked(core.setOutput).mockImplementation(() => { throw new Error("secret output error"); });
    if (sink === "summary") jest.mocked(core.summary.write).mockRejectedValueOnce(new Error("secret summary error"));
    await expect(publishUsageReport(new UsageLedger())).resolves.toBeUndefined();
    expect(core.summary.addRaw).toHaveBeenCalled();
    expect(core.setOutput).toHaveBeenCalledWith("usage-report", expect.any(String));
    if (sink !== "file") expect(core.setOutput).toHaveBeenCalledWith("usage-report-path", expect.any(String));
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("non-fatal"));
    expect(JSON.stringify(jest.mocked(core.warning).mock.calls)).not.toContain("secret");
    jest.mocked(core.setOutput).mockReset();
  });
});

test("UR12 oversized model grouping omits only compact details; full file and aggregates remain exact", async () => {
  const ledger = new UsageLedger();
  for (let i = 0; i < 500; i++) {
    const a = ledger.begin({ phase: "agent", agentTurn: i + 1 }, ledger.startCall(), 1, 1, "initial", { model: "requested", stream: false, effortRemoved: false });
    ledger.capture(a, { model: `model-${i}-${"x".repeat(100)}`, usage: usage(1, 1) });
    ledger.received(a); ledger.finish(a, "accepted");
  }
  const r = ledger.report();
  expect(Buffer.byteLength(JSON.stringify(r.compact))).toBeLessThanOrEqual(64 * 1024);
  expect(r.compact.model_groups_omitted).toBe(500);
  expect(r.compact.model_groups).toEqual([]);
  expect(r.full.model_groups).toHaveLength(500);
  expect(r.full.ledger).toHaveLength(500);
  expect(r.compact.metrics.prompt_tokens.observed_sum).toBe(500);
  await withFiles(async () => {
    await publishUsageReport(ledger);
    const path = jest.mocked(core.setOutput).mock.calls.find(([name]) => name === "usage-report-path")![1];
    const full = JSON.parse(await readFile(path, "utf8"));
    expect(full.ledger).toHaveLength(500);
    expect(full.metrics).toEqual(r.compact.metrics);
  });
});

test("UR10 sent effort records compatibility removal separately from requested effort", async () => {
  const { client, create, ledger } = setup(false, 1, "high");
  create.mockRejectedValueOnce(Object.assign(new Error("Unsupported parameter: reasoning is not supported with this model"), { status: 400 }))
    .mockResolvedValue(response());
  await client.chatCompletion("s", "u");
  await client.chatCompletion("s", "u");
  const r = ledger.report();
  expect(r.compact.requested_effort).toEqual({ state: "configured", value: "high" });
  expect(r.full.ledger.map(a => a.sent_effort)).toEqual([
    { state: "sent", field: "reasoning", value: "high" },
    { state: "removed-by-compatibility", field: null, value: null },
    { state: "removed-by-compatibility", field: null, value: null },
  ]);
  expect(r.full.ledger[0].compatibility_adjustment).toBe("reasoning");
  expect(r.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 200, unknown_attempts: 1 });
});

test.each(["off", "not-sent"])("UR10 effort %s is explicit without inventing provider effort", async state => {
  const ledger = new UsageLedger();
  ledger.configure({ requested_effort: { state: state === "off" ? "off" : "configured", value: state === "off" ? null : "high" } });
  const client = new LLMClient(state === "off" ? "https://provider.invalid/v1" : "https://api.anthropic.com/v1", "synthetic", "model", undefined, undefined, 1, undefined, undefined, state === "off" ? undefined : "high", ledger);
  (client as any).client = { chat: { completions: { create: jest.fn().mockResolvedValue(response()) } } };
  await client.chatCompletion("s", "u");
  expect(ledger.report().full.ledger[0].sent_effort).toEqual({ state, field: null, value: null });
});

test("UR10 provider objects cannot masquerade as finish reasons and URL identifiers stay unknown", () => {
  const ledger = new UsageLedger();
  ledger.configure({ requested_model: "https://provider.invalid/private" });
  const attempt = ledger.begin({ phase: "summary" }, ledger.startCall(), 1, 1, "initial", { model: "safe", stream: false, effortRemoved: false });
  ledger.capture(attempt, { choices: [{ finish_reason: { toString: () => "stop", private: "raw-object-sentinel" } }], usage: usage() });
  ledger.received(attempt); ledger.finish(attempt, "accepted");
  const report = ledger.report();
  expect(report.full.ledger[0].finish_reason).toBeNull();
  expect(report.compact.requested_model).toBeNull();
  expect(JSON.stringify(report)).not.toMatch(/raw-object-sentinel|https:\/\/provider/);
});

test("UR08 in-flight snapshots remain nonfinal even before attempt finalization", () => {
  const ledger = new UsageLedger();
  const a = ledger.begin({ phase: "agent" }, ledger.startCall(), 1, 1, "initial", { model: "model", stream: true, effortRemoved: false });
  ledger.capture(a, { usage: usage() });
  const r = ledger.report();
  expect(r.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 100, final_attempts: 0, nonfinal_attempts: 1, complete: false });
  expect(r.full.ledger[0].usage.prompt_tokens.final).toBe(false);
});
