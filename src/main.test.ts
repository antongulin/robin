import * as http from "http";
import { AddressInfo } from "net";
import { createHash } from "crypto";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { GitHubReviewer } from "./github-reviewer";

jest.mock("@actions/core");
jest.mock("@actions/github", () => ({ getOctokit: jest.fn(), context: {
  eventName: "pull_request", repo: { owner: "fixture", repo: "repository" },
  payload: { action: "opened", pull_request: { number: 2, title: "synthetic review pack", body: "",
    base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } } },
} }));
jest.mock("./github-reviewer");
jest.mock("./status-reporter");
jest.setTimeout(30_000);

const config = "max-diff-size: 1000000\nagent-mode: off\nskip-paths:\n  - catalog/themes/**\n  - catalog/unmapped/**\n  - docs/tasks/checkpoint.md\n";
const paths = [
  ".dockerignore",
  ".github/AGENTS.md",
  ".github/actionlint.yaml",
  ".github/workflows/ci.yml",
  ".prettierignore",
  "AGENTS.md",
  "Dockerfile",
  "README.md",
  "catalog/AGENTS.md",
  "catalog/README.md",
  "catalog/benefits.json",
  "catalog/runtime-benefits.json",
  "compose.yaml",
  "docs/access-verification.md",
  "docs/bulk-source-verification.md",
  "docs/catalogue-metadata.md",
  "docs/class-source-verification.md",
  "docs/conference-source-verification.md",
  "docs/container-deployment.md",
  "docs/core-library.md",
  "docs/core-verification.md",
  "docs/global-pagination-verification.md",
  "docs/ht2-verification.md",
  "docs/http-mcp.md",
  "docs/metadata151-publication-verification.md",
  "docs/passive-all149-verification.md",
  "docs/pilot-metadata-plan.md",
  "docs/pilot-verification.md",
  "docs/policy-context-verification.md",
  "docs/proposed-test-plan.md",
  "docs/source-bulk-stop-verification.md",
  "docs/source-pilot-verification.md",
  "docs/source-remaining65-stop-verification.md",
  "docs/test-decisions.md",
  "eslint.config.js",
  "package.json",
  "src/AGENTS.md",
  "src/bundle.ts",
  "src/catalogue.ts",
  "src/errors.ts",
  "src/index.ts",
  "src/library.ts",
  "src/metadata.ts",
  "src/output.ts",
  "src/parsing.ts",
  "src/policy.ts",
  "src/snapshot.ts",
  "src/transport/AGENTS.md",
  "src/transport/data.ts",
  "src/transport/http.ts",
  "src/transport/main.ts",
  "src/transport/tools.ts",
  "src/types.ts",
  "tests/AGENTS.md",
  "tests/catalogue-parsing.test.ts",
  "tests/class-source.test.ts",
  "tests/conference-source.test.ts",
  "tests/fixture.ts",
  "tests/lead-regressions.test.ts",
  "tests/library.test.ts",
  "tests/offline-index.test.ts",
  "tests/output.test.ts",
  "tests/performance.test.ts",
  "tests/policy-context-fixture.ts",
  "tests/policy-context.test.ts",
  "tests/transport-data.test.ts",
  "tests/transport.test.ts",
  "tools/AGENTS.md",
  "tools/acquisition.ts",
  "tools/container-client.ts",
  "tools/container-probe.ts",
  "tools/index.ts",
  "tools/private-check.ts",
  "tsconfig.build.json",
  "tsconfig.json"
];

function added(path: string, text: string): string {
  const lines = text.trimEnd().split("\n");
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join("\n")}\n`;
}

async function capture(baseConfig: boolean, small = false, lifecycleFailure = false): Promise<{ request: any; configRefs: string[]; requests: number }> {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    // A synthetic bearer is the only credential allowed at this boundary.
    expect(req.headers.authorization).toBe("Bearer synthetic-loopback-key");
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(request);
      const content = JSON.stringify({ summary: "Synthetic review", high: [], medium: [], low: [{ description: "Synthetic finding", file: "src/runtime.ts", line: 1 }], suggestions: [] });
      if (request.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", model: "synthetic-model", choices: [{ index: 0, delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "synthetic", object: "chat.completion", model: "synthetic-model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const inputs: Record<string, string> = {
    "github-token": "synthetic-github-key", "llm-api-key": "synthetic-loopback-key",
    "llm-base-url": `http://127.0.0.1:${address.port}/v1`, model: "synthetic-model",
    "max-diff-size": "50000", "max-output-tokens": "2048", "llm-timeout-ms": "10000",
    "max-comments": "20", "agent-mode": "off", "config-file": ".github/robin.yml",
    "review-instructions-file": ".github/robin-instructions.md",
  };
  const configRefs: string[] = [];
  const markers = paths.map((path, i) => added(path, `MARKER_${i}_MANDATORY`));
  const large = added("src/zz-tail.ts", "reviewable line\n".repeat(40_000) + "FINAL_RUNTIME_TAIL_MARKER\n");
  const diff = small ? markers[0] : [
    added("catalog/themes/static/README.md", "EXCLUDED_STATIC_THEME"),
    added("catalog/unmapped/static.json", "EXCLUDED_STATIC_METADATA"),
    added("docs/tasks/checkpoint.md", "EXCLUDED_TASK_HISTORY"),
    added("pnpm-lock.yaml", "EXCLUDED_GENERATED_LOCK"), ...markers, large,
  ].join("");
  const octokit = {
    request: lifecycleFailure ? jest.fn().mockRejectedValue({ status: 406, response: { data: {
      errors: [{ resource: "PullRequest", field: "diff", code: "too_large" }],
    } } }) : jest.fn().mockResolvedValue({ data: diff }),
    rest: {
      pulls: { get: jest.fn().mockResolvedValue({ data: {
        base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) }, changed_files: 1,
      } }) },
      repos: { getContent: jest.fn(async ({ path, ref }: { path: string; ref: string }) => {
        if (path === ".github/robin.yml") {
          configRefs.push(ref);
          // Config is always available at head; only the selected base variant has it.
          if (baseConfig || ref === "b".repeat(40)) return { data: { content: Buffer.from(config).toString("base64") } };
        }
        throw Object.assign(new Error("SYNTHETIC_NOT_FOUND"), { status: 404 });
      }) },
      actions: { listWorkflowRuns: jest.fn().mockResolvedValue({ data: { workflow_runs: [] } }) },
      issues: { createComment: jest.fn().mockResolvedValue({ data: { id: 1 } }), updateComment: jest.fn() },
    },
  };
  jest.mocked(github.getOctokit).mockReturnValue(octokit as any);
  jest.mocked(core.getInput).mockImplementation(name => inputs[name] || "");
  jest.mocked(core.getBooleanInput).mockReturnValue(false);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  jest.mocked(core.info).mockImplementation(message => { if (message === "Done.") finish(); });
  jest.mocked(core.setFailed).mockImplementation(() => finish());
  jest.mocked(GitHubReviewer).mockImplementation(() => ({ postReview: jest.fn().mockResolvedValue(undefined) }) as any);
  let timer: NodeJS.Timeout | undefined;
  try {
    if (lifecycleFailure) jest.doMock("./native-diff", () => ({
      nativePullRequestDiff: jest.fn().mockRejectedValue(new Error("NATIVE_DIFF_LIFECYCLE_FAILED")),
    }));
    await jest.isolateModulesAsync(async () => { await import("./main"); });
    await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("SYNTHETIC_MAIN_TIMEOUT")), 15_000);
    })]);
    if (lifecycleFailure) {
      expect(core.setFailed).toHaveBeenCalledWith("NATIVE_DIFF_LIFECYCLE_FAILED");
      expect(requests).toHaveLength(0);
      expect(GitHubReviewer).not.toHaveBeenCalled();
      expect(octokit.rest.issues.updateComment).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.stringContaining("NATIVE_DIFF_LIFECYCLE_FAILED"),
      }));
      expect(octokit.request).toHaveBeenCalledTimes(1);
      expect(octokit.rest.pulls.get).toHaveBeenCalledTimes(1);
    } else {
      expect(core.setFailed).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
    }
    return { request: requests[0], configRefs, requests: requests.length };
  } finally {
    if (lifecycleFailure) jest.dontMock("./native-diff");
    if (timer) clearTimeout(timer);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(new Error("SYNTHETIC_CLOSE_FAILED")) : resolve()));
  }
}

const runEnvironment = ["GITHUB_RUN_ID", "GITHUB_RUN_NUMBER"];
let savedEnvironment: (string | undefined)[];
beforeEach(() => {
  jest.clearAllMocks();
  savedEnvironment = runEnvironment.map(key => process.env[key]);
  for (const key of runEnvironment) delete process.env[key];
});
afterEach(() => {
  runEnvironment.forEach((key, i) => {
    if (savedEnvironment[i] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[i];
  });
});

test("C1: base configuration retains every authored runtime/test/tool/packaging and benefit marker through the actual outgoing request", async () => {
  const { request, configRefs } = await capture(true);
  expect(configRefs).toEqual(["a".repeat(40)]);
  const payload = JSON.stringify(request.messages);
  for (let i = 0; i < paths.length; i++) expect(payload.split(`MARKER_${i}_MANDATORY`)).toHaveLength(2);
  expect(payload.split("FINAL_RUNTIME_TAIL_MARKER")).toHaveLength(2);
  expect(payload).not.toContain("EXCLUDED_");
  expect(payload).not.toContain("truncated");
  expect(Buffer.byteLength(payload)).toBeGreaterThan(600_000);
  expect(request.max_tokens ?? request.max_completion_tokens).toBe(2048);
  console.info("C1_REQUEST_EVIDENCE", JSON.stringify({
    utf8Bytes: Buffer.byteLength(payload), sha256: createHash("sha256").update(payload).digest("hex"),
    mandatoryPaths: paths, tailOccurrences: payload.split("FINAL_RUNTIME_TAIL_MARKER").length - 1,
    truncated: payload.includes("truncated"), outputReserve: request.max_tokens ?? request.max_completion_tokens,
  }));
});

test("C1: config present only at feature head cannot activate; the existing base cap truncates the tail", async () => {
  const { request, configRefs } = await capture(false);
  expect(configRefs).toEqual(["a".repeat(40)]);
  const payload = JSON.stringify(request.messages);
  expect(payload).not.toContain("FINAL_RUNTIME_TAIL_MARKER");
  expect(payload).toContain("truncated");
});

test("C3: an ordinary small review still reaches the actual loopback request intact", async () => {
  const { request } = await capture(false, true);
  expect(JSON.stringify(request.messages)).toContain("MARKER_0_MANDATORY");
  expect(JSON.stringify(request.messages)).not.toContain("truncated");
});


test("N10: lifecycle acquisition failure posts failed status without provider requests or reviews", async () => {
  const result = await capture(false, false, true);
  expect(result.requests).toBe(0);
});
