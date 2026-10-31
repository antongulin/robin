import * as core from "@actions/core";
import * as github from "@actions/github";
import { OpenAI } from "openai";
import { createRepoSnapshot } from "./repo-snapshot";
import { ReviewToolbox } from "./review-tools";
import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

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

/**
 * Fail-closed input completeness: every model request path sends the complete filtered diff or
 * fails before its request. These cases use the existing offline OpenAI/snapshot/loopback-style
 * stubs; no live provider, GitHub, or customer service is contacted.
 */
const TAIL = "FINAL_REVIEWED_TAIL_SENTINEL";
const REVIEWED_LINE = "export const reviewable = true;";
const EXCLUDED_MARKER = "EXCLUDED_GENERATED_LOCK";

const CLEAN = JSON.stringify({
  summary: "Looks clean.",
  high: [],
  medium: [],
  low: [],
  suggestions: [],
});
const ONE_FINDING = JSON.stringify({
  summary: "One issue.",
  high: [],
  medium: [],
  low: [{ description: "Synthetic finding", file: "src/first.ts", line: 1 }],
  suggestions: [],
});

function added(path: string, text: string): string {
  const lines = text.trimEnd().split("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}\n`;
}

/** Small multi-file diff whose last line is the sentinel that proves the whole input was sent. */
function reviewableDiff(): string {
  return (
    added("src/first.ts", `${REVIEWED_LINE}\n`.repeat(20)) +
    added("src/zz-tail.ts", `// ${TAIL}\nexport const tail = true;\n`)
  );
}

/** The demonstrated shape: a diff far larger than the default single-shot cap. */
function oversizedDiff(): string {
  return (
    added("src/bulk.ts", `${REVIEWED_LINE}\n`.repeat(4_500)) +
    added("src/zz-tail.ts", `// ${TAIL}\nexport const tail = true;\n`)
  );
}

interface Scenario {
  diff: string;
  inputs?: Record<string, string>;
  create?: jest.Mock;
  snapshotError?: Error;
  snapshot?: Awaited<ReturnType<typeof createRepoSnapshot>>;
  updateCommentError?: Error;
  summaryCommand?: boolean;
  configFile?: string;
}

interface Result {
  requests: any[];
  payloads: string[];
  octokit: any;
  cleanup: jest.Mock;
  statusBodies: string[];
  lastStatus: string;
  comments: string[];
}

async function execute(scenario: Scenario): Promise<Result> {
  (github.context as any).eventName = scenario.summaryCommand ? "issue_comment" : "pull_request";
  (github.context as any).payload = scenario.summaryCommand
    ? {
        comment: { id: 5, body: "/summary", user: { login: "maintainer", type: "User" } },
        issue: { number: 7, pull_request: {} },
      }
    : {
        action: "opened",
        pull_request: {
          number: 7,
          user: { login: "contributor", type: "User" },
          base: { sha: "a".repeat(40) },
          head: { sha: "b".repeat(40) },
        },
      };

  const create = scenario.create ?? jest.fn().mockResolvedValue({
    choices: [{ message: { content: ONE_FINDING }, finish_reason: "stop" }],
  });
  jest.mocked(OpenAI).mockImplementation(() => ({ chat: { completions: { create } } }) as any);

  const cleanup = jest.fn(scenario.snapshot?.cleanup ?? (() => Promise.resolve()));
  if (scenario.snapshotError) {
    jest.mocked(createRepoSnapshot).mockRejectedValue(scenario.snapshotError);
  } else {
    jest.mocked(createRepoSnapshot).mockResolvedValue({ root: scenario.snapshot?.root ?? "/synthetic-snapshot", cleanup });
  }
  jest.mocked(ReviewToolbox).mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue("synthetic tool output"),
    describe: () => "read_file src/first.ts",
  }) as any);

  const octokit = {
    request: jest.fn().mockResolvedValue({ data: scenario.diff }),
    paginate: jest.fn().mockResolvedValue([]),
    rest: {
      pulls: {
        get: jest.fn().mockResolvedValue({
          data: { base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } },
        }),
        listFiles: jest.fn(),
        listReviews: jest.fn(),
        createReview: jest.fn().mockResolvedValue({ data: { id: 30 } }),
      },
      repos: {
        getContent: jest.fn().mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 })),
        getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: "write" } }),
      },
      issues: {
        createComment: jest.fn().mockResolvedValue({ data: { id: 10 } }),
        updateComment: scenario.updateCommentError
          ? jest.fn().mockRejectedValue(scenario.updateCommentError)
          : jest.fn().mockResolvedValue({}),
      },
      reactions: { createForIssueComment: jest.fn().mockResolvedValue({}) },
      actions: { listWorkflowRuns: jest.fn().mockResolvedValue({ data: { workflow_runs: [] } }) },
    },
  };
  jest.mocked(github.getOctokit).mockReturnValue(octokit as any);

  const inputs: Record<string, string> = {
    "github-token": "synthetic-token",
    "llm-api-key": "synthetic-key",
    "llm-base-url": "https://provider.invalid/v1",
    model: "synthetic-model",
    "max-diff-size": String(scenario.diff.length),
    "agent-mode": "off",
    "config-file": scenario.configFile ?? ".github/robin.yml",
    ...scenario.inputs,
  };
  jest.mocked(core.getInput).mockImplementation(name => inputs[name] || "");
  jest.mocked(core.getBooleanInput).mockReturnValue(false);

  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  jest.mocked(core.info).mockImplementation(message => {
    if (message === "Done." || message.startsWith("All changed files were skipped")) finish();
  });
  jest.mocked(core.setFailed).mockImplementation(() => finish());

  const signals = new Map((["SIGTERM", "SIGINT"] as const).map(signal => [signal, process.listeners(signal)]));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await jest.isolateModulesAsync(async () => { await import("./main"); });
    await Promise.race([done, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Action did not finish")), 5_000);
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

  const statusBodies: string[] = octokit.rest.issues.updateComment.mock.calls.map(
    (call: any[]) => call[0].body
  );
  const comments: string[] = octokit.rest.issues.createComment.mock.calls.map(
    (call: any[]) => call[0].body
  );
  return {
    requests: create.mock.calls.map((call: any[]) => call[0]),
    payloads: create.mock.calls.map((call: any[]) => JSON.stringify(call[0].messages)),
    octokit,
    cleanup,
    statusBodies,
    lastStatus: statusBodies.at(-1) ?? "",
    comments,
  };
}

beforeEach(() => { jest.clearAllMocks(); });

describe("single-shot review input completeness", () => {
  it("COV-02: a diff exactly at max-diff-size is sent complete", async () => {
    const diff = reviewableDiff();
    const result = await execute({ diff, inputs: { "max-diff-size": String(diff.length) } });

    expect(result.requests).toHaveLength(1);
    expect(result.payloads[0]).toContain(TAIL);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(result.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(result.lastStatus).toContain("Review done.");
  });

  it("COV-02: one character over max-diff-size sends no model request and fails", async () => {
    const diff = reviewableDiff();
    const result = await execute({ diff, inputs: { "max-diff-size": String(diff.length - 1) } });

    expect(result.requests).toHaveLength(0);
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("max-diff-size"));
    const failure = jest.mocked(core.setFailed).mock.calls[0][0] as string;
    expect(failure).toContain("single-shot review");
    expect(failure).toContain(`${diff.length} characters`);
    expect(failure).toContain(`allows ${diff.length - 1} characters`);
    expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(result.lastStatus).toContain("single-shot review");
    expect(result.lastStatus).toContain(`${diff.length} characters`);
    expect(result.lastStatus).toContain(`allows ${diff.length - 1} characters`);
    expect(result.lastStatus).toContain("Raise `max-diff-size`");
    expect(result.lastStatus).toContain("split the change into smaller logically complete PRs");
    expect(result.lastStatus).not.toContain(TAIL);
    expect(result.lastStatus).not.toContain(REVIEWED_LINE);
    expect(result.lastStatus).not.toContain("/synthetic-snapshot");
    expect(result.lastStatus).not.toContain("token");
  });

  it("COV-04: filtered-out files do not count toward the cap and the remaining diff is sent", async () => {
    const reviewable = reviewableDiff();
    const diff = added("pnpm-lock.yaml", EXCLUDED_MARKER.repeat(500)) + reviewable;
    expect(diff.length).toBeGreaterThan(reviewable.length);

    const result = await execute({ diff, inputs: { "max-diff-size": String(reviewable.length) } });

    expect(result.requests).toHaveLength(1);
    expect(result.payloads[0]).toContain(TAIL);
    expect(result.payloads[0]).not.toContain(EXCLUDED_MARKER);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(result.lastStatus).toContain("Review done.");
  });

  it("COV-04: an all-ignored diff keeps the skipped status without a model request", async () => {
    const diff =
      added("pnpm-lock.yaml", EXCLUDED_MARKER.repeat(50)) +
      added("dist/index.js", "generated bundle\n".repeat(50));

    const result = await execute({ diff });

    expect(result.requests).toHaveLength(0);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(result.lastStatus).toContain("only ignored paths changed");
  });
});

describe("oversized single-shot review", () => {
  it("COV-05: fails before the request with an actionable failed status and no successful review", async () => {
    const diff = oversizedDiff();
    expect(diff.length).toBeGreaterThan(50_000);

    const result = await execute({ diff, inputs: { "max-diff-size": "50000" } });

    expect(result.requests).toHaveLength(0);
    expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    const failure = jest.mocked(core.setFailed).mock.calls[0][0] as string;
    expect(failure).toContain("single-shot review");
    expect(failure).toContain(`${diff.length} characters`);
    expect(failure).toContain("`max-diff-size` allows 50000 characters");
    expect(result.lastStatus).not.toContain("Review done.");
    expect(result.lastStatus).toContain("couldn't finish the review");
    expect(result.lastStatus).toContain(`${diff.length} characters`);
    expect(result.lastStatus).toContain("Raise `max-diff-size`");
    expect(result.lastStatus).toContain("an unchanged retry cannot succeed");
    expect(result.lastStatus).not.toContain(TAIL);
    expect(result.lastStatus).not.toContain(REVIEWED_LINE);
  });

  it("COV-05: the failing action persists when the status comment update throws", async () => {
    const diff = oversizedDiff();
    const result = await execute({
      diff,
      inputs: { "max-diff-size": "50000" },
      updateCommentError: new Error("synthetic status write failure"),
    });

    expect(result.requests).toHaveLength(0);
    expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledTimes(1);
    expect(jest.mocked(core.setFailed).mock.calls[0][0]).toContain("max-diff-size");
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("Could not update status comment"));
  });
});

describe("normal complete input", () => {
  it("COV-06: a below-cap review sends the complete diff and keeps the normal conclusion", async () => {
    const diff = reviewableDiff();
    const result = await execute({ diff, inputs: { "max-diff-size": String(diff.length * 2) } });

    expect(result.requests).toHaveLength(1);
    expect(result.payloads[0]).toContain(TAIL);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(result.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(result.lastStatus).toContain("Review done.");
    expect(result.lastStatus).toContain("I flagged 1 thing worth a look.");
    expect(result.lastStatus).not.toContain("max-diff-size");
  });

  it("COV-06: a below-cap summary sends the complete diff and posts the summary", async () => {
    const diff = reviewableDiff();
    const result = await execute({
      diff,
      summaryCommand: true,
      inputs: { "max-diff-size": String(diff.length * 2), "agent-mode": "" },
      create: jest.fn().mockResolvedValue({
        choices: [{ message: { content: "Synthetic summary of the complete diff." }, finish_reason: "stop" }],
      }),
    });

    expect(result.requests).toHaveLength(1);
    expect(result.payloads[0]).toContain(TAIL);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    expect(result.comments).toHaveLength(2);
    expect(result.comments[1]).toContain("Synthetic summary of the complete diff.");
    expect(createRepoSnapshot).not.toHaveBeenCalled();
    expect(ReviewToolbox).not.toHaveBeenCalled();
    expect(result.requests[0].tools).toBeUndefined();
    expect(result.lastStatus).toContain("Summary's ready above.");
    expect(result.lastStatus).not.toContain("max-diff-size");
  });
});

describe("agent mode input completeness", () => {
  it("COV-07: an agent input over agent-max-diff-size fails before the agent request", async () => {
    const diff = reviewableDiff();
    const result = await execute({
      diff,
      inputs: {
        "agent-mode": "auto",
        "agent-max-diff-size": String(diff.length - 1),
        "max-diff-size": String(diff.length + 500),
      },
    });

    expect(result.requests).toHaveLength(0);
    expect(createRepoSnapshot).not.toHaveBeenCalled();
    expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    const failure = jest.mocked(core.setFailed).mock.calls[0][0] as string;
    expect(failure).toContain("agent review");
    expect(failure).toContain("`agent-max-diff-size` allows");
    expect(result.lastStatus).toContain("agent review");
    expect(result.lastStatus).toContain("Raise `agent-max-diff-size`");
    expect(result.lastStatus).not.toContain("Review done.");
    expect(result.lastStatus).not.toContain(TAIL);
  });

  it("COV-07: a complete agent input exceeding only the unused single-shot cap stays eligible", async () => {
    const diff = reviewableDiff();
    const result = await execute({
      diff,
      inputs: {
        "agent-mode": "auto",
        "agent-max-diff-size": String(diff.length),
        "max-diff-size": "100",
      },
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].tools).toBeDefined();
    expect(result.payloads[0]).toContain(TAIL);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(result.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(result.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("agent fallback input completeness", () => {
  it("COV-08: a snapshot failure fails instead of sending a cut-off single-shot diff", async () => {
    const diff = reviewableDiff();
    const result = await execute({
      diff,
      inputs: {
        "agent-mode": "auto",
        "agent-max-diff-size": String(diff.length + 500),
        "max-diff-size": String(diff.length - 1),
      },
      snapshotError: new Error("synthetic snapshot download failure"),
    });

    expect(result.requests).toHaveLength(0);
    expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    const failure = jest.mocked(core.setFailed).mock.calls[0][0] as string;
    expect(failure).toContain("single-shot review");
    expect(failure).toContain("repository snapshot unavailable");
    expect(failure).toContain("`max-diff-size` allows");
    expect(result.lastStatus).toContain("Raise `max-diff-size`");
  });

  it.each([
    [400, "Model does not support tools", "model has no tool support"],
    [401, "Unauthorized", "agent review failed"],
  ])("COV-08: %s fallback failure reports the cap and cleans up the snapshot", async (status, message, reason) => {
    const diff = reviewableDiff();
    const create = jest.fn().mockRejectedValueOnce(
      Object.assign(new Error(message), { status })
    );
    const root = await mkdtemp(join(tmpdir(), "robin-input-limit-"));
    try {
      const result = await execute({
        diff,
        create,
        snapshot: { root, cleanup: () => rm(root, { recursive: true, force: true }) },
        inputs: {
          "agent-mode": "auto",
          "agent-max-diff-size": String(diff.length + 500),
          "max-diff-size": String(diff.length - 1),
        },
      });

      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].tools).toBeDefined();
      expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining(reason));
      expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("`max-diff-size` allows"));
      expect(result.lastStatus).toContain("Raise `max-diff-size`");
      expect(result.lastStatus).not.toContain("Review done.");
      expect(result.cleanup).toHaveBeenCalledTimes(1);
      await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("COV-08: a fallback whose full input fits max-diff-size still completes", async () => {
    const diff = reviewableDiff();
    const result = await execute({
      diff,
      inputs: {
        "agent-mode": "auto",
        "agent-max-diff-size": String(diff.length + 500),
        "max-diff-size": String(diff.length),
      },
      snapshotError: new Error("synthetic snapshot download failure"),
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].tools).toBeUndefined();
    expect(result.payloads[0]).toContain(TAIL);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(result.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(result.lastStatus).toContain("diff-only review (repository snapshot unavailable)");
  });
});

describe("summary input completeness", () => {
  it("COV-09: an oversized summary fails before the provider and posts no summary", async () => {
    const diff = oversizedDiff();
    const result = await execute({
      diff,
      summaryCommand: true,
      inputs: { "max-diff-size": "50000", "agent-mode": "" },
    });

    expect(result.requests).toHaveLength(0);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).not.toContain(TAIL);
    expect(result.lastStatus).not.toContain("Summary's ready above.");
    expect(result.lastStatus).toContain("couldn't finish the summary");
    expect(createRepoSnapshot).not.toHaveBeenCalled();
    expect(ReviewToolbox).not.toHaveBeenCalled();
    expect(result.lastStatus).toContain("summary");
    expect(result.lastStatus).toContain(`${diff.length} characters`);
    expect(result.lastStatus).toContain("Raise `max-diff-size`");
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("`max-diff-size` allows 50000"));
  });
});

describe("structured JSON retry input completeness", () => {
  const unparsed = { choices: [{ message: { content: "no issues" }, finish_reason: "stop" }] };

  it("RTRY-01: a retry never downgrades an agent review to a smaller cut-off input", async () => {
    const diff = reviewableDiff();
    const create = jest.fn().mockResolvedValue(unparsed);
    const result = await execute({
      diff,
      create,
      inputs: {
        "agent-mode": "auto",
        "agent-max-diff-size": String(diff.length + 500),
        "max-diff-size": String(diff.length - 1),
      },
    });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0].tools).toBeDefined();
    expect(result.payloads[0]).toContain(TAIL);
    expect(result.octokit.rest.pulls.createReview).not.toHaveBeenCalled();
    const failure = jest.mocked(core.setFailed).mock.calls[0][0] as string;
    expect(failure).toContain("structured JSON retry");
    expect(failure).toContain("`max-diff-size` allows");
  });

  it("RTRY-01: a sufficient cap retries with the complete diff", async () => {
    const diff = reviewableDiff();
    const create = jest.fn()
      .mockResolvedValueOnce(unparsed)
      .mockResolvedValueOnce({ choices: [{ message: { content: ONE_FINDING }, finish_reason: "stop" }] });
    const result = await execute({ diff, create });

    expect(result.requests).toHaveLength(2);
    for (const payload of result.payloads) expect(payload).toContain(TAIL);
    expect(result.payloads[1]).toContain("Return ONLY a single valid JSON object");
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(result.octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
    expect(result.lastStatus).toContain("Review done.");
  });
});
