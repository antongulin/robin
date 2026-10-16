import { DiffSnapshot, nativePullRequestDiff } from "./native-diff";
import { Octokit } from "@octokit/rest";

export class GitUtils {
  private octokit: Octokit;

  constructor(octokit: Octokit, private token?: string) {
    this.octokit = octokit;
  }

  async getPullRequestDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
    try {
      const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner, repo, pull_number: pullNumber,
        headers: { accept: "application/vnd.github.v3.diff" },
      });
      return String(data);
    } catch (error) {
      // Only GitHub's structured diff-size rejection permits another acquisition path.
      const failure = error as { status?: number; response?: { data?: { errors?: unknown } } };
      const errors = failure?.response?.data?.errors;
      const tooLarge = failure?.status === 406 && Array.isArray(errors) && errors.some(item =>
        item?.resource === "PullRequest" && item?.field === "diff" && item?.code === "too_large");
      if (!tooLarge) throw error;
    }
    const capture = async (): Promise<DiffSnapshot> => {
      const { data } = await this.octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
      return { base: data.base.sha, head: data.head.sha, files: data.changed_files };
    };
    let snapshot: DiffSnapshot;
    try { snapshot = await capture(); }
    catch { throw new Error("NATIVE_DIFF_METADATA_FAILED"); }
    return nativePullRequestDiff(owner, repo, this.token, snapshot, async () => {
      const current = await capture();
      if (current.base !== snapshot.base || current.head !== snapshot.head || current.files !== snapshot.files) {
        throw new Error("NATIVE_DIFF_SNAPSHOT_CHANGED");
      }
    });
  }

  async getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      if ("content" in data) {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      
      return "";
    } catch {
      return "";
    }
  }
}
