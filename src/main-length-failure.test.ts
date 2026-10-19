import * as core from "@actions/core";
import * as github from "@actions/github";
import { OpenAI } from "openai";
import { createRepoSnapshot } from "./repo-snapshot";
import { ReviewToolbox } from "./review-tools";

jest.mock("@actions/core");
jest.mock("@actions/github", () => ({
  getOctokit: jest.fn(),
  context: { eventName: "pull_request", repo: { owner: "fixture", repo: "repository" }, payload: {} },
}));
jest.mock("openai", () => ({ OpenAI: jest.fn() }));
jest.mock("./repo-snapshot");
jest.mock("./review-tools", () => ({
  ...jest.requireActual("./review-tools"),
  ReviewToolbox: jest.fn(),
}));

const clean = { summary: "Validated change.", high: [], medium: [], low: [], suggestions: [] };
const diff = "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+new\n";

function completion(finishReason = "stop") {
  return { choices: [{ message: { content: JSON.stringify(clean) }, finish_reason: finishReason }] };
}

async function execute(create: jest.Mock, diffError?: Error) {
  (github.context as any).payload = {
    action: "opened",
    pull_request: { number: 7, base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } },
  };
  jest.mocked(OpenAI).mockImplementation(() => ({ chat: { completions: { create } } }) as any);
  const cleanup = jest.fn().mockResolvedValue(undefined);
  jest.mocked(createRepoSnapshot).mockResolvedValue({ root: "/synthetic-snapshot", cleanup });
  const executeTool = jest.fn().mockResolvedValue("file contents");
  jest.mocked(ReviewToolbox).mockImplementation(() => ({
    execute: executeTool, describe: () => "read_file src/value.ts",
  }) as any);
  const octokit = {
    request: diffError ? jest.fn().mockRejectedValue(diffError) : jest.fn().mockResolvedValue({ data: diff }),
    paginate: jest.fn().mockResolvedValue([]),
    rest: {
      repos: { getContent: jest.fn().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 })) },
      pulls: {
        get: jest.fn().mockResolvedValue({ data: { base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } } }),
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
  const inputs: Record<string, string> = {
    "github-token": "synthetic-token", "llm-base-url": "https://provider.invalid/v1",
    model: "synthetic-model", "agent-mode": "auto", "agent-max-turns": "1",
  };
  jest.mocked(core.getInput).mockImplementation(name => inputs[name] || "");
  jest.mocked(core.getBooleanInput).mockReturnValue(false);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  jest.mocked(core.info).mockImplementation(message => { if (message === "Done.") finish(); });
  jest.mocked(core.setFailed).mockImplementation(() => finish());
  const signals = new Map((["SIGTERM", "SIGINT"] as const).map(signal => [signal, process.listeners(signal)]));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await jest.isolateModulesAsync(async () => { await import("./main"); });
    await Promise.race([done, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Action did not finish")), 5000);
    })]);
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const [signal, previous] of signals) {
      for (const listener of process.listeners(signal)) {
        if (!previous.includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
  return { octokit, cleanup, executeTool };
}

beforeEach(() => { jest.clearAllMocks(); });

test.each(["initial", "forced final"])("L5 %s agent length failure stops review and cleans the snapshot", async turn => {
  const create = jest.fn();
  if (turn === "forced final") create.mockResolvedValueOnce({ choices: [{
    finish_reason: "tool_calls", message: { content: "", tool_calls: [{
      id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"src/value.ts"}' },
    }] },
  }] });
  create.mockResolvedValueOnce(completion("length")).mockResolvedValue(completion());
  const { octokit, cleanup, executeTool } = await execute(create);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("finish_reason=length"));
  expect(create).toHaveBeenCalledTimes(turn === "initial" ? 1 : 2);
  expect(create.mock.calls.every(([request]) => request.tools?.length > 0)).toBe(true);
  if (turn === "forced final") {
    expect(create.mock.calls[1][0].tool_choice).toBe("none");
    expect(executeTool).toHaveBeenCalledTimes(1);
  } else expect(executeTool).not.toHaveBeenCalled();
  expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  expect(octokit.rest.issues.updateComment).toHaveBeenLastCalledWith(expect.objectContaining({
    body: expect.stringContaining("finish_reason=length"),
  }));
  const body = octokit.rest.issues.updateComment.mock.calls.at(-1)![0].body;
  expect(body).toContain("Check the model/provider's output and reasoning generation limits");
  expect(body).toContain("reduce the review scope");
  expect(body).toContain("If the input is too large");
  expect(body).toContain("smaller logically complete PRs");
  expect(body).toContain("After adjusting");
  expect(body).toContain("`/robin`");
  expect(body).not.toContain("Free model routes drop");
  expect(body).not.toContain("The review input exceeds");
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test.each([
  ["tools unsupported", 400, "Model does not support tools"],
  ["ordinary agent error", 401, "Unauthorized"],
])("L6 retains single-shot fallback for %s", async (_name, status, message) => {
  const create = jest.fn().mockRejectedValueOnce(Object.assign(new Error(message), { status })).mockResolvedValue(completion());
  const { octokit, cleanup } = await execute(create);
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0][0].tools).toBeDefined();
  expect(create.mock.calls[1][0].tools).toBeUndefined();
  expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledTimes(1);
});


test.each([
  [400, "maximum context length exceeded"],
  [413, "Request rejected"],
])("A2 context/input failure (%s) gives scope and capacity advice through the client wrapper", async (status, message) => {
  const create = jest.fn().mockRejectedValue(Object.assign(new Error(message), { status }));
  const { octokit, cleanup, executeTool } = await execute(create);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(message));
  expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  expect(executeTool).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledTimes(1);
  const body = octokit.rest.issues.updateComment.mock.calls.at(-1)![0].body;
  expect(body).toContain(message);
  expect(body).toContain("smaller logically complete PRs");
  expect(body).toContain("keep related implementation and tests together");
  expect(body).toContain("model/provider with larger effective context capacity");
  expect(body).toContain("After adjusting");
  expect(body).toContain("`/robin`");
  expect(body).not.toContain("Free model routes drop");
});

test("R2.1 GitHub diff rejection gets generic advice without LLM capacity diagnosis", async () => {
  const create = jest.fn();
  const error = Object.assign(new Error("GitHub diff acquisition rejected"), { status: 413 });
  const { octokit } = await execute(create, error);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(error.message));
  expect(create).not.toHaveBeenCalled();
  expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  const body = octokit.rest.issues.updateComment.mock.calls.at(-1)![0].body;
  expect(body).toContain(error.message);
  expect(body).toContain("Check the error above and resolve its cause, then comment `/robin` to try again.");
  expect(body).not.toContain("smaller logically complete PRs");
  expect(body).not.toContain("larger effective context capacity");
  expect(body).not.toContain("output and reasoning generation limits");
});

test.each(["Unauthorized", "Unauthorized: context window access denied"])(
  "A3 ordinary provider failure retains generic guidance: %s", async message => {
    const create = jest.fn().mockRejectedValue(Object.assign(new Error(message), { status: 401 }));
    const { octokit, cleanup } = await execute(create);
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
    const body = octokit.rest.issues.updateComment.mock.calls.at(-1)![0].body;
    expect(body).toContain(message);
    expect(body).toContain("Check the error above and resolve its cause, then comment `/robin` to try again.");
    expect(body).not.toContain("Free model routes drop");
    expect(body).not.toContain("smaller logically complete PRs");
    expect(body).not.toContain("output and reasoning generation limits");
    expect(body).not.toContain("The review input exceeds");
  }
);
