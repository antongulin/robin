jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
}));

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRepoSnapshot } from "./repo-snapshot";

describe("createRepoSnapshot", () => {
  let base: string;
  let archive: Buffer;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "robin-snapshot-test-"));
    const source = join(base, "source");
    mkdirSync(join(source, "owner-repo-abc123", "src"), { recursive: true });
    writeFileSync(join(source, "owner-repo-abc123", "src", "index.ts"), "export const x = 1;\n");
    execFileSync("tar", ["-czf", join(base, "repo.tar.gz"), "-C", source, "owner-repo-abc123"]);
    archive = readFileSync(join(base, "repo.tar.gz"));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function octokitReturning(data: unknown) {
    const downloadTarballArchive = jest.fn().mockResolvedValue({ data });
    return { octokit: { rest: { repos: { downloadTarballArchive } } }, downloadTarballArchive };
  }

  it("extracts the archive without its top-level folder and cleans up", async () => {
    const tempDir = mkdtempSync(join(base, "run-"));
    const { octokit, downloadTarballArchive } = octokitReturning(
      archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength)
    );

    const snapshot = await createRepoSnapshot(octokit, "owner", "repo", "abc123", { tempDir });

    expect(downloadTarballArchive).toHaveBeenCalledWith({ owner: "owner", repo: "repo", ref: "abc123" });
    expect(readFileSync(join(snapshot.root, "src", "index.ts"), "utf8")).toBe("export const x = 1;\n");
    expect(existsSync(join(snapshot.root, "..", "repo.tar.gz"))).toBe(false);

    await snapshot.cleanup();
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it("rejects archives above the size limit and leaves nothing behind", async () => {
    const tempDir = mkdtempSync(join(base, "run-"));
    const { octokit } = octokitReturning(archive);

    await expect(
      createRepoSnapshot(octokit, "owner", "repo", "abc123", { tempDir, maxBytes: 10 })
    ).rejects.toThrow(/snapshot limit/);
    expect(readdirSync(tempDir)).toEqual([]);
  });
});
