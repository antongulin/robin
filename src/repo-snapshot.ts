import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as core from "@actions/core";

const execFileAsync = promisify(execFile);

export const DEFAULT_SNAPSHOT_MAX_BYTES = 500 * 1024 * 1024;
const TAR_TIMEOUT_MS = 120_000;

export interface RepoSnapshot {
  /** Absolute path of the extracted tree. Contents are untrusted PR code: read, never execute. */
  root: string;
  cleanup(): Promise<void>;
}

export interface SnapshotOptions {
  maxBytes?: number;
  tempDir?: string;
}

interface TarballOctokit {
  rest: {
    repos: {
      downloadTarballArchive(params: {
        owner: string;
        repo: string;
        ref: string;
      }): Promise<{ data: unknown }>;
    };
  };
}

/**
 * Downloads the repository at `ref` as a GitHub tarball and extracts it into a temp dir.
 * No checkout is needed in the consumer workflow, and nothing in the tree is executed.
 */
export async function createRepoSnapshot(
  octokit: TarballOctokit,
  owner: string,
  repo: string,
  ref: string,
  options: SnapshotOptions = {}
): Promise<RepoSnapshot> {
  const maxBytes = options.maxBytes ?? DEFAULT_SNAPSHOT_MAX_BYTES;
  const base = options.tempDir || process.env.RUNNER_TEMP || os.tmpdir();
  const workDir = await fs.mkdtemp(path.join(base, "robin-snapshot-"));
  const cleanup = async () => {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    const { data } = await octokit.rest.repos.downloadTarballArchive({ owner, repo, ref });
    const archive = toBuffer(data);
    if (archive.byteLength > maxBytes) {
      throw new Error(
        `repository archive is ${archive.byteLength} bytes, above the ${maxBytes}-byte snapshot limit`
      );
    }

    const archivePath = path.join(workDir, "repo.tar.gz");
    const root = path.join(workDir, "repo");
    await fs.writeFile(archivePath, archive);
    await fs.mkdir(root);
    // GitHub archives wrap everything in a single `<owner>-<repo>-<sha>/` folder.
    await execFileAsync("tar", ["-xzf", archivePath, "-C", root, "--strip-components=1"], {
      timeout: TAR_TIMEOUT_MS,
    });
    await fs.rm(archivePath, { force: true });

    core.info(`Extracted repository snapshot at ${ref.slice(0, 12)} (${archive.byteLength} bytes)`);
    return { root: await fs.realpath(root), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("unexpected tarball response type from GitHub");
}
