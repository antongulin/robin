import { spawnSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = join(__dirname, "..");
const helper = join(root, "scripts/release-control.cjs");
const head = "a".repeat(40), merged = "b".repeat(40), newer = "c".repeat(40);
const repo = "antongulin/robin";
const openPr = {
  number: 110, url: `https://github.com/${repo}/pull/110`, author: { is_bot: true, login: "app/github-actions" },
  headRefName: "release-please--branches--main--components--robin", headRefOid: head, baseRefName: "main",
  isCrossRepository: false, isDraft: false, state: "OPEN", mergeCommit: null,
  labels: [{ name: "autorelease: pending" }], reviewDecision: "APPROVED", mergeStateStatus: "CLEAN",
};
const mergedPr = { ...openPr, state: "MERGED", mergeCommit: { oid: merged } };

function fixture(overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "robin-release-test-"));
  const statePath = join(dir, "state.json"), trace = join(dir, "trace.jsonl"), output = join(dir, "output"), summary = join(dir, "summary");
  writeFileSync(statePath, JSON.stringify({ pr: openPr, afterMerge: mergedPr, tags: {}, ...overrides }));
  writeFileSync(trace, ""); writeFileSync(output, ""); writeFileSync(summary, "");
  for (const file of ["gh", "git"]) {
    writeFileSync(join(dir, file), `#!${process.execPath}\nprocess.argv.splice(2,0,${JSON.stringify(file)}); require(${JSON.stringify(join(root, "testdata/release-tools.cjs"))});\n`, { mode: 0o755 });
  }
  const env = {
    // Isolate from user GH/Git auth and provider credentials. Only fake executables exist on PATH.
    PATH: dir, HOME: dir, GITHUB_REPOSITORY: repo, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: merged, GH_TOKEN: "synthetic-not-a-credential", RELEASE_FIXTURE: statePath, RELEASE_TRACE: trace,
    GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RELEASE_PR_NUMBER: "110", SELECTED_SHA: head, SELECTED_STATE: "OPEN",
  };
  return {
    dir, env,
    run: (phase: string, extra: Record<string, string> = {}, script = helper) => spawnSync(process.execPath, [script, phase], {
      cwd: dir, env: { ...env, ...extra }, encoding: "utf8", timeout: 10000,
    }),
    calls: () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { file: string; args: string[] }),
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    output: () => readFileSync(output, "utf8"), summary: () => readFileSync(summary, "utf8"),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
type Fixture = ReturnType<typeof fixture>;
const active: Fixture[] = [];
function setup(overrides: Record<string, unknown> = {}) { const f = fixture(overrides); active.push(f); return f; }
afterEach(() => { for (const f of active.splice(0)) f.close(); });
const ghCalls = (f: Fixture, prefix: string) => f.calls().filter(call => call.file === "gh" && call.args.slice(0, 2).join(" ") === prefix);

describe("release control through offline gh/git processes", () => {
  it("REL1: selects and checks out the immutable trusted head, then merges with a head guard", () => {
    const f = setup();
    expect(f.run("select").status).toBe(0);
    expect(f.output()).toContain(`state=OPEN\nsha=${head}`);
    expect(f.run("checkout").status).toBe(0);
    expect(f.calls()).toContainEqual({ file: "git", args: ["checkout", "--detach", head] });
    expect(f.run("publish").status).toBe(0);
    expect(ghCalls(f, "pr merge")[0].args).toEqual(["pr", "merge", "110", "--repo", repo, "--squash", "--delete-branch", "--match-head-commit", head]);
    expect(ghCalls(f, "workflow run")[0].args).toContain("v2.12.0");
    expect(ghCalls(f, "workflow run")[0].args).not.toContain("main");
    expect(f.calls().some(call => call.args.includes("--admin") || call.args.includes("--auto"))).toBe(false);
  });

  it.each(["checkout", "publish"])("REL1: refuses a changed head before %s", phase => {
    const f = setup({ pr: { ...openPr, headRefOid: newer } });
    expect(f.run(phase).stderr).toContain("changed since selection/verification");
    expect(f.calls()).toHaveLength(1);
  });

  it.each(["REVIEW_REQUIRED", "CHANGES_REQUESTED", ""])("REL2: verifies unapproved head (%s) before publication returns WAITING", reviewDecision => {
    const f = setup({ pr: { ...openPr, reviewDecision } });
    expect(f.run("select").status).toBe(0);
    expect(f.output()).toContain(`state=OPEN\nsha=${head}`);
    expect(f.summary()).not.toContain("WAITING");
    expect(f.run("checkout").status).toBe(0);
    expect(f.calls()).toContainEqual({ file: "git", args: ["checkout", "--detach", head] });
    expect(f.summary()).toContain(`Verifying release PR #110 at immutable open commit ${head}`);
    const beforePublish = f.calls().length;
    expect(f.run("publish").status).toBe(0);
    expect(f.output()).toContain("state=WAITING");
    expect(f.summary()).toContain("main push resumes publication");
    expect(f.summary()).toContain("release-pr=110");
    expect(f.calls().slice(beforePublish)).toEqual([
      expect.objectContaining({ file: "gh", args: expect.arrayContaining(["pr", "view"]) }),
    ]);
    expect(ghCalls(f, "pr merge")).toHaveLength(0);
    expect(ghCalls(f, "release create")).toHaveLength(0);
    expect(ghCalls(f, "pr edit")).toHaveLength(0);
    expect(ghCalls(f, "workflow run")).toHaveLength(0);
  });

  it.each([{ mergeError: true }, { viewError: true }, { pr: { ...openPr, mergeStateStatus: "BLOCKED" } }])("REL2: unexpected merge/API/blocking errors fail (%p)", override => {
    const f = setup(override);
    expect(f.run("publish").status).toBe(1);
    expect(f.summary()).not.toContain("WAITING");
    expect(ghCalls(f, "release create")).toHaveLength(0);
  });

  it("REL3: recovers a merged PR without a source ref or helper in its historical tree", () => {
    const f = setup({ pr: { ...mergedPr, headRefOid: "", labels: [{ name: "autorelease: tagged" }] } });
    const selected = { SELECTED_STATE: "MERGED", SELECTED_SHA: merged };
    const saved = join(f.dir, "saved-control.cjs");
    copyFileSync(helper, saved);
    expect(f.run("select").status).toBe(0);
    expect(f.output()).toContain(`sha=${merged}`);
    expect(f.run("checkout", selected, saved).status).toBe(0);
    expect(f.run("publish", selected, saved).status).toBe(0);
    expect(f.calls()).toContainEqual({ file: "git", args: ["checkout", "--detach", merged] });
    expect(f.calls().some(call => call.args.includes("checkout") && call.file === "gh")).toBe(false);
    expect(ghCalls(f, "pr merge")).toHaveLength(0);
  });

  it("REL3: discovers only the exact merge from a normal main push, even when Release Please opens another PR", () => {
    const f = setup({ pr: mergedPr, candidates: [{ number: 110, mergeCommit: { oid: merged } }] });
    expect(f.run("select", { RELEASE_PR_NUMBER: "", GITHUB_EVENT_NAME: "push", RELEASE_PR: '{"number":111}' }).status).toBe(0);
    expect(f.output()).toContain(`number=110\nstate=MERGED\nsha=${merged}`);
    expect(ghCalls(f, "pr list")[0].args).toContain("number,mergeCommit");
    expect(ghCalls(f, "pr list")[0].args).not.toContain("--search");
  });

  it("REL3: rejects an unverified changed squash tree, but permits merged-tree recovery", () => {
    const f = setup({ treeChanged: true });
    expect(f.run("publish").stderr).toContain("differs from the verified head");
    expect(ghCalls(f, "release create")).toHaveLength(0);
    expect(f.run("checkout", { SELECTED_STATE: "MERGED", SELECTED_SHA: merged }).status).toBe(0);
    expect(f.run("publish", { SELECTED_STATE: "MERGED", SELECTED_SHA: merged }).status).toBe(0);
  });

  it.each(["0", "-1", "1;echo injected", "1\n2", "abc", "9007199254740992"])("REL4: invalid dispatch number %p fails before processes", value => {
    const f = setup();
    expect(f.run("select", { RELEASE_PR_NUMBER: value }).status).toBe(1);
    expect(f.calls()).toHaveLength(0);
  });

  it.each([
    { number: 111 }, { url: "https://github.com/other/repo/pull/110" }, { baseRefName: "other" },
    { isCrossRepository: true }, { isDraft: true }, { state: "CLOSED" }, { labels: [] },
    { author: { is_bot: false, login: "app/github-actions" } }, { author: { is_bot: true, login: "some-bot" } },
    { headRefName: "feature" }, { headRefOid: "bad" },
    { state: "MERGED", mergeCommit: null }, { state: "MERGED", mergeCommit: { oid: "bad" } },
  ])("REL4: rejects untrusted PR metadata before checkout/publication (%p)", changes => {
    const f = setup({ pr: { ...openPr, ...changes } });
    expect(f.run("select").status).toBe(1);
    expect(f.calls()).toHaveLength(1);
  });

  it("REL4: unrelated push skips, missing generated PR number fails, and mismatched discovery never publishes", () => {
    const f = setup({ candidates: [{ number: 110, mergeCommit: { oid: newer } }] });
    expect(f.run("select", { RELEASE_PR_NUMBER: "", GITHUB_EVENT_NAME: "push" }).status).toBe(0);
    expect(f.output()).toContain("state=SKIP");
    expect(f.run("select", { RELEASE_PR_NUMBER: "", RELEASE_PRS_CREATED: "true" }).status).toBe(1);
    expect(ghCalls(f, "release create")).toHaveLength(0);
  });

  it.each(["checkout", "publish"])("REL4: merged commit outside main is rejected before %s", phase => {
    const f = setup({ pr: mergedPr, onMain: false });
    expect(f.run(phase, { SELECTED_STATE: "MERGED", SELECTED_SHA: merged }).stderr).toContain("not reachable on main");
    expect(ghCalls(f, "release create")).toHaveLength(0);
    expect(f.calls().some(call => call.args[0] === "checkout")).toBe(false);
  });

  it("REL4: a different merged SHA cannot reuse verification of the selected commit", () => {
    const f = setup({ pr: { ...mergedPr, mergeCommit: { oid: newer } } });
    expect(f.run("publish", { SELECTED_STATE: "MERGED", SELECTED_SHA: merged }).stderr).toContain("changed since selection/verification");
    expect(f.calls()).toHaveLength(1);
  });

  it("REL5: repeated matching publication is idempotent and resumes npm at the same release tag", () => {
    const f = setup({ pr: mergedPr });
    const selected = { SELECTED_STATE: "MERGED", SELECTED_SHA: merged };
    expect(f.run("publish", selected).status).toBe(0);
    const firstPushes = f.calls().filter(call => call.args[0] === "push").length;
    expect(f.run("publish", selected).status).toBe(0);
    expect(ghCalls(f, "release create")).toHaveLength(1);
    expect(ghCalls(f, "pr edit")).toHaveLength(1);
    expect(ghCalls(f, "workflow run")).toHaveLength(2);
    expect(f.calls().filter(call => call.args[0] === "push")).toHaveLength(firstPushes);
    expect(f.state().tags["v2"]).toBe(merged);
    expect(f.state().tags["v2.12"]).toBe(merged);
  });

  it.each([false, true])("REL5: mismatched existing tag fails even when release exists=%p", exists => {
    const f = setup({ pr: mergedPr, tags: { "v2.12.0": newer }, releases: exists ? { "v2.12.0": { tag_name: "v2.12.0", draft: false, prerelease: false } } : {} });
    expect(f.run("publish", { SELECTED_STATE: "MERGED", SELECTED_SHA: merged }).stderr).toContain("Existing release tag v2.12.0 points to");
    expect(ghCalls(f, "release create")).toHaveLength(0);
    expect(ghCalls(f, "workflow run")).toHaveLength(0);
  });

  it("REL5: historical tagged recovery preserves newer floating streams and latest v1 compatibility", () => {
    const f = setup({ pr: { ...mergedPr, labels: [{ name: "autorelease: tagged" }] }, tags: {
      "v2.12.0": merged, "v2.12.1": newer, "v2": newer, "v2.12": newer, "v1.9.0": head,
    }, releases: { "v2.12.0": { tag_name: "v2.12.0", draft: false, prerelease: false } } });
    expect(f.run("publish", { SELECTED_STATE: "MERGED", SELECTED_SHA: merged }).status).toBe(0);
    expect(f.state().tags["v2"]).toBe(newer);
    expect(f.state().tags["v2.12"]).toBe(newer);
    expect(f.state().tags["v1"]).toBe(head);
    expect(ghCalls(f, "pr edit")).toHaveLength(0);
    expect(ghCalls(f, "workflow run")[0].args.at(-1)).toBe("v2.12.0");
  });

  it("REL5: creating a missing older release does not claim Latest or rewind newer streams", () => {
    const f = setup({ pr: mergedPr, tags: { "v2.12.1": newer, "v2": newer, "v2.12": newer } });
    expect(f.run("publish", { SELECTED_STATE: "MERGED", SELECTED_SHA: merged }).status).toBe(0);
    expect(ghCalls(f, "release create")[0].args).toContain("--latest=false");
    expect(f.state().tags["v2"]).toBe(newer);
    expect(f.state().tags["v2.12"]).toBe(newer);
  });

  it.each([{ apiError: true }, { labelError: true }, { dispatchError: true }, { fetchError: true }, { packageVersion: "2.99.0" }, { changelog: "# no release notes" }])("REL4–5: API, label, dispatch, fetch and content failures remain failures (%p)", override => {
    const f = setup({ pr: mergedPr, ...override });
    expect(f.run("publish", { SELECTED_STATE: "MERGED", SELECTED_SHA: merged }).status).toBe(1);
  });
});
