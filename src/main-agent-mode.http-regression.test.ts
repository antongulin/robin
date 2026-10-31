import * as http from "http";
import { AddressInfo } from "net";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
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
  config?: string;
  rejectTools?: boolean;
  singleShotCap?: number;
}

async function execute(scenario: Scenario = {}) {
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
      const investigate = body.tools && !toolResult;
      const content = JSON.stringify({
        summary: "Synthetic review.", high: [], medium: [],
        low: [{ description: toolResult?.content?.includes(CONTEXT)
          ? `Context checked: ${CONTEXT}` : "Synthetic diff-only finding.",
        file: "src/first.ts", line: 1 }], suggestions: [],
      });
      res.end(JSON.stringify({
        id: "synthetic", object: "chat.completion", model: body.model,
        choices: [{ index: 0, finish_reason: investigate ? "tool_calls" : "stop", message: investigate
          ? { role: "assistant", content: null, tool_calls: [{ id: "context_call", type: "function",
            function: { name: "read_file", arguments: '{"path":"src/context.ts"}' } }] }
          : { role: "assistant", content } }],
      }));
    });
  });

  (github.context as any).payload = {
    action: "opened",
    pull_request: { number: 7, base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } },
  };
  const octokit = {
    request: jest.fn().mockResolvedValue({ data: diff }),
    paginate: jest.fn().mockResolvedValue([]),
    rest: {
      repos: { getContent: jest.fn(async ({ path, ref }: { path: string; ref: string }) => {
        if (path === ".github/robin.yml" && ref === BASE_SHA && scenario.config !== undefined) {
          return { data: { content: Buffer.from(scenario.config).toString("base64") } };
        }
        throw Object.assign(new Error("Not found"), { status: 404 });
      }) },
      pulls: {
        get: jest.fn().mockResolvedValue({ data: { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } } }),
        listFiles: jest.fn(), listReviews: jest.fn(),
        createReview: jest.fn().mockResolvedValue({ data: { id: 30 } }),
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
      "agent-max-diff-size": String(diff.length),
      "max-diff-size": String(scenario.singleShotCap ?? diff.length),
    };
    if (scenario.input !== undefined) inputs["agent-mode"] = scenario.input;
    jest.mocked(core.getInput).mockImplementation(name => inputs[name] || "");
    jest.mocked(core.getBooleanInput).mockReturnValue(false);
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    jest.mocked(core.info).mockImplementation(message => { if (message === "Done.") finish(); });
    jest.mocked(core.setFailed).mockImplementation(() => finish());
    await jest.isolateModulesAsync(async () => { await import("./main"); });
    await Promise.race([done, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Action did not finish")), 5000);
    })]);
    await Promise.resolve();
    await Promise.resolve();
    const lastStatus = octokit.rest.issues.updateComment.mock.calls.at(-1)![0].body as string;
    return { requests, credentials, octokit, cleanup, lastStatus };
  } finally {
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
