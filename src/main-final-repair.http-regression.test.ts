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

// The SDK, agent, toolbox, parser and review flow run without mocks. Only synthetic data and
// credentials reach this loopback endpoint.
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const CONTEXT = "CONTEXT_OUTSIDE_THE_DIFF_9153";
const REPAIR_PROMPT =
  "Your previous reply could not be parsed as the required review. Do not call any tools. " +
  "Using the investigation so far, return only the single JSON object described in the system prompt, " +
  "with no markdown and no prose.";
const diff = [
  "diff --git a/src/first.ts b/src/first.ts",
  "--- a/src/first.ts", "+++ b/src/first.ts", "@@ -1 +1 @@",
  "-old", "+new line",
  "diff --git a/src/last.ts b/src/last.ts",
  "--- a/src/last.ts", "+++ b/src/last.ts", "@@ -1 +1 @@",
  "-old", "+last line", "",
].join("\n");

interface WireRequest {
  messages: { role: string; content?: string; tool_choice?: string }[];
  tools?: { function: { name: string } }[];
  tool_choice?: string;
  model: string;
}

interface Scenario {
  final: "parse" | "prose";
  repair?: "json" | "markdown" | "prose";
}

const findings = (marker: string) =>
  JSON.stringify({
    summary: `Synthetic review ${marker}.`,
    high: [],
    medium: [],
    low: [{ description: `${marker} describes the defect.`, file: "src/first.ts", line: 1 }],
    suggestions: [],
  });

function isRepair(body: WireRequest) {
  return body.messages.some(
    (message) => message.role === "user" && message.content === REPAIR_PROMPT
  );
}

async function execute(scenario: Scenario) {
  const previousTemp = process.env.RUNNER_TEMP;
  const reportRoot = await mkdtemp(join(tmpdir(), "robin-repair-usage-"));
  process.env.RUNNER_TEMP = reportRoot;
  const root = await mkdtemp(join(tmpdir(), "robin-repair-snapshot-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/context.ts"), `// ${CONTEXT}\n`);
  const cleanup = jest.fn(() => rm(root, { recursive: true, force: true }));
  jest.mocked(createRepoSnapshot).mockResolvedValue({ root, cleanup });

  const requests: WireRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireRequest;
      requests.push(body);
      res.setHeader("content-type", "application/json");
      const toolResult = body.messages.find((message) => message.role === "tool");
      const investigate = Boolean(body.tools) && !toolResult;
      let content: string;
      if (investigate) {
        content = "";
      } else if (!body.tools) {
        content = findings("STRUCTURED_RETRY_FINDING");
      } else if (isRepair(body)) {
        content =
          scenario.repair === "json"
            ? findings("REPAIR_JSON_FINDING")
            : scenario.repair === "markdown"
              ? "## High\n- src/first.ts:1 — REPAIR_MARKDOWN_FINDING describes the defect."
              : "again prose";
      } else {
        content = scenario.final === "parse" ? findings("FINAL_JSON_FINDING") : "oops";
      }
      res.end(
        JSON.stringify({
          id: "synthetic",
          object: "chat.completion",
          model: "reported-backend",
          usage: { prompt_tokens: requests.length * 100, completion_tokens: 10, total_tokens: requests.length * 100 + 10 },
          choices: [
            {
              index: 0,
              finish_reason: investigate ? "tool_calls" : "stop",
              message: investigate
                ? {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "context_call",
                        type: "function",
                        function: { name: "read_file", arguments: '{"path":"src/context.ts"}' },
                      },
                    ],
                  }
                : { role: "assistant", content },
            },
          ],
        })
      );
    });
  });

  (github.context as any).payload = {
    action: "opened",
    pull_request: { number: 7, base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } },
  };
  (github.context as any).eventName = "pull_request";
  const octokit = {
    request: jest.fn().mockResolvedValue({ data: diff }),
    paginate: jest.fn().mockResolvedValue([]),
    rest: {
      repos: {
        getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: "admin" } }),
        getContent: jest.fn().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 })),
      },
      pulls: {
        get: jest.fn().mockResolvedValue({ data: { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } } }),
        listFiles: jest.fn(),
        listReviews: jest.fn(),
        createReview: jest.fn().mockResolvedValue({ data: { id: 30 } }),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({ data: { id: 10 } }),
        updateComment: jest.fn().mockResolvedValue({}),
      },
    },
  };
  jest.mocked(github.getOctokit).mockReturnValue(octokit as any);
  const signals = new Map((["SIGTERM", "SIGINT"] as const).map((signal) => [signal, process.listeners(signal)]));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const inputs: Record<string, string> = {
      "github-token": "synthetic-github-key",
      "llm-api-key": "synthetic-loopback-key",
      "llm-base-url": `http://127.0.0.1:${port}/v1`,
      model: "synthetic-local-model",
      "max-output-tokens": "2048",
      "llm-timeout-ms": "2000",
      "agent-max-turns": "1",
      "agent-max-diff-size": String(diff.length),
      "max-diff-size": String(diff.length),
    };
    jest.mocked(core.getInput).mockImplementation((name) => inputs[name] || "");
    jest.mocked(core.getBooleanInput).mockReturnValue(false);
    jest.mocked(core.summary.addRaw).mockReturnValue(core.summary);
    jest.mocked(core.summary.write).mockResolvedValue(core.summary);
    await Promise.race([
      jest.isolateModulesAsync(async () => {
        const { actionCompletion } = await import("./main");
        await actionCompletion;
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Action did not finish")), 5000);
      }),
    ]);
    const reportPath = jest.mocked(core.setOutput).mock.calls.find(([name]) => name === "usage-report-path")?.[1];
    const fullReport = reportPath ? JSON.parse(await readFile(reportPath, "utf8")) : undefined;
    const lastStatus = octokit.rest.issues.updateComment.mock.calls.at(-1)?.[0].body as string | undefined;
    const reviewBody = octokit.rest.pulls.createReview.mock.calls.at(-1)?.[0].body as string | undefined;
    return { requests, octokit, cleanup, lastStatus, reviewBody, fullReport };
  } finally {
    if (previousTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousTemp;
    await rm(reportRoot, { recursive: true, force: true });
    jest.mocked(core.setOutput).mockReset();
    if (timeout) clearTimeout(timeout);
    for (const [signal, previous] of signals) {
      for (const listener of process.listeners(signal)) {
        if (!previous.includes(listener)) process.removeListener(signal, listener);
      }
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
}

const phases = (report: { ledger: Array<{ phase: string }> }) =>
  report.ledger.map((attempt) => attempt.phase);

beforeEach(() => {
  jest.clearAllMocks();
});

test("FR15a posts the review from the repaired answer without a structured retry", async () => {
  const result = await execute({ final: "prose", repair: "json" });

  expect(core.setFailed).not.toHaveBeenCalled();
  expect(result.requests).toHaveLength(3);
  expect(isRepair(result.requests[2])).toBe(true);
  expect(result.requests[2].tools).toBeDefined();
  expect(result.requests[2].tool_choice).toBe("none");
  expect(result.requests[2].messages).toContainEqual(
    expect.objectContaining({ role: "assistant", content: "oops" })
  );
  expect(phases(result.fullReport)).toEqual(["agent", "forced-final", "forced-final"]);
  expect(result.reviewBody).toContain("REPAIR_JSON_FINDING");
  expect(result.reviewBody).not.toContain("STRUCTURED_RETRY_FINDING");
  expect(result.lastStatus).toContain("agent review: 3 turns · 1 tool call");
  expect(result.fullReport.agent_activity).toMatchObject({ turns: 3, tool_calls: 1 });
  expect(result.cleanup).toHaveBeenCalledTimes(1);
});

test("FR15b falls back to today's structured retry when the repair also does not parse", async () => {
  const result = await execute({ final: "prose", repair: "prose" });

  expect(core.setFailed).not.toHaveBeenCalled();
  expect(result.requests).toHaveLength(4);
  expect(isRepair(result.requests[2])).toBe(true);
  expect(result.requests[3].tools).toBeUndefined();
  const retryPayload = JSON.stringify(result.requests[3].messages);
  expect(retryPayload).toContain("diff --git a/src/first.ts");
  expect(retryPayload).toContain("diff --git a/src/last.ts");
  expect(retryPayload).toContain("Return ONLY a single valid JSON object. Do not use markdown.");
  expect(phases(result.fullReport)).toEqual(["agent", "forced-final", "forced-final", "structured-retry"]);
  expect(result.reviewBody).toContain("STRUCTURED_RETRY_FINDING");
});

test("FR15c posts a finding from a repaired markdown answer", async () => {
  const result = await execute({ final: "prose", repair: "markdown" });

  expect(core.setFailed).not.toHaveBeenCalled();
  expect(result.requests).toHaveLength(3);
  expect(phases(result.fullReport)).toEqual(["agent", "forced-final", "forced-final"]);
  expect(result.reviewBody).toContain("REPAIR_MARKDOWN_FINDING");
  expect(result.reviewBody).not.toContain("STRUCTURED_RETRY_FINDING");
});

test("FR15d keeps today's requests when the forced final already parses", async () => {
  const result = await execute({ final: "parse" });

  expect(core.setFailed).not.toHaveBeenCalled();
  expect(result.requests).toHaveLength(2);
  expect(result.requests.some((body) => isRepair(body))).toBe(false);
  expect(phases(result.fullReport)).toEqual(["agent", "forced-final"]);
  expect(result.reviewBody).toContain("FINAL_JSON_FINDING");
  expect(result.lastStatus).toContain("agent review: 2 turns · 1 tool call");
  expect(result.fullReport.agent_activity).toMatchObject({ turns: 2, tool_calls: 1 });
});
