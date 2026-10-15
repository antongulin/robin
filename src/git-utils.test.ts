import { Octokit } from "@octokit/rest";
import { createHash } from "crypto";
import childProcess = require("child_process");
import fs = require("fs/promises");
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GitUtils } from "./git-utils";

const TOKEN = "synthetic-github-token-never-real";
const limit = { status: 406, response: { data: { errors: [{ resource: "PullRequest", field: "diff", code: "too_large" }] } } };
const realSpawn = childProcess.spawn;
let fixture: string;
let base: string;
let head: string;
let ancestor: string;
let unrelated: string;
let temporary: string[];
let commands: { args: string[]; env: NodeJS.ProcessEnv }[];
let savedServerUrl: string | undefined;

function localGit(args: string[], input?: string): string {
  return childProcess.execFileSync("git", ["-C", fixture, ...args], {
    encoding: "utf8", input, maxBuffer: 40 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"],
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  }).trim();
}

function api(files = 379) {
  const metadata = { base: { sha: base }, head: { sha: head }, changed_files: files };
  const request = jest.fn().mockRejectedValue(limit);
  const get = jest.fn().mockResolvedValue({ data: metadata });
  const octokit = { request, rest: { pulls: { get } } } as unknown as Octokit;
  return { utils: new GitUtils(octokit, TOKEN), request, get, metadata };
}

// Intercept only the network boundary. Every object, merge-base and diff operation
// is real Git; production receives no local transport override.
function redirectFetch() {
  return jest.spyOn(childProcess, "spawn").mockImplementation(((file: string, args: string[], options: any) => {
    if (file !== "git") return realSpawn(file, args, options);
    commands.push({ args: [...args], env: { ...options.env } });
    const init = args.indexOf("init");
    if (init >= 0) temporary.push(args[args.length - 1]);
    expect(options.detached).toBe(true);
    expect(options.shell).toBe(false);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(args.join(" ")).not.toContain(TOKEN);
    expect(args.join(" ")).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    for (const key of ["GIT_EXTERNAL_DIFF", "GIT_TRACE", "GIT_TRACE_CURL", "GIT_CONFIG_PARAMETERS", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
      expect(options.env[key]).toBeUndefined();
    }
    const at = args.indexOf("--git-dir");
    if (at >= 0) {
      const directory = args[at + 1];
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      const config = readFileSync(join(directory, "config"), "utf8");
      expect(config).not.toContain(TOKEN);
      expect(config).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
    }
    if (args.includes("fetch")) {
      expect(args[args.indexOf("--") + 1]).toBe("https://github.com/fixture/repository.git");
      const rewritten = args.map(arg => arg === "https://github.com/fixture/repository.git" ? fixture : arg);
      return realSpawn(file, ["-c", "protocol.file.allow=always", ...rewritten], options);
    }
    return realSpawn(file, args, options);
  }) as any);
}

beforeAll(() => {
  savedServerUrl = process.env.GITHUB_SERVER_URL;
  process.env.GITHUB_SERVER_URL = "https://github.com";
  fixture = mkdtempSync(join(tmpdir(), "robin-fixture-"));
  localGit(["init", "--template=", "."]);
  localGit(["config", "core.fileMode", "true"]);
  for (const [path, body] of Object.entries({ "common.txt": "before\n", "remove.txt": "delete\n", "rename-before.txt": "rename uniquely\n", "blob.bin": "before\0binary", "mode.sh": "mode\n" })) {
    writeFileSync(join(fixture, path), body);
  }
  localGit(["add", "common.txt", "remove.txt", "rename-before.txt", "blob.bin", "mode.sh"]);
  localGit(["commit", "-m", "ancestor"]);
  ancestor = localGit(["rev-parse", "HEAD"]);
  writeFileSync(join(fixture, "base-only.txt"), "must not enter PR patch\n");
  localGit(["add", "base-only.txt"]); localGit(["commit", "-m", "divergent base"]);
  base = localGit(["rev-parse", "HEAD"]);
  localGit(["checkout", "-b", "feature", ancestor]);
  mkdirSync(join(fixture, "added"));
  for (let i = 0; i < 373; i++) {
    const name = i === 0 ? 'tab\tquote".txt' : i === 1 ? "newline\nname.txt" : `${i}.txt`;
    writeFileSync(join(fixture, "added", name), `path ${i}\n`);
  }
  writeFileSync(join(fixture, "common.txt"), "after\n");
  unlinkSync(join(fixture, "remove.txt"));
  renameSync(join(fixture, "rename-before.txt"), join(fixture, "rename-after.txt"));
  writeFileSync(join(fixture, "blob.bin"), Buffer.from([0, 1, 255, 2, 3, 0]));
  chmodSync(join(fixture, "mode.sh"), 0o755);
  writeFileSync(join(fixture, "large.txt"), "large text line\n".repeat(90_000) + "FINAL_LARGE_PATCH_MARKER\n");
  localGit(["add", "added", "common.txt", "remove.txt", "rename-before.txt", "rename-after.txt", "blob.bin", "mode.sh", "large.txt"]);
  localGit(["commit", "-m", "379 changes"]);
  head = localGit(["rev-parse", "HEAD"]);
  localGit(["checkout", "--orphan", "unrelated"]);
  localGit(["rm", "-r", "--cached", "."]);
  writeFileSync(join(fixture, "unrelated.txt"), "no ancestor\n");
  localGit(["add", "unrelated.txt"]); localGit(["commit", "-m", "unrelated"]);
  unrelated = localGit(["rev-parse", "HEAD"]);
});

beforeEach(() => { temporary = []; commands = []; });
afterEach(() => {
  jest.restoreAllMocks();
  for (const directory of temporary) {
    const remains = existsSync(directory);
    rmSync(directory, { recursive: true, force: true });
    expect(remains).toBe(false);
  }
});
afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
  if (savedServerUrl === undefined) delete process.env.GITHUB_SERVER_URL;
  else process.env.GITHUB_SERVER_URL = savedServerUrl;
});

test("A1: small API diff is byte-identical and uses the existing media request", async () => {
  const { utils, request, get } = api();
  const diff = "diff --git a/a b/a\n+é\r\n";
  request.mockResolvedValueOnce({ data: diff });
  expect(await utils.getPullRequestDiff("fixture", "repository", 1)).toBe(diff);
  expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: "fixture", repo: "repository", pull_number: 1, headers: { accept: "application/vnd.github.v3.diff" },
  });
  expect(get).not.toHaveBeenCalled();
});

test.each([401, 403, 404, 429, 500, 502, 422, 406, undefined])("A1: status %s without the structured size classification never falls back", async status => {
  const { utils, request, get } = api();
  const error = { status, response: { data: { message: "too large is not a classification" } } };
  request.mockRejectedValueOnce(error);
  await expect(utils.getPullRequestDiff("fixture", "repository", 1)).rejects.toBe(error);
  expect(get).not.toHaveBeenCalled();
});

test("A2: real 379-path divergent-base binary/full-index patch reconstructs exact head including modes", async () => {
  redirectFetch();
  const { utils } = api();
  const patch = await utils.getPullRequestDiff("fixture", "repository", 1);
  expect(Buffer.byteLength(patch)).toBeGreaterThan(1024 * 1024);
  expect(patch).toContain("FINAL_LARGE_PATCH_MARKER");
  expect(patch).toContain("GIT binary patch");
  expect(patch).toContain("rename from rename-before.txt");
  expect(patch).toContain("deleted file mode");
  expect(patch).toContain("old mode 100644\nnew mode 100755");
  expect(patch).not.toContain("base-only.txt");
  localGit(["read-tree", ancestor]);
  localGit(["apply", "--cached", "--binary", "-"], patch);
  const actualTree = localGit(["write-tree"]);
  const expectedTree = localGit(["rev-parse", `${head}^{tree}`]);
  expect(actualTree).toBe(expectedTree);
  const paths = localGit(["diff", "--name-only", "-z", "--find-renames", ancestor, head]).split("\0").filter(Boolean);
  expect(paths).toHaveLength(379);
  console.info("A2_TREE_EVIDENCE", JSON.stringify({
    paths: paths.length, base, head, mergeBase: ancestor, actualTree, expectedTree,
    patchBytes: Buffer.byteLength(patch), sha256: createHash("sha256").update(patch).digest("hex"),
    modeOnly: true, binary: true, rename: true, deletion: true, divergentBaseExcluded: true,
  }));
  const fetch = commands.find(command => command.args.includes("fetch"))!;
  expect(fetch.env.GIT_CONFIG_VALUE_0).toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"));
  expect(commands.filter(command => command.env.GIT_CONFIG_VALUE_0)).toHaveLength(1);
  expect(commands.every(command => !command.args.includes("checkout"))).toBe(true);
});

test.each(["base", "head", "changed_files"])("A3: changing captured %s fails closed after acquisition", async field => {
  redirectFetch(); const { utils, get, metadata } = api();
  get.mockResolvedValueOnce({ data: metadata }).mockResolvedValueOnce({ data: {
    ...metadata, [field]: field === "changed_files" ? 378 : { sha: ancestor },
  } });
  await expect(utils.getPullRequestDiff("fixture", "repository", 1)).rejects.toThrow("NATIVE_DIFF_SNAPSHOT_CHANGED");
});

test("A3: incorrect captured path count aborts rather than returning a complete-looking prefix", async () => {
  redirectFetch(); const { utils } = api(378);
  await expect(utils.getPullRequestDiff("fixture", "repository", 1)).rejects.toThrow("NATIVE_DIFF_PATH_COUNT_MISMATCH");
});

test.each(["missing", "unrelated"])("A3/A4: real %s object/ancestry failure is safe and cleaned up", async kind => {
  redirectFetch(); const { utils, get, metadata } = api();
  get.mockResolvedValue({ data: { ...metadata, head: { sha: kind === "missing" ? "f".repeat(40) : unrelated } } });
  await expect(utils.getPullRequestDiff("fixture", "repository", 1)).rejects.toThrow(/^NATIVE_DIFF_COMMAND_FAILED$/);
});

test("A4: missing explicit token never starts Git or falls back to anonymous", async () => {
  const { request, get } = api(); const spy = jest.spyOn(childProcess, "spawn");
  const utils = new GitUtils({ request, rest: { pulls: { get } } } as unknown as Octokit);
  await expect(utils.getPullRequestDiff("fixture", "repository", 1)).rejects.toThrow("NATIVE_DIFF_INVALID_SNAPSHOT");
  expect(spy).not.toHaveBeenCalled();
});

test("A4: inherited Git helpers, tracing and config injection do not reach children", async () => {
  const keys = ["GIT_EXTERNAL_DIFF", "GIT_TRACE", "GIT_TRACE_CURL", "GIT_CONFIG_PARAMETERS", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
  const saved = keys.map(key => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "synthetic-host-injection";
    redirectFetch(); const { utils } = api();
    expect(await utils.getPullRequestDiff("fixture", "repository", 1)).toContain("FINAL_LARGE_PATCH_MARKER");
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
  }
});

test("N7/A4: cleanup failure is explicit even after a valid real-Git patch", async () => {
  redirectFetch(); const { utils } = api();
  const realRm = fs.rm;
  const spy = jest.spyOn(fs, "rm").mockRejectedValueOnce(new Error(TOKEN));
  await expect(utils.getPullRequestDiff("fixture", "repository", 1)).rejects.toThrow(/^NATIVE_DIFF_CLEANUP_FAILED$/);
  spy.mockRestore();
  for (const directory of temporary) await realRm(directory, { recursive: true, force: true });
});


test("N9: ordinary API diff remains byte identical on unsupported native platform", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const { utils, request, get } = api();
    const patch = "diff --git a/literal b/literal\n+é\r\n";
    request.mockResolvedValueOnce({ data: patch });
    const launch = jest.spyOn(childProcess, "spawn");
    expect(await utils.getPullRequestDiff("fixture", "repository", 1)).toBe(patch);
    expect(get).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, "platform", platform); }
});
