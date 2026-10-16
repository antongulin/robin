import * as core from "@actions/core";
import * as github from "@actions/github";
import { LLMClient } from "./llm-client";

jest.mock("@actions/core");
jest.mock("@actions/github", () => ({ getOctokit: jest.fn(), context: {
  eventName: "pull_request", repo: { owner: "fixture", repo: "repo" }, payload: {},
} }));
jest.mock("./llm-client");

const base = "a".repeat(40);
const head = "b".repeat(40);
const diff = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n";

async function exercise(options: {
  config?: string; headConfig?: string; policy?: string; list?: string;
  manual?: boolean; permission?: string; commenterType?: string; authorType?: string;
  action?: string; synchronize?: boolean;
} = {}) {
  const inputs: Record<string, string> = {
    "github-token": "synthetic", "llm-base-url": "https://fixture.invalid/v1", model: "fixture",
    "max-diff-size": "50000", "max-comments": "15", "config-file": ".github/robin.yml",
    "bot-review-policy": options.policy || "", "bot-allowlist": options.list || "",
  };
  const pr = { number: 2, user: { type: options.authorType ?? "Bot", login: "dependabot[bot]" },
    base: { sha: base }, head: { sha: head }, title: "fixture", body: "" };
  Object.assign(github.context, { eventName: options.manual ? "issue_comment" : "pull_request",
    payload: options.manual ? {
      action: "created", issue: { number: 2, pull_request: {} },
      comment: { id: 7, body: "/review", user: { login: "maintainer", type: options.commenterType ?? "User" } },
    } : { action: options.action || "opened", pull_request: pr, sender: { type: "User", login: "maintainer" } },
  });
  const octokit = {
    request: jest.fn().mockResolvedValue({ data: diff }),
    paginate: jest.fn().mockResolvedValue([]),
    rest: {
      pulls: { get: jest.fn().mockResolvedValue({ data: pr }), listFiles: jest.fn(), listReviews: jest.fn(),
        createReview: jest.fn().mockResolvedValue({ data: { id: 9 } }) },
      repos: {
        downloadTarballArchive: jest.fn(),
        getContent: jest.fn(async ({ path, ref }: { path: string; ref: string }) => {
          const text = ref === base ? options.config : options.headConfig;
          return { data: { content: Buffer.from(path === ".github/robin.yml" ? text || "" : "").toString("base64") } };
        }),
        getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: options.permission || "write" } }),
        getCommit: jest.fn().mockResolvedValue({ data: { sha: head } }),
      },
      issues: { createComment: jest.fn().mockResolvedValue({ data: { id: 1 } }), updateComment: jest.fn() },
      reactions: { createForIssueComment: jest.fn() },
      actions: { listWorkflowRuns: jest.fn().mockResolvedValue({ data: { workflow_runs: [] } }) },
    },
  };
  jest.mocked(github.getOctokit).mockReturnValue(octokit as any);
  jest.mocked(core.getInput).mockImplementation(name => inputs[name] || "");
  jest.mocked(core.getBooleanInput).mockReturnValue(options.synchronize ?? false);
  const completion = jest.fn().mockResolvedValue({ content: JSON.stringify({ summary: "Reviewed", high: [], medium: [], low: [], suggestions: [] }) });
  jest.mocked(LLMClient).mockImplementation(() => ({ chatCompletion: completion, getReasoningFallbackReason: () => undefined }) as any);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  jest.mocked(core.info).mockImplementation(message => {
    if (message === "Done." || message.startsWith("Skipping ") || message === "Ignoring bot comment.") finish();
  });
  jest.mocked(core.warning).mockImplementation(message => { if (String(message).startsWith("Ignoring /")) finish(); });
  jest.mocked(core.setFailed).mockImplementation(() => finish());
  const signals = ["SIGTERM", "SIGINT"] as const;
  const before = signals.map(signal => process.listeners(signal));
  let timer: NodeJS.Timeout | undefined;
  try {
    await jest.isolateModulesAsync(async () => { await import("./main"); });
    await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Bot policy fixture did not finish")), 3000);
    })]);
    // Let run() finish its finally block before inspecting/cleaning up.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(core.setFailed).not.toHaveBeenCalled();
    return { octokit, completion };
  } finally {
    if (timer) clearTimeout(timer);
    signals.forEach((signal, index) => {
      for (const listener of process.listeners(signal)) {
        if (!before[index].includes(listener)) process.removeListener(signal, listener);
      }
    });
  }
}

beforeEach(() => jest.clearAllMocks());

describe("BOT5: automatic author filter and manual authorization", () => {
  it.each(["opened", "reopened", "ready_for_review", "synchronize"])("skips excluded bot on %s before expensive work or status", async action => {
    const { octokit, completion } = await exercise({ config: "bot-review-policy: none\nagent-mode: auto", action, synchronize: true });
    expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1);
    expect(octokit.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({ path: ".github/robin.yml", ref: base }));
    expect(octokit.request).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.repos.getCommit).not.toHaveBeenCalled();
    expect(octokit.rest.repos.downloadTarballArchive).not.toHaveBeenCalled();
    expect(LLMClient).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining("Skipping automatic review"));
  });

  it("uses base config rather than a permissive PR-head config or the human event sender", async () => {
    const { octokit } = await exercise({ config: "bot-review-policy: none", headConfig: "bot-review-policy: all" });
    expect(octokit.request).not.toHaveBeenCalled();
    expect(octokit.rest.repos.getContent.mock.calls.every(([args]) => args.ref === base)).toBe(true);
  });

  it.each([
    {},
    { config: "bot-review-policy: none", policy: "all" },
    { config: "bot-review-policy: allowlist\nbot-allowlist:\n  - DEPENDABOT[bot]" },
    { config: "bot-review-policy: none", authorType: "User" },
    { headConfig: "bot-review-policy: none" },
  ])("still posts a review for eligible PRs (%p)", async options => {
    const { octokit, completion } = await exercise(options);
    expect(completion).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });

  it("BOT4: warns on invalid configuration and skips the bot", async () => {
    const { octokit } = await exercise({ config: "bot-review-policy: typo" });
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("bot-review-policy"));
    expect(octokit.request).not.toHaveBeenCalled();
  });

  it.each(["bot-review-policy: none", "bot-review-policy: invalid\nbot-allowlist: bad"])("authorized manual /review still reviews a bot PR (%s)", async config => {
    const { octokit, completion } = await exercise({ config, manual: true });
    expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith(expect.objectContaining({ username: "maintainer" }));
    expect(completion).toHaveBeenCalledTimes(1);
    expect(octokit.rest.pulls.createReview).toHaveBeenCalledTimes(1);
  });

  it("keeps human automatic reviews working under invalid bot configuration", async () => {
    const { completion } = await exercise({ config: "bot-review-policy: invalid", authorType: "User" });
    expect(completion).toHaveBeenCalledTimes(1);
  });

  it.each([{ permission: "read" }, { commenterType: "Bot" }])("keeps unauthorized or bot commands blocked (%p)", async options => {
    const { octokit, completion } = await exercise({ ...options, config: "bot-review-policy: all", manual: true });
    expect(completion).not.toHaveBeenCalled();
    expect(octokit.rest.issues.createComment).not.toHaveBeenCalled();
    expect(octokit.rest.repos.getContent).not.toHaveBeenCalled();
  });
});
