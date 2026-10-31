import * as http from "http";
import { AddressInfo } from "net";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { createRepoSnapshot } from "./repo-snapshot";

jest.mock("@actions/core");
jest.mock("@actions/github", () => ({
  getOctokit: jest.fn(),
  context: { eventName: "pull_request", repo: { owner: "fixture", repo: "repository" }, payload: {} },
}));
jest.mock("./repo-snapshot");

jest.setTimeout(30_000);

// The SDK, resolver, agent, toolbox, parser and review/status flow run without mocks.
// Only synthetic data and credentials reach this loopback endpoint.
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const CONTEXT = "CONTEXT_OUTSIDE_THE_DIFF_7319";
const FIRST = "FIRST_FILE_MARKER";
const TAIL = "FINAL_DIFF_TAIL_MARKER";
const diff = [
  "diff --git a/src/first.ts b/src/first.ts",
  "--- a/src/first.ts", "+++ b/src/first.ts", "@@ -1 +1 @@",
  "-old", `+${FIRST}`,
  "diff --git a/src/last.ts b/src/last.ts",
  "--- a/src/last.ts", "+++ b/src/last.ts", "@@ -1 +1 @@",
  "-old", `+${TAIL}`, "",
].join("\n");

interface WireRequest {
  messages: { role: string; content?: string; tool_call_id?: string }[];
  tools?: { function: { name: string } }[];
  max_tokens?: number;
  max_completion_tokens?: number;
  model: string;
}

interface Scenario {
  input?: string;
  diff?: string;
  defaultProfile?: boolean;
  overrides?: Record<string, string>;
  headConfig?: string;
  config?: string;
  rejectTools?: boolean;
  singleShotCap?: number;
  agentFailure?: boolean;
  structuredRetry?: boolean;
  summary?: boolean;
  issueComment?: boolean;
  sinkFailure?: boolean;
  terminalFailure?: boolean;
  postingFailure?: boolean;
  noObservedHead?: boolean;
  reportedModel?: string;
}

async function execute(scenario: Scenario = {}) {
  const reviewDiff = scenario.diff ?? diff;
  const previousTemp = process.env.RUNNER_TEMP;
  const reportRoot = await mkdtemp(join(tmpdir(), "robin-usage-action-"));
  process.env.RUNNER_TEMP = reportRoot;
  const root = await mkdtemp(join(tmpdir(), "robin-auto-default-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/context.ts"), `// ${CONTEXT}\n`);
  const cleanup = jest.fn(() => rm(root, { recursive: true, force: true }));
  jest.mocked(createRepoSnapshot).mockResolvedValue({ root, cleanup });

  const requests: WireRequest[] = [];
  const credentials: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest;
      requests.push(body);
      credentials.push(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      if (body.tools && scenario.rejectTools) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: {
          message: "synthetic-local-model does not support tools",
          type: "invalid_request_error", param: "tools", code: "unsupported_parameter",
        } }));
        return;
      }
      const toolResult = body.messages.find(message => message.role === "tool");
      if ((scenario.agentFailure && body.tools && toolResult) || scenario.terminalFailure) {
        res.writeHead(401); res.end(JSON.stringify({ error: { message: "synthetic terminal failure", type: "authentication_error" } })); return;
      }
      const investigate = body.tools && !toolResult;
      const content = JSON.stringify({
        summary: "Synthetic review.", high: [], medium: [],
        low: [{ description: toolResult?.content?.includes(CONTEXT)
          ? `Context checked: ${CONTEXT}` : "Synthetic diff-only finding.",
        file: "src/first.ts", line: 1 }], suggestions: [],
      });
      res.end(JSON.stringify({
        id: "synthetic", object: "chat.completion", model: scenario.reportedModel ?? "reported-backend",
        usage: { prompt_tokens: requests.length * 100, completion_tokens: requests.length * 10, total_tokens: requests.length * 110 },
        choices: [{ index: 0, finish_reason: investigate ? "tool_calls" : "stop", message: investigate
          ? { role: "assistant", content: null, tool_calls: [{ id: "context_call", type: "function",
            function: { name: "read_file", arguments: '{"path":"src/context.ts"}' } }] }
          : { role: "assistant", content: scenario.structuredRetry && requests.length === 1 ? "unparseable response" : content } }],
      }));
    });
  });

  (github.context as any).payload = {
    action: "opened",
    pull_request: { number: 7, base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } },
  };
  (github.context as any).eventName = scenario.issueComment || scenario.summary ? "issue_comment" : "pull_request";
  if (scenario.issueComment || scenario.summary) (github.context as any).payload = {
    action: "created", issue: { number: 7, pull_request: {} },
    comment: { body: scenario.summary ? "/summary" : "/review", user: { login: "maintainer", type: "User" } },
  };
  const octokit = {
    request: jest.fn().mockResolvedValue({ data: reviewDiff }),
    paginate: jest.fn().mockResolvedValue([]),
    rest: {
      repos: { getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: "admin" } }), getContent: jest.fn(async ({ path, ref }: { path: string; ref: string }) => {
        if (path === ".github/robin.yml" && ref === BASE_SHA && scenario.config !== undefined) {
          return { data: { content: Buffer.from(scenario.config).toString("base64") } };
        }
        if (path === ".github/robin.yml" && ref === HEAD_SHA && scenario.headConfig !== undefined) {
          return { data: { content: Buffer.from(scenario.headConfig).toString("base64") } };
        }
        throw Object.assign(new Error("Not found"), { status: 404 });
      }) },
      pulls: {
        get: jest.fn().mockResolvedValue({ data: { base: { sha: BASE_SHA }, head: scenario.noObservedHead ? undefined : { sha: HEAD_SHA } } }),
        listFiles: jest.fn(), listReviews: jest.fn(),
        createReview: scenario.postingFailure ? jest.fn().mockRejectedValue(new Error("synthetic posting failure")) : jest.fn().mockResolvedValue({ data: { id: 30 } }),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({ data: { id: 10 } }),
        updateComment: jest.fn().mockResolvedValue({}),
      },
    },
  };
  jest.mocked(github.getOctokit).mockReturnValue(octokit as any);
  const signals = new Map((["SIGTERM", "SIGINT"] as const).map(signal => [signal, process.listeners(signal)]));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const inputs: Record<string, string> = {
      "github-token": "synthetic-github-key", "llm-api-key": "synthetic-loopback-key",
      "llm-base-url": `http://127.0.0.1:${port}/v1`, model: "synthetic-local-model",
      "max-output-tokens": "2048", "llm-timeout-ms": "2000", "agent-max-turns": "3",
      "agent-max-diff-size": String(reviewDiff.length),
      "max-diff-size": String(scenario.singleShotCap ?? reviewDiff.length),
    };
    if (scenario.defaultProfile) {
      delete inputs["agent-max-diff-size"]; delete inputs["max-diff-size"]; delete inputs["max-output-tokens"];
    }
    Object.assign(inputs, scenario.overrides);
    if (scenario.input !== undefined) inputs["agent-mode"] = scenario.input;
    jest.mocked(core.getInput).mockImplementation(name => inputs[name] || "");
    jest.mocked(core.getBooleanInput).mockReturnValue(false);
    jest.mocked(core.summary.addRaw).mockReturnValue(core.summary);
    jest.mocked(core.summary.write).mockResolvedValue(core.summary);
    if (scenario.sinkFailure) {
      jest.mocked(core.summary.write).mockRejectedValueOnce(new Error("private reporting failure"));
      jest.mocked(core.setOutput).mockImplementation(() => { throw new Error("private output failure"); });
    }
    await Promise.race([jest.isolateModulesAsync(async () => {
      const { actionCompletion } = await import("./main");
      await actionCompletion;
    }), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Action did not finish")), 5000);
    })]);
    const rawReport = jest.mocked(core.setOutput).mock.calls.find(([name]) => name === "usage-report")?.[1];
    const usageReport = rawReport ? JSON.parse(rawReport) : undefined;
    const reportPath = jest.mocked(core.setOutput).mock.calls.find(([name]) => name === "usage-report-path")?.[1];
    const fullReport = reportPath ? JSON.parse(await readFile(reportPath, "utf8")) : undefined;
    const lastStatus = octokit.rest.issues.updateComment.mock.calls.at(-1)?.[0].body as string | undefined;
    return { requests, credentials, octokit, cleanup, lastStatus, usageReport, fullReport };
  } finally {
    if (previousTemp === undefined) delete process.env.RUNNER_TEMP; else process.env.RUNNER_TEMP = previousTemp;
    await rm(reportRoot, { recursive: true, force: true });
    jest.mocked(core.setOutput).mockReset();
    if (timeout) clearTimeout(timeout);
    for (const [signal, previous] of signals) {
      for (const listener of process.listeners(signal)) {
        if (!previous.includes(listener)) process.removeListener(signal, listener);
      }
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

function expectCompleteDiff(request: WireRequest) {
  const payload = JSON.stringify(request.messages);
  for (const marker of ["diff --git a/src/first.ts", "diff --git a/src/last.ts", "@@ -1 +1 @@", FIRST, TAIL]) {
    expect(payload).toContain(marker);
  }
  expect(request.max_tokens ?? request.max_completion_tokens).toBe(2048);
}

beforeEach(() => { jest.clearAllMocks(); });

test("ID1 omitted API key preserves local model identifiers and the Ollama wire placeholder", async () => {
  const metadata = await readFile(join(__dirname, "..", "action.yml"), "utf8");
  const apiKeySection = metadata.slice(metadata.indexOf("  llm-api-key:"), metadata.indexOf("  llm-base-url:"));
  const declaredDefault = apiKeySection.match(/^\s+default: "(.*)"$/m)?.[1];
  expect(declaredDefault).toBeDefined();
  const result = await execute({ input: "off", reportedModel: "ollama/backend",
    overrides: { "llm-api-key": declaredDefault!, model: "ollama/local-model" } });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(result.credentials).toEqual(["Bearer ollama"]);
  expect(result.requests).toHaveLength(1);
  expect(result.usageReport).toMatchObject({ requested_model: null, model_groups: [], model_groups_omitted: 1 });
  expect(result.fullReport.requested_model).toBe("ollama/local-model");
  expect(result.fullReport.ledger[0]).toMatchObject({ sent_model: "ollama/local-model", reported_model: "ollama/backend" });
  expect(result.fullReport.model_groups[0].reported_model).toBe("ollama/backend");
  expect(result.usageReport.metrics).toEqual(result.fullReport.metrics);
  expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("ollama/local-model"));
  expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("ollama/backend"));
});

test.each([
  ["llm-api-key", "keyabc"],
  ["llm-api-key", "ollama"],
  ["github-token", "ghxyz"],
])("ID2 explicit %s value %s remains suppressed in usage reports", async (input, secret) => {
  const result = await execute({ input: "off", reportedModel: `${secret}/backend`,
    overrides: { [input]: secret, model: `${secret}/local-model` } });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(result.credentials).toEqual([`Bearer ${input === "llm-api-key" ? secret : "synthetic-loopback-key"}`]);
  expect(result.requests).toHaveLength(1);
  expect(result.usageReport.requested_model).toBeNull();
  expect(result.fullReport.requested_model).toBeNull();
  expect(result.fullReport.ledger[0]).toMatchObject({ sent_model: null, reported_model: null });
  expect(JSON.stringify({ compact: result.usageReport, full: result.fullReport,
    summary: jest.mocked(core.summary.addRaw).mock.calls })).not.toContain(secret);
});

test.each([
  ["missing config", undefined, undefined],
  ["empty config and blank input", "", ""],
])("AD-01 unset mode investigates repository context: %s", async (_name, config, input) => {
  const result = await execute({ config, input });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(createRepoSnapshot).toHaveBeenCalledWith(result.octokit, "fixture", "repository", HEAD_SHA);
  expect(result.requests).toHaveLength(2);
  expect(result.requests[0].tools?.map(tool => tool.function.name).sort()).toEqual(["grep", "list_files", "read_file"]);
  expectCompleteDiff(result.requests[0]);
  expect(JSON.stringify(result.requests[0].messages)).not.toContain(CONTEXT);
  expect(result.requests[1].messages).toContainEqual(expect.objectContaining({
    role: "tool", tool_call_id: "context_call", content: expect.stringContaining(CONTEXT),
  }));
  expect(result.octokit.rest.pulls.createReview).toHaveBeenCalledWith(expect.objectContaining({
    body: expect.stringContaining(CONTEXT),
  }));
  expect(result.lastStatus).toContain("agent review: 2 turns · 1 tool call");
  expect(result.cleanup).toHaveBeenCalledTimes(1);
  expect(result.credentials).toEqual(["Bearer synthetic-loopback-key", "Bearer synthetic-loopback-key"]);
});

test.each([
  ["base off with blank input", "", "off", false],
  ["input off overrides base auto", "off", "auto", false],
  ["input auto overrides base off", "auto", "off", true],
])("AD-02 %s", async (_name, input, config, agent) => {
  const result = await execute({ input, config: `agent-mode: ${config}\n` });
  expect(result.octokit.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({
    path: ".github/robin.yml", ref: BASE_SHA,
  }));
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(result.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  expectCompleteDiff(result.requests[0]);
  if (agent) {
    expect(createRepoSnapshot).toHaveBeenCalledTimes(1);
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0].tools).toBeDefined();
    expect(result.lastStatus).toContain("agent review: 2 turns · 1 tool call");
    expect(result.cleanup).toHaveBeenCalledTimes(1);
  } else {
    expect(createRepoSnapshot).not.toHaveBeenCalled();
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].tools).toBeUndefined();
    expect(result.requests[0].messages.some(message => message.role === "tool")).toBe(false);
    expect(result.lastStatus).toContain("diff-only review (agent mode off)");
    expect(result.cleanup).not.toHaveBeenCalled();
  }
});

test.each([false, true])("AD-04 tool rejection keeps complete diff fallback bounded (over cap: %s)", async overCap => {
  const result = await execute({ rejectTools: true, singleShotCap: diff.length - Number(overCap) });
  expect(result.requests[0].tools).toBeDefined();
  expectCompleteDiff(result.requests[0]);
  expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("does not support tool"));
  expect(result.cleanup).toHaveBeenCalledTimes(1);
  if (overCap) {
    expect(result.requests).toHaveLength(1);
    expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("max-diff-size"));
    expect(result.lastStatus).toContain(`${diff.length} characters`);
    expect(result.lastStatus).toContain(`\`max-diff-size\` allows ${diff.length - 1}`);
    expect(result.lastStatus).toContain("model has no tool support");
    expect(result.lastStatus).toContain("Raise `max-diff-size`");
    expect(result.lastStatus).not.toContain("Review done.");
  } else {
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(result.requests).toHaveLength(2);
    expect(result.requests[1].tools).toBeUndefined();
    expectCompleteDiff(result.requests[1]);
    expect(result.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(result.lastStatus).toContain("diff-only review (model has no tool support)");
  }
});


test("R2-U1 filtered early return publishes skipped zero-attempt reports", async () => {
  const r = await execute({ config: "skip-paths:\n  - src/**\n" });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(r.requests).toHaveLength(0);
  expect(createRepoSnapshot).not.toHaveBeenCalled();
  expect(r.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  expect(r.usageReport).toMatchObject({ state: "skipped", attempts: 0, logical_calls: 0, phases: {} });
  for (const metric of ["prompt_tokens", "completion_tokens", "total_tokens", "cached_input_tokens", "reasoning_tokens"]) {
    expect(r.usageReport.metrics[metric]).toMatchObject({ observed_sum: null, observed_attempts: 0, unknown_attempts: 0 });
  }
  expect(r.fullReport).toMatchObject({ state: "skipped", attempts: 0, logical_calls: 0, ledger: [] });
  expect(r.fullReport.metrics).toEqual(r.usageReport.metrics);
  expect(core.summary.addRaw).toHaveBeenCalledWith(expect.stringContaining("0 physical requests; 0 logical calls."));
  expect(core.summary.write).toHaveBeenCalled();
  expect(r.lastStatus).toContain("Skipped: src/first.ts, src/last.ts");
});

test("UR05 prior tool work survives agent failure and complete diff fallback", async () => {
  const r = await execute({ agentFailure: true });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(r.requests).toHaveLength(3);
  expectCompleteDiff(r.requests[2]);
  expect(r.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  expect(r.cleanup).toHaveBeenCalledTimes(1);
  expect(r.fullReport.ledger.map((a: any) => [a.phase, a.outcome])).toEqual([["agent", "accepted"], ["agent", "error"], ["diff-only-fallback", "accepted"]]);
  expect(r.usageReport.metrics.prompt_tokens).toMatchObject({ observed_sum: 400, unknown_attempts: 1, complete: false });
});

test("UR06 structured retry retains both complete requests and exports their usage", async () => {
  const r = await execute({ input: "off", structuredRetry: true });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(r.requests).toHaveLength(2);
  r.requests.forEach(expectCompleteDiff);
  expect(r.fullReport.ledger.map((a: any) => a.phase)).toEqual(["single-shot-initial", "structured-retry"]);
  expect(r.usageReport.metrics.prompt_tokens.observed_sum).toBe(300);
  expect(r.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
});

test("UR06/UR10 issue-comment summary records observed head, one request, and no repository tools", async () => {
  const r = await execute({ summary: true });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(r.requests).toHaveLength(1);
  expect(r.requests[0].tools).toBeUndefined();
  expect(r.fullReport.ledger[0].phase).toBe("summary");
  expect(r.usageReport).toMatchObject({ head_sha: HEAD_SHA, head_provenance: "observed", command: "summary", state: "completed" });
  expect(r.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  expect(createRepoSnapshot).not.toHaveBeenCalled();
});

test("UR10 event head and configured/sent/reported facts remain distinct", async () => {
  const r = await execute({ input: "off" });
  expect(r.usageReport).toMatchObject({ head_sha: HEAD_SHA, head_provenance: "event", requested_model: null, model_groups: [], model_groups_omitted: 1,
    requested_effort: { state: "unset", value: null } });
  expect(r.fullReport.requested_model).toBe("synthetic-local-model");
  expect(r.fullReport.ledger[0]).toMatchObject({ sent_model: "synthetic-local-model", reported_model: "reported-backend", sent_effort: { state: "unset", field: null, value: null } });
  expect(r.fullReport.model_groups[0]).toMatchObject({ sent_model: "synthetic-local-model", reported_model: "reported-backend" });
  expect(r.fullReport.metrics).toEqual(r.usageReport.metrics);
});

test.each([false, true])("UR11 sink failures preserve action verdict and snapshot cleanup (provider failure %s)", async terminalFailure => {
  const r = await execute({ sinkFailure: true, terminalFailure });
  expect(r.cleanup).toHaveBeenCalledTimes(1);
  if (terminalFailure) {
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("synthetic terminal failure"));
    expect(core.setFailed).not.toHaveBeenCalledWith(expect.stringContaining("private reporting failure"));
    expect(r.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  } else {
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(r.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  }
  expect(r.usageReport.state).toBe(terminalFailure ? "failed" : "completed");
  expect(core.summary.write).toHaveBeenCalled();
});

test("UR07 usage remains available after GitHub posting failure", async () => {
  const r = await execute({ postingFailure: true });
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("synthetic posting failure"));
  expect(r.usageReport.state).toBe("failed");
  expect(r.usageReport.metrics.prompt_tokens.observed_sum).toBe(300);
  expect(r.cleanup).toHaveBeenCalledTimes(1);
});


test("UR10 unavailable observed PR head stays null and does not use the Actions SHA", async () => {
  (github.context as any).sha = "c".repeat(40);
  const r = await execute({ summary: true, noObservedHead: true });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(r.requests).toHaveLength(1);
  expect(r.usageReport).toMatchObject({ head_sha: null, head_provenance: null, state: "completed" });
});


function sizedDiff(size: number, unicode = false) {
  const prefix = "diff --git a/src/first.ts b/src/first.ts\n--- a/src/first.ts\n+++ b/src/first.ts\n@@ -1 +1 @@\n-old\n+";
  const suffix = `FINAL_COMPLETE_HUNK_${TAIL}\n`;
  return prefix + (unicode ? "界" : "x").repeat(size - prefix.length - suffix.length) + suffix;
}

test.each(["auto", "off"])("RB05 original 239722-character complete diff reaches provider under defaults: %s", async input => {
  const original = sizedDiff(239722);
  expect(original).toHaveLength(239722);
  const result = await execute({ input, diff: original, defaultProfile: true });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(result.requests).toHaveLength(input === "auto" ? 2 : 1);
  for (const body of result.requests) {
    expect(JSON.stringify(body.messages)).toContain(`FINAL_COMPLETE_HUNK_${TAIL}`);
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(32000);
    expect(Math.ceil(Buffer.byteLength(JSON.stringify(body, null, 2), "utf8") / 3) + 32000 + 16000).toBeLessThanOrEqual(256000);
  }
});

test.each(["max-diff-size", "agent-max-diff-size"])("RB05 explicit old 50000 caller %s rejects original full diff", async setting => {
  const result = await execute({ input: setting === "max-diff-size" ? "off" : "auto", diff: sizedDiff(239722),
    defaultProfile: true, overrides: { [setting]: "50000" } });
  expect(result.requests).toHaveLength(0);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("50000"));
});

test.each([false, true])("RB05 raw-eligible full body can fail independently (Unicode=%s)", async unicode => {
  const result = await execute({ input: "off", diff: unicode ? sizedDiff(239722, true) : diff,
    defaultProfile: true, overrides: unicode ? {} : { "review-instructions": "instructions".repeat(70000) } });
  expect(result.requests).toHaveLength(0);
  expect(result.usageReport.attempts).toBe(0);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("Estimated request budget exceeded"));
  expect(result.lastStatus).not.toContain("instructionsinstructions");
});

test("RB01 base config and explicit budget precedence; head config cannot change policy", async () => {
  const failed = await execute({ input: "off", defaultProfile: true,
    config: 'estimated-request-token-budget: "100" # too small', headConfig: 'estimated-request-token-budget: off' });
  expect(failed.requests).toHaveLength(0);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("budget 100"));
  jest.clearAllMocks();
  const passed = await execute({ input: "off", defaultProfile: true,
    config: 'estimated-request-token-budget: 100', overrides: { "estimated-request-token-budget": "off" } });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(passed.requests).toHaveLength(1);
  expect(passed.requests[0].max_tokens ?? passed.requests[0].max_completion_tokens).toBeUndefined();
});

test.each(["estimated-request-token-budget", "max-output-tokens"])("RB01 malformed %s fails before dispatch without echo", async setting => {
  const result = await execute({ defaultProfile: true, overrides: { [setting]: "900_secret_invalid" } });
  expect(result.requests).toHaveLength(0);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(`Invalid ${setting}`));
  expect(JSON.stringify(jest.mocked(core.setFailed).mock.calls)).not.toContain("900_secret_invalid");
});

test("RB03 /summary uses the same preflight and has zero physical attempts on rejection", async () => {
  const result = await execute({ summary: true, defaultProfile: true, overrides: { "estimated-request-token-budget": "100" } });
  expect(result.requests).toHaveLength(0);
  expect(result.usageReport.attempts).toBe(0);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("Estimated request budget exceeded"));
});

test.each(["auto", "off"])("RB05 default raw 500000 equality and +1 remain complete-or-fail: %s", async input => {
  const fitting = await execute({ input, defaultProfile: true, diff: sizedDiff(500000) });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(fitting.requests.length).toBeGreaterThan(0);
  for (const body of fitting.requests) expect(JSON.stringify(body.messages)).toContain(`FINAL_COMPLETE_HUNK_${TAIL}`);
  jest.clearAllMocks();
  const rejected = await execute({ input, defaultProfile: true, diff: sizedDiff(500001) });
  expect(rejected.requests).toHaveLength(0);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("allows 500000 characters"));
});

test("RB03 structured retry is guarded against its actual extra instruction and retains earlier usage", async () => {
  const first = await execute({ input: "off", structuredRetry: true });
  const inputEstimate = Math.ceil(Buffer.byteLength(JSON.stringify(first.requests[0], null, 2), "utf8") / 3);
  const budget = Math.ceil((inputEstimate + 2048) * 16 / 15);
  expect(inputEstimate + 2048 + Math.ceil(budget / 16)).toBeLessThanOrEqual(budget);
  jest.clearAllMocks();
  const result = await execute({ input: "off", structuredRetry: true, overrides: { "estimated-request-token-budget": String(budget) } });
  expect(result.requests).toHaveLength(1);
  expect(result.usageReport.attempts).toBe(1);
  expect(result.usageReport.metrics.prompt_tokens.observed_sum).toBe(100);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("Estimated request budget exceeded"));
});

test("RB03 budget-rejected agent can use only a fitting complete single-shot fallback", async () => {
  const baseline = await execute({ input: "off", overrides: { "use-json-response-mode": "false" } });
  const inputEstimate = Math.ceil(Buffer.byteLength(JSON.stringify(baseline.requests[0], null, 2), "utf8") / 3);
  const budget = Math.ceil((inputEstimate + 2048) * 16 / 15);
  jest.clearAllMocks();
  const result = await execute({ input: "auto", overrides: { "estimated-request-token-budget": String(budget), "use-json-response-mode": "false" } });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0].tools).toBeUndefined();
  expectCompleteDiff(result.requests[0]);
  expect(result.fullReport.ledger.map((a: any) => a.phase)).toEqual(["diff-only-fallback"]);
  expect(result.cleanup).toHaveBeenCalledTimes(1);
});
