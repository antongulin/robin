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

/** A truncated turn whose output budget went to reasoning, as a provider reports it. */
function reasoningExhausted() {
  return {
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 50 },
    },
    choices: [{ message: { content: JSON.stringify(clean) }, finish_reason: "length" }],
  };
}

async function execute(create: jest.Mock) {
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
    request: jest.fn().mockResolvedValue({ data: diff }),
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
  const signals = new Map((["SIGTERM", "SIGINT"] as const).map(signal => [signal, process.listeners(signal)]));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([jest.isolateModulesAsync(async () => {
      const { actionCompletion } = await import("./main"); await actionCompletion;
    }), new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Action did not finish")), 5000);
    })]);
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const [signal, previous] of signals) {
      for (const listener of process.listeners(signal)) {
        if (!previous.includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
  return { octokit, cleanup };
}

beforeEach(() => { jest.clearAllMocks(); });

test("L3 names reasoning-exhausted output in the failure message and the status comment", async () => {
  const create = jest.fn().mockResolvedValue(reasoningExhausted());
  const { octokit, cleanup } = await execute(create);

  expect(create).toHaveBeenCalledTimes(1);
  expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("Reasoning used the whole output budget"));
  expect(core.setFailed).toHaveBeenCalledWith(
    expect.stringContaining("raise max-output-tokens or lower reasoning-effort")
  );
  expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();

  const body = octokit.rest.issues.updateComment.mock.calls.at(-1)![0].body as string;
  expect(body).toContain("Reasoning used the whole output budget");
  expect(body).toContain("raise max-output-tokens or lower reasoning-effort");
  expect(body).toContain("Check the model/provider's output and reasoning generation limits");
  expect(body.split("\n")).toContainEqual(
    expect.stringMatching(/^Reason: .*Reasoning used the whole output budget/)
  );
  expect(cleanup).toHaveBeenCalledTimes(1);
});
