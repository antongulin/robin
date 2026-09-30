import { readFileSync } from "fs";
import { join } from "path";

/** Version from the action's own package.json (dist/ sits next to it at runtime). */
export function readPackageVersion(dir = __dirname): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "..", "package.json"), "utf8"));
    return pkg?.name === "robin-review" && typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

interface CommitLookupOctokit {
  rest: {
    repos: {
      getCommit(params: { owner: string; repo: string; ref: string }): Promise<{ data: { sha: string } }>;
    };
  };
}

/**
 * Human-readable identity of the running action, e.g. "v2.8.0 · yoeven/robin@main (9e6bb3d)".
 * The commit is looked up best-effort because a branch ref like `main` doesn't say which
 * commit the runner downloaded.
 */
export async function describeRobinVersion(
  octokit?: CommitLookupOctokit,
  env: NodeJS.ProcessEnv = process.env,
  packageVersion = readPackageVersion(),
  timeoutMs = 3000
): Promise<string> {
  const version = packageVersion ? `v${packageVersion}` : "version unknown";
  const repository = env.GITHUB_ACTION_REPOSITORY;
  const ref = env.GITHUB_ACTION_REF;
  if (!repository) return `${version} · local action`;

  const source = `${repository}@${ref || "?"}`;
  const sha = ref ? await resolveCommit(octokit, repository, ref, timeoutMs) : undefined;
  return sha ? `${version} · ${source} (${sha.slice(0, 7)})` : `${version} · ${source}`;
}

async function resolveCommit(
  octokit: CommitLookupOctokit | undefined,
  repository: string,
  ref: string,
  timeoutMs: number
): Promise<string | undefined> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref;
  const [owner, repo] = repository.split("/");
  if (!octokit || !owner || !repo) return undefined;
  const lookup = octokit.rest.repos
    .getCommit({ owner, repo, ref })
    .then(({ data }) => data.sha)
    .catch(() => undefined);
  const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs).unref());
  return Promise.race([lookup, timeout]);
}
