import * as core from "@actions/core";
import * as github from "@actions/github";
import { OpenAI } from "openai";
import { createRepoSnapshot } from "./repo-snapshot";
import { ReviewToolbox } from "./review-tools";
import { annotateDiffWithLineNumbers } from "./diff-annotate";
import { buildAgentReviewInput } from "./agent-review";
import { ROBIN_SIGNATURE } from "./brand";

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

jest.setTimeout(15_000);

const clean = { summary: "Validated change.", high: [], medium: [], low: [], suggestions: [] };
const diff = [
  "diff --git a/src/value.ts b/src/value.ts",
  "--- a/src/value.ts",
  "+++ b/src/value.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);

interface ExecuteOptions {
  experiment?: string;
  agentMode?: string;
  reviews?: Array<Record<string, unknown>>;
  comments?: Array<Record<string, unknown>>;
  compareFiles?: string[];
}

interface WireRequest {
  messages: Array<{ role: string; content?: string }>;
  tools?: Array<{ function: { name: string } }>;
}

function robinReview(id: number, commit: string, submittedAt: string) {
  return {
    id,
    body: `## Findings summary\n\n<!-- ${ROBIN_SIGNATURE} -->`,
    submitted_at: submittedAt,
    commit_id: commit,
    user: { login: "robin[bot]", type: "Bot" },
    state: "COMMENTED",
  };
}

function completion() {
  return {
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    choices: [{ message: { content: JSON.stringify(clean) }, finish_reason: "stop" }],
  };
}

async function execute(options: ExecuteOptions = {}) {
  (github.context as any).payload = {
    action: "opened",
    pull_request: { number: 7, base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } },
  };
  const create = jest.fn().mockResolvedValue(completion());
  jest.mocked(OpenAI).mockImplementation(() => ({ chat: { completions: { create } } }) as any);
  const cleanup = jest.fn().mockResolvedValue(undefined);
  jest.mocked(createRepoSnapshot).mockResolvedValue({ root: "/synthetic-snapshot", cleanup });
  jest.mocked(ReviewToolbox).mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue("file contents"),
    describe: () => "read_file src/value.ts",
  }) as any);

  const listReviews = jest.fn();
  const listReviewComments = jest.fn();
  const compareCommitsWithBasehead = jest.fn().mockResolvedValue({
    data: { files: (options.compareFiles ?? []).map((filename) => ({ filename })) },
  });
  const paginate = jest.fn(async (method: jest.Mock) =>
    method === listReviews ? options.reviews ?? [] : method === listReviewComments ? options.comments ?? [] : []
  );
  const octokit = {
    request: jest.fn().mockResolvedValue({ data: diff }),
    paginate,
    rest: {
      repos: {
        getContent: jest.fn().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 })),
        compareCommitsWithBasehead,
      },
      pulls: {
        get: jest.fn().mockResolvedValue({ data: { base: { sha: BASE_SHA }, head: { sha: HEAD_SHA } } }),
        listFiles: jest.fn(),
        listReviews,
        listReviewComments,
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
    "github-token": "synthetic-token",
    "llm-base-url": "https://provider.invalid/v1",
    model: "synthetic-model",
    "agent-mode": options.agentMode ?? "auto",
    "agent-max-turns": "4",
  };
  jest.mocked(core.getInput).mockImplementation((name) => inputs[name] || "");
  jest.mocked(core.getBooleanInput).mockReturnValue(false);

  const previousExperiment = process.env.ROBIN_EXPERIMENT;
  process.env.ROBIN_EXPERIMENT = options.experiment ?? "";
  const signals = new Map(
    (["SIGTERM", "SIGINT"] as const).map((signal) => [signal, process.listeners(signal)])
  );
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      jest.isolateModulesAsync(async () => {
        const { actionCompletion } = await import("./main");
        await actionCompletion;
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Action did not finish")), 5000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (previousExperiment === undefined) delete process.env.ROBIN_EXPERIMENT;
    else process.env.ROBIN_EXPERIMENT = previousExperiment;
    for (const [signal, previous] of signals) {
      for (const listener of process.listeners(signal)) {
        if (!previous.includes(listener)) process.removeListener(signal, listener);
      }
    }
  }

  const requests = create.mock.calls.map(([request]) => request as WireRequest);
  const firstModelOrder = create.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
  const reviewFetchOrders = paginate.mock.calls
    .map(([method], index) => ({ method, order: paginate.mock.invocationCallOrder[index] }))
    .filter((entry) => entry.method === listReviews)
    .map((entry) => entry.order);
  return {
    create,
    requests,
    listReviews,
    listReviewComments,
    compareCommitsWithBasehead,
    paginate,
    octokit,
    agentInput: () => requests[0].messages[1].content ?? "",
    reviewFetches: () => paginate.mock.calls.filter(([method]) => method === listReviews).length,
    reviewFetchesBeforeModel: () => reviewFetchOrders.filter((order) => order < firstModelOrder).length,
    commentFetches: () => paginate.mock.calls.filter(([method]) => method === listReviewComments).length,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ROBIN_EXPERIMENT;
});

describe("rereview-memory wiring", () => {
  test("M1 the earlier-rounds block follows an attachment section", () => {
    const input = buildAgentReviewInput(
      annotateDiffWithLineNumbers(diff),
      ["src/value.ts"],
      "---\nCHANGED FILES AT THE PR HEAD",
      "---\nEARLIER ROBIN REVIEWS ON THIS PULL REQUEST"
    );

    expect(input.indexOf("CHANGED FILES AT THE PR HEAD")).toBeLessThan(
      input.indexOf("EARLIER ROBIN REVIEWS ON THIS PULL REQUEST")
    );
    expect(input.indexOf("CODE DIFF:")).toBeLessThan(input.indexOf("CHANGED FILES AT THE PR HEAD"));
  });

  test("M1 switch off makes no earlier-round calls and keeps today's input", async () => {
    const run = await execute({
      reviews: [robinReview(100, BASE_SHA, "2026-11-20T10:00:00Z")],
      comments: [
        {
          id: 1001,
          pull_request_review_id: 100,
          path: "src/value.ts",
          line: 1,
          body: "**Robin** — :warning: MEDIUM\n\nOld finding.",
          created_at: "2026-11-20T10:05:00Z",
        },
      ],
      compareFiles: ["src/value.ts"],
    });

    // The existing stale-review dismissal check runs once after posting; rereview-memory adds none.
    expect(run.reviewFetchesBeforeModel()).toBe(0);
    expect(run.reviewFetches()).toBe(1);
    expect(run.commentFetches()).toBe(0);
    expect(run.compareCommitsWithBasehead).not.toHaveBeenCalled();
    expect(run.agentInput()).toBe(
      buildAgentReviewInput(annotateDiffWithLineNumbers(diff), ["src/value.ts"])
    );
    expect(run.agentInput()).not.toContain("EARLIER ROBIN REVIEWS");
    expect(core.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Experiment rereview-memory")
    );
  });

  test("M2 switch on without an earlier Robin review keeps the input and says so", async () => {
    const run = await execute({
      experiment: "rereview-memory",
      reviews: [
        {
          id: 9,
          body: "Looks good.",
          submitted_at: "2026-11-20T09:00:00Z",
          commit_id: BASE_SHA,
          user: { login: "maintainer", type: "User" },
        },
      ],
      compareFiles: ["src/value.ts"],
    });

    // One rereview-memory collection plus the existing stale-review dismissal check.
    expect(run.reviewFetchesBeforeModel()).toBe(1);
    expect(run.reviewFetches()).toBe(2);
    expect(run.commentFetches()).toBe(0);
    expect(run.compareCommitsWithBasehead).not.toHaveBeenCalled();
    expect(run.agentInput()).toBe(
      buildAgentReviewInput(annotateDiffWithLineNumbers(diff), ["src/value.ts"])
    );
    expect(core.info).toHaveBeenCalledWith("Experiment rereview-memory: no earlier Robin review.");
  });

  test("M3 switch on appends the earlier-rounds block after the diff and logs the counts", async () => {
    const run = await execute({
      experiment: "rereview-memory",
      reviews: [robinReview(100, BASE_SHA, "2026-11-20T10:00:00Z")],
      comments: [
        {
          id: 1001,
          pull_request_review_id: 100,
          path: "src/value.ts",
          line: 1,
          body: "**Robin** — :rotating_light: HIGH\n\nThe guard is missing.\n\n**Recommendation:** add it.",
          created_at: "2026-11-20T10:05:00Z",
        },
        {
          id: 1002,
          pull_request_review_id: null,
          in_reply_to_id: 1001,
          path: "src/value.ts",
          line: 1,
          body: "Fixed in the latest push.",
          created_at: "2026-11-20T11:00:00Z",
        },
      ],
      compareFiles: ["src/value.ts"],
    });

    expect(run.reviewFetchesBeforeModel()).toBe(1);
    expect(run.reviewFetches()).toBe(2);
    expect(run.commentFetches()).toBe(1);
    expect(run.compareCommitsWithBasehead).toHaveBeenCalledWith(
      expect.objectContaining({ basehead: `${BASE_SHA}...${HEAD_SHA}` })
    );
    const input = run.agentInput();
    expect(input).toContain("EARLIER ROBIN REVIEWS ON THIS PULL REQUEST");
    expect(input.indexOf("CODE DIFF:")).toBeLessThan(input.indexOf("EARLIER ROBIN REVIEWS"));
    expect(input).toContain("- [round 1] HIGH src/value.ts:1 — The guard is missing.");
    expect(input).toContain("  Reply: Fixed in the latest push.");
    expect(input).toContain("Files changed since then: src/value.ts");
    expect(core.info).toHaveBeenCalledWith(
      "Experiment rereview-memory: 1 earlier findings from 1 rounds."
    );
    expect(run.requests[0].tools?.length).toBeGreaterThan(0);
  });

  test("M8 the single-shot path makes no calls when the switch is on", async () => {
    const run = await execute({
      experiment: "rereview-memory",
      agentMode: "off",
      reviews: [robinReview(100, BASE_SHA, "2026-11-20T10:00:00Z")],
      comments: [
        {
          id: 1001,
          pull_request_review_id: 100,
          path: "src/value.ts",
          line: 1,
          body: "**Robin** — :warning: MEDIUM\n\nOld finding.",
          created_at: "2026-11-20T10:05:00Z",
        },
      ],
    });

    // Only the existing stale-review dismissal check; the agent-only collection never runs.
    expect(run.reviewFetchesBeforeModel()).toBe(0);
    expect(run.reviewFetches()).toBe(1);
    expect(run.commentFetches()).toBe(0);
    expect(run.compareCommitsWithBasehead).not.toHaveBeenCalled();
    expect(run.requests[0].tools).toBeUndefined();
    expect(run.requests[0].messages[1].content ?? "").not.toContain("EARLIER ROBIN REVIEWS");
    expect(core.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Experiment rereview-memory")
    );
    expect(run.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });
});
