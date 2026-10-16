import * as core from "@actions/core";
import * as github from "@actions/github";
import { LLMClient } from "./llm-client";

jest.mock("@actions/core");
jest.mock("@actions/github", () => ({
  getOctokit: jest.fn(),
  context: { eventName: "pull_request", repo: { owner: "fixture", repo: "repository" }, payload: {} },
}));
jest.mock("./llm-client", () => ({
  ...jest.requireActual("./llm-client"),
  LLMClient: jest.fn(),
}));

const diff = "diff --git a/src/value.ts b/src/value.ts\n--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-old\n+new\n";
const clean = { summary: "Validated change.", high: [], medium: [], low: [], suggestions: [] };
const finding = {
  description: "Invalid input reaches storage.", recommendation: "Validate before saving.",
  severity: "medium", category: "correctness",
};

function expectBrandedBody(body: string, suffix = ""): void {
  expect(body).toMatch(/^## <a href="https:\/\/www\.robinreview\.dev\/">/);
  expect(body).toContain('width="24" height="24" alt="" /> The Robin</a> Hood of code review' + suffix + "\n\n");
  expect(body.match(/<img\b/g)).toHaveLength(1);
  expect(body.match(/<a\b/g)).toHaveLength(1);
  expect(body.match(/<!-- :bow_and_arrow: Robin -->/g)).toHaveLength(1);
  expect(body.replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(/:bow_and_arrow:|🏹/);
}

async function execute(options: {
  command?: "review" | "summary" | "help";
  diff?: string;
  content?: string;
  failure?: string;
  skip?: boolean;
} = {}) {
  const command = options.command || "review";
  const context = github.context as any;
  context.eventName = command === "review" ? "pull_request" : "issue_comment";
  context.payload = {
    action: "opened",
    pull_request: { number: 7, base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } },
    issue: { number: 7, pull_request: {} },
    comment: { id: 20, body: "/" + command, user: { type: "User", login: "maintainer" } },
  };
  const chatCompletion = options.failure
    ? jest.fn().mockRejectedValue(new Error(options.failure))
    : jest.fn().mockResolvedValue({ content: options.content ?? JSON.stringify(clean) });
  jest.mocked(LLMClient).mockImplementation(() => ({
    chatCompletion, getReasoningFallbackReason: () => undefined,
  }) as any);
  const octokit = {
    request: jest.fn().mockResolvedValue({ data: options.diff ?? diff }),
    paginate: jest.fn().mockResolvedValue([]),
    rest: {
      repos: {
        getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: "write" } }),
        getContent: jest.fn().mockImplementation(async ({ path }) => {
          if (path === ".github/robin.yml") return { data: {
            content: Buffer.from("agent-mode: off\n" + (options.skip ? "skip-paths:\n  - src/**\n" : "")).toString("base64"),
          } };
          throw Object.assign(new Error("Not found"), { status: 404 });
        }),
      },
      pulls: {
        get: jest.fn().mockResolvedValue({ data: { base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } } }),
        listFiles: jest.fn(), listReviews: jest.fn(),
        createReview: jest.fn().mockResolvedValue({ data: { id: 30 } }),
      },
      reactions: { createForIssueComment: jest.fn().mockResolvedValue({}) },
      issues: {
        createComment: jest.fn().mockResolvedValue({ data: { id: 10 } }),
        updateComment: jest.fn().mockResolvedValue({}),
      },
    },
  };
  jest.mocked(github.getOctokit).mockReturnValue(octokit as any);
  const inputs: Record<string, string> = {
    "github-token": "synthetic-github-token", "llm-base-url": "https://provider.invalid/v1",
    model: "synthetic-model", "agent-mode": "off",
  };
  jest.mocked(core.getInput).mockImplementation(name => inputs[name] || "");
  jest.mocked(core.getBooleanInput).mockReturnValue(false);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  jest.mocked(core.info).mockImplementation(message => {
    if (message === "Done." || message === "Posted help comment.") finish();
  });
  jest.mocked(core.setFailed).mockImplementation(() => finish());
  octokit.rest.issues.updateComment.mockImplementation(async () => {
    // Empty/skipped paths return after this terminal write without logging Done.
    if (options.skip || options.diff?.trim() === "") finish();
    return {};
  });
  const oldSignals = new Map((["SIGTERM", "SIGINT"] as const).map(signal => [signal, process.listeners(signal)]));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await jest.isolateModulesAsync(async () => { await import("./main"); });
    await Promise.race([done, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Action did not finish")), 5000);
    })]);
    // Let run() finish its finally/close continuation before removing owned listeners.
    await Promise.resolve();
    await Promise.resolve();
  } finally {
    if (timeout) clearTimeout(timeout);
    for (const [signal, previous] of oldSignals) {
      for (const listener of process.listeners(signal)) {
        if (!previous.includes(listener)) process.removeListener(signal, listener);
      }
    }
  }
  return { octokit, chatCompletion };
}

const environmentKeys = ["GITHUB_RUN_ID", "GITHUB_RUN_NUMBER", "GITHUB_ACTION_REPOSITORY"];
let savedEnvironment: (string | undefined)[];
beforeEach(() => {
  jest.clearAllMocks();
  savedEnvironment = environmentKeys.map(key => process.env[key]);
  environmentKeys.forEach(key => { delete process.env[key]; });
});
afterEach(() => {
  environmentKeys.forEach((key, index) => {
    if (savedEnvironment[index] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[index];
  });
});

test.each([false, true])("B4 review lifecycle preserves initial and final details (findings: %s)", async hasFindings => {
  const { octokit, chatCompletion } = await execute({
    content: JSON.stringify({ ...clean, medium: hasFindings ? [finding] : [] }),
  });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(chatCompletion).toHaveBeenCalledTimes(1);
  expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  const initial = octokit.rest.issues.createComment.mock.calls[0][0] as any;
  expectBrandedBody(initial.body);
  expect(initial.body).toContain(":eyes: On it");
  expect(initial.body).toContain("Mode: code review\nModel: synthetic-model\nRobin: v");
  const final = (octokit.rest.issues.updateComment.mock.calls.at(-1) as any)[0];
  expectBrandedBody(final.body);
  expect(final).toMatchObject({ owner: "fixture", repo: "repository", comment_id: 10 });
  expect(final.body).toContain(hasFindings ? "I flagged 1 thing worth a look." : "Nothing worth flagging — looks clean to me.");
  expect(final.body).toContain(":white_check_mark: Review done.");
  expect(final.body).toContain("comment `/robin` for another pass.");
  expect(final.body).toContain("diff-only review (agent mode off)");
  const review = octokit.rest.pulls.createReview.mock.calls[0][0] as any;
  expectBrandedBody(review.body);
  expect(review.body).toContain(hasFindings ? finding.description : "**No issues found**");
});

test("B4 summary publishes its distinct result and completes the original status", async () => {
  const { octokit, chatCompletion } = await execute({ command: "summary", content: "Adds validation before storage." });
  expect(core.setFailed).not.toHaveBeenCalled();
  expect(chatCompletion).toHaveBeenCalledTimes(1);
  expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(2);
  const [initial, result] = octokit.rest.issues.createComment.mock.calls.map(([request]) => request as any);
  expectBrandedBody(initial.body);
  expect(initial.body).toContain("Mode: summary");
  expectBrandedBody(result.body, " · Summary");
  expect(result.body).toContain("Adds validation before storage.");
  const final = (octokit.rest.issues.updateComment.mock.calls.at(-1) as any)[0];
  expectBrandedBody(final.body);
  expect(final.body).toContain(":white_check_mark: Summary's ready above.");
  expect(final.body).toContain("Want the full review? Comment `/robin`.");
  expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
});

test.each(["", " \n\t"])("B5 empty diff %j posts failure without calling the provider", async empty => {
  const { octokit, chatCompletion } = await execute({ diff: empty });
  expect(chatCompletion).not.toHaveBeenCalled();
  expect(LLMClient).not.toHaveBeenCalled();
  expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  const final = (octokit.rest.issues.updateComment.mock.calls.at(-1) as any)[0];
  expectBrandedBody(final.body);
  expect(final.body).toContain("Reason: No diff found for this pull request.");
  expect(final.body).toContain("comment `/robin` to try again.");
  expect(final.body).toMatch(/Robin v[0-9.]+ · local action/);
});

test("B5 skipped files retain explanation and config guidance without a result", async () => {
  const { octokit, chatCompletion } = await execute({ skip: true });
  expect(chatCompletion).not.toHaveBeenCalled();
  expect(LLMClient).not.toHaveBeenCalled();
  expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  const final = (octokit.rest.issues.updateComment.mock.calls.at(-1) as any)[0];
  expectBrandedBody(final.body);
  expect(final.body).toContain(":white_check_mark: Nothing to review here — only ignored paths changed.");
  expect(final.body).toContain("Skipped: src/value.ts");
  expect(final.body).toContain("Add `skip-paths` in `.github/robin.yml`");
});

test.each(["review", "summary"] as const)("B5 %s provider failure cannot publish success", async command => {
  const { octokit, chatCompletion } = await execute({ command, failure: "Provider unavailable" });
  expect(chatCompletion).toHaveBeenCalledTimes(1);
  expect(core.setFailed).toHaveBeenCalledWith("Provider unavailable");
  expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
  const final = (octokit.rest.issues.updateComment.mock.calls.at(-1) as any)[0];
  expectBrandedBody(final.body);
  expect(final.body).toContain(":warning: I couldn't finish the " + command);
  expect(final.body).toContain("Reason: Provider unavailable");
  expect(final.body).toContain("comment `/robin` to try again.");
  expect(final.body).toMatch(/Robin v[0-9.]+ · local action/);
});

test("B7 authorized help dispatch posts commands without review or provider work", async () => {
  const { octokit, chatCompletion } = await execute({ command: "help" });
  expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith(
    { owner: "fixture", repo: "repository", username: "maintainer" }
  );
  expect(octokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
  const request = octokit.rest.issues.createComment.mock.calls[0][0] as any;
  expectBrandedBody(request.body);
  expect(request).toMatchObject({ owner: "fixture", repo: "repository", issue_number: 7 });
  expect(request.body).toContain("| /review or /robin | Full code review");
  expect(request.body).toContain("| /summary | Concise PR overview");
  expect(request.body).toContain("| /help | Show this message |");
  expect(request.body).toContain("permission-checked before the LLM is called");
  expect(chatCompletion).not.toHaveBeenCalled();
  expect(LLMClient).not.toHaveBeenCalled();
  expect(octokit.request).not.toHaveBeenCalled();
  expect(octokit.rest.issues.updateComment).not.toHaveBeenCalled();
  expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
});
