import { execFile } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { devNull, tmpdir } from "os";
import { join } from "path";

const MAX_OUTPUT = 32 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

export interface DiffSnapshot {
  base: string;
  head: string;
  files: number;
}

// Never propagate a child error: it can contain arguments, environment or stderr.
async function git(args: string[], token?: string, origin?: string): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "0",
    LC_ALL: "C",
  };
  if (token && origin) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${origin}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  const options = [
    "-c", `core.hooksPath=${devNull}`,
    "-c", "credential.helper=",
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "http.followRedirects=false",
  ];
  return new Promise((resolve, reject) => {
    execFile("git", [...options, ...args], {
      env, encoding: "buffer", maxBuffer: MAX_OUTPUT,
      timeout: TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        const code = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
          ? "NATIVE_DIFF_OUTPUT_LIMIT" : error.killed ? "NATIVE_DIFF_CHILD_TERMINATED" : "NATIVE_DIFF_COMMAND_FAILED";
        reject(new Error(code));
      } else {
        resolve(stdout);
      }
    });
  });
}

function countPaths(inventory: Buffer): number {
  const fields = inventory.toString("utf8").split("\0");
  if (fields.pop() !== "") throw new Error("NATIVE_DIFF_INVALID_INVENTORY");
  let count = 0;
  for (let i = 0; i < fields.length; count++) {
    const status = fields[i++];
    const paths = /^R\d+$/.test(status) ? 2 : /^[AMDT]$/.test(status) ? 1 : 0;
    if (!paths || i + paths > fields.length || fields.slice(i, i + paths).some(path => !path)) {
      throw new Error("NATIVE_DIFF_INVALID_INVENTORY");
    }
    i += paths;
  }
  return count;
}

/** Acquire one immutable PR snapshot in private object storage, without checkout. */
export async function nativePullRequestDiff(
  owner: string, repo: string, token: string | undefined, snapshot: DiffSnapshot,
  verifySnapshot: () => Promise<void>,
): Promise<string> {
  if (!token || !/^[a-z\d][a-z\d_.-]*$/i.test(owner) || !/^[a-z\d][a-z\d_.-]*$/i.test(repo) ||
      !/^[a-f\d]{40}$/.test(snapshot.base) || !/^[a-f\d]{40}$/.test(snapshot.head) ||
      !Number.isSafeInteger(snapshot.files) || snapshot.files < 0) {
    throw new Error("NATIVE_DIFF_INVALID_SNAPSHOT");
  }
  let origin: string;
  try {
    const server = new URL(process.env.GITHUB_SERVER_URL || "https://github.com");
    if (server.protocol !== "https:" || server.username || server.password || server.search || server.hash || server.pathname !== "/") {
      throw new Error();
    }
    origin = server.origin;
  } catch {
    throw new Error("NATIVE_DIFF_INVALID_SERVER");
  }

  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "robin-diff-"));
    await git(["init", "--bare", "--template=", directory]);
    const at = ["--git-dir", directory];
    await git([...at, "fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance", "--",
      `${origin}/${owner}/${repo}.git`, snapshot.base, snapshot.head], token, origin);
    for (const sha of [snapshot.base, snapshot.head]) {
      const resolved = (await git([...at, "rev-parse", "--verify", `${sha}^{commit}`])).toString("ascii").trim();
      if (resolved !== sha) throw new Error("NATIVE_DIFF_OBJECT_MISMATCH");
    }
    const bases = (await git([...at, "merge-base", "--all", snapshot.base, snapshot.head])).toString("ascii").trim().split("\n");
    if (bases.length !== 1 || !/^[a-f\d]{40}$/.test(bases[0])) throw new Error("NATIVE_DIFF_AMBIGUOUS_BASE");
    const range = [bases[0], snapshot.head, "--"];
    const inventory = await git([...at, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--name-status", "-z", ...range]);
    if (countPaths(inventory) !== snapshot.files) throw new Error("NATIVE_DIFF_PATH_COUNT_MISMATCH");
    const patch = await git([...at, "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--full-index", "--binary", "--no-color", ...range]);
    const text = patch.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(patch)) throw new Error("NATIVE_DIFF_INVALID_ENCODING");
    await verifySnapshot();
    return text;
  } catch (error) {
    if (error instanceof Error && /^NATIVE_DIFF_[A-Z_]+$/.test(error.message)) throw error;
    throw new Error("NATIVE_DIFF_FAILED");
  } finally {
    if (directory) {
      try { await rm(directory, { recursive: true, force: true }); }
      catch { throw new Error("NATIVE_DIFF_CLEANUP_FAILED"); }
    }
  }
}
