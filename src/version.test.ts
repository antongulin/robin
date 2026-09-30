import { join } from "path";
import { describeRobinVersion, readPackageVersion } from "./version";

const octokitReturning = (impl: () => Promise<{ data: { sha: string } }>) => ({
  rest: { repos: { getCommit: jest.fn(impl) } },
});

describe("readPackageVersion", () => {
  it("reads the version from the action's package.json", () => {
    expect(readPackageVersion(join(__dirname))).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns undefined when package.json is missing", () => {
    expect(readPackageVersion("/nonexistent/dir")).toBeUndefined();
  });
});

describe("describeRobinVersion", () => {
  it("includes the action ref and resolved commit", async () => {
    const octokit = octokitReturning(async () => ({ data: { sha: "9e6bb3d1234567890abcdef1234567890abcdef0" } }));
    const label = await describeRobinVersion(
      octokit,
      { GITHUB_ACTION_REPOSITORY: "yoeven/robin", GITHUB_ACTION_REF: "main" },
      "2.8.0"
    );
    expect(label).toBe("v2.8.0 · yoeven/robin@main (9e6bb3d)");
    expect(octokit.rest.repos.getCommit).toHaveBeenCalledWith({ owner: "yoeven", repo: "robin", ref: "main" });
  });

  it("uses a pinned SHA ref without an API call", async () => {
    const octokit = octokitReturning(async () => ({ data: { sha: "unused" } }));
    const sha = "abcdef1234567890abcdef1234567890abcdef12";
    const label = await describeRobinVersion(
      octokit,
      { GITHUB_ACTION_REPOSITORY: "yoeven/robin", GITHUB_ACTION_REF: sha },
      "2.8.0"
    );
    expect(label).toBe(`v2.8.0 · yoeven/robin@${sha} (abcdef1)`);
    expect(octokit.rest.repos.getCommit).not.toHaveBeenCalled();
  });

  it("falls back to the ref when the commit lookup fails", async () => {
    const octokit = octokitReturning(async () => {
      throw new Error("Not Found");
    });
    const label = await describeRobinVersion(
      octokit,
      { GITHUB_ACTION_REPOSITORY: "yoeven/robin", GITHUB_ACTION_REF: "v2" },
      "2.8.0"
    );
    expect(label).toBe("v2.8.0 · yoeven/robin@v2");
  });

  it("gives up on a slow commit lookup", async () => {
    const octokit = octokitReturning(() => new Promise(() => undefined));
    const label = await describeRobinVersion(
      octokit,
      { GITHUB_ACTION_REPOSITORY: "yoeven/robin", GITHUB_ACTION_REF: "main" },
      "2.8.0",
      10
    );
    expect(label).toBe("v2.8.0 · yoeven/robin@main");
  });

  it("labels local runs and unknown versions", async () => {
    expect(await describeRobinVersion(undefined, {}, "")).toBe("version unknown · local action");
  });
});
