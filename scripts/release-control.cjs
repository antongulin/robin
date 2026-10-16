#!/usr/bin/env node
"use strict";

// Run only from the workflow revision, never from the release tree being tested.
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");

const BRANCH = "release-please--branches--main--components--robin";
const PENDING = "autorelease: pending";
const TAGGED = "autorelease: tagged";
const FIELDS = "number,url,author,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,state,mergeCommit,labels,reviewDecision,mergeStateStatus";
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function command(file, args, allowed = [0]) {
  // checkout persists no credentials. Fetch/push authentication lives only in this child.
  const env = { ...process.env };
  if (file === "git" && env.GH_TOKEN) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString("base64")}`;
  }
  const result = spawnSync(file, args, { encoding: "utf8", env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || !allowed.includes(result.status)) {
    throw new Error(`${file} ${args[0]} failed (${result.status ?? "process error"}): ${result.stderr || result.error?.message || "unknown error"}`);
  }
  return { status: result.status, text: result.stdout.trim() };
}

function number(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Invalid release PR number.");
  }
  return String(value);
}

function requireSha(value) {
  if (typeof value !== "string" || !SHA.test(value)) throw new Error("Missing or malformed release commit SHA.");
  return value;
}

function context() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo || "")) throw new Error("Invalid release repository.");
  if (process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Run Release on main, including recovery dispatches.");
  return repo;
}

function readPr(repo, prNumber) {
  const pr = JSON.parse(command("gh", ["pr", "view", number(prNumber), "--repo", repo, "--json", FIELDS]).text);
  const labels = pr.labels?.map(label => label.name) || [];
  if (String(pr.number) !== number(prNumber) || pr.url !== `https://github.com/${repo}/pull/${prNumber}` ||
      pr.baseRefName !== "main" || pr.isCrossRepository !== false || pr.isDraft !== false ||
      pr.author?.is_bot !== true || pr.author?.login !== "app/github-actions" || pr.headRefName !== BRANCH ||
      !["OPEN", "MERGED"].includes(pr.state) ||
      !(labels.includes(PENDING) || (pr.state === "MERGED" && labels.includes(TAGGED)))) {
    throw new Error(`Untrusted or ineligible release PR #${prNumber}.`);
  }
  if (pr.state === "MERGED") requireSha(pr.mergeCommit?.oid);
  else requireSha(pr.headRefOid);
  return pr;
}

function output(values) {
  for (const [key, value] of Object.entries(values)) {
    console.log(`${key}=${value}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function waiting(pr) {
  summary(`WAITING: release PR #${pr.number} needs maintainer approval and merge. Review ${pr.url} at its current head, then squash-merge it through GitHub. The main push resumes publication; recovery: run Release on main with release-pr=${pr.number}. No release was published.`);
  return { number: String(pr.number), state: "WAITING", sha: requireSha(pr.headRefOid) };
}

function select(repo) {
  let prNumber = process.env.RELEASE_PR_NUMBER?.trim();
  if (prNumber) prNumber = number(prNumber);
  if (!prNumber && process.env.GITHUB_EVENT_NAME === "push") {
    const sha = requireSha(process.env.GITHUB_SHA);
    // Use the PR connection, not commit search's eventually updated search index.
    const candidates = JSON.parse(command("gh", ["pr", "list", "--repo", repo, "--base", "main", "--head", BRANCH,
      "--state", "merged", "--limit", "20", "--json", "number,mergeCommit"]).text);
    const exact = candidates.filter(pr => pr.mergeCommit?.oid === sha);
    if (exact.length > 1) throw new Error("Ambiguous release PRs for the pushed merge SHA.");
    if (exact.length === 1) {
      // All trust checks still run against fresh, complete PR metadata below.
      prNumber = number(exact[0].number);
    }
  }
  if (!prNumber) {
    const pr = JSON.parse(process.env.RELEASE_PR || "null");
    const prs = JSON.parse(process.env.RELEASE_PRS || "null");
    if (pr?.number !== undefined || prs?.[0]?.number !== undefined) prNumber = number(pr?.number ?? prs[0].number);
  }
  if (!prNumber && process.env.RELEASE_PRS_CREATED === "true") throw new Error("Release Please reported no valid release PR number.");
  if (!prNumber) return output({ state: "SKIP" });
  const pr = readPr(repo, prNumber);
  output({ number: prNumber, state: pr.state, sha: pr.state === "MERGED" ? pr.mergeCommit.oid : pr.headRefOid });
}

function fetchMain() {
  command("git", ["fetch", "--force", "--tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
}

function onMain(sha) {
  if (command("git", ["rev-parse", `${sha}^{commit}`]).text !== sha) throw new Error("Release commit identity mismatch.");
  if (command("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"], [0, 1]).status !== 0) {
    throw new Error("Release merge commit is not reachable on main.");
  }
}

function selectedPr(repo) {
  const pr = readPr(repo, number(process.env.RELEASE_PR_NUMBER));
  const sha = requireSha(process.env.SELECTED_SHA);
  const state = process.env.SELECTED_STATE;
  if (!["OPEN", "MERGED"].includes(state)) throw new Error("Invalid selected release state.");
  if ((state === "OPEN" && pr.headRefOid !== sha) ||
      (state === "MERGED" && (pr.state !== "MERGED" || pr.mergeCommit.oid !== sha))) {
    throw new Error("Release PR changed since selection/verification; run Release again.");
  }
  return { pr, sha, state };
}

function checkout(repo) {
  const { pr, sha, state } = selectedPr(repo);
  fetchMain();
  if (state === "MERGED") onMain(sha);
  else {
    command("git", ["fetch", "--no-tags", "origin", sha]);
    if (command("git", ["rev-parse", `${sha}^{commit}`]).text !== sha) throw new Error("Release head identity mismatch.");
  }
  command("git", ["checkout", "--detach", sha]);
  summary(`Verifying release PR #${pr.number} at immutable ${state.toLowerCase()} commit ${sha}.`);
}

function extractNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`Release notes for v${version} were empty or malformed.`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
  const notes = lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
  if (!notes.split("\n").slice(1).some(line => line.trim())) throw new Error(`Release notes for v${version} were empty or malformed.`);
  return notes;
}

function release(repo, tag) {
  const result = command("gh", ["api", `repos/${repo}/releases/tags/${tag}`], [0, 1]);
  const data = JSON.parse(result.text);
  if (result.status !== 0) {
    if (String(data.status) === "404") return undefined;
    throw new Error(`Could not read GitHub release ${tag}: ${data.message || "API error"}`);
  }
  if (data.tag_name !== tag || data.draft !== false || data.prerelease !== false) throw new Error(`Unexpected existing release state for ${tag}.`);
  return data;
}

function tagSha(tag) {
  if (command("git", ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`], [0, 1]).status === 1) return undefined;
  return requireSha(command("git", ["rev-parse", `${tag}^{commit}`]).text);
}

function compareVersion(a, b) {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function stableVersions() {
  return command("git", ["tag", "--list"]).text.split("\n")
    .filter(tag => tag.startsWith("v") && VERSION.test(tag.slice(1))).map(tag => tag.slice(1));
}

function updateFloatingTags(version, sha) {
  const versions = stableVersions();
  const [major, minor] = version.split(".");
  const targets = [];
  for (const prefix of [major, `${major}.${minor}`]) {
    const newer = versions.some(value => (value === prefix || value.startsWith(`${prefix}.`)) && compareVersion(value, version) > 0);
    if (!newer) targets.push([`v${prefix}`, sha]);
  }
  // Preserve @v1 compatibility for v2+ consumers of the old major stream.
  if (major !== "1") {
    const latest = versions.filter(value => value.startsWith("1.")).sort(compareVersion).at(-1);
    if (latest) targets.push(["v1", requireSha(tagSha(`v${latest}`))]);
  }
  for (const [tag, commit] of targets) {
    if (tagSha(tag) === commit) continue;
    command("git", ["tag", "-f", tag, commit]);
    command("git", ["push", "origin", "--force", `refs/tags/${tag}`]);
  }
}

function publish(repo) {
  let { pr, sha, state } = selectedPr(repo);
  if (pr.state === "OPEN") {
    if (pr.reviewDecision !== "APPROVED") return output(waiting(pr));
    if (pr.mergeStateStatus !== "CLEAN") throw new Error(`Approved release PR is not mergeable (${pr.mergeStateStatus}).`);
    command("gh", ["pr", "merge", String(pr.number), "--repo", repo, "--squash", "--delete-branch", "--match-head-commit", sha]);
    pr = readPr(repo, pr.number);
    if (pr.state !== "MERGED" || pr.headRefOid !== sha) throw new Error("Release PR was not merged at the verified head.");
  }
  const merged = requireSha(pr.mergeCommit?.oid);
  fetchMain();
  onMain(merged);
  if (state === "OPEN") {
    // A squash merge may incorporate a newer base. Publish only the exact tested tree.
    // If the tree differs, recovery dispatch verifies the actual merged tree instead.
    command("git", ["fetch", "--no-tags", "origin", sha]);
    if (command("git", ["diff", "--quiet", sha, merged], [0, 1]).status !== 0) {
      throw new Error("Merged release tree differs from the verified head. Run Release on main with this release-pr number to verify the merged tree.");
    }
  }
  const version = JSON.parse(command("git", ["show", `${merged}:.release-please-manifest.json`]).text)["."];
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error("Invalid release manifest version.");
  const pkg = JSON.parse(command("git", ["show", `${merged}:package.json`]).text);
  if (pkg.name !== "robin-review" || pkg.version !== version) throw new Error("Release package and manifest versions disagree.");
  const tag = `v${version}`;
  const notes = extractNotes(command("git", ["show", `${merged}:CHANGELOG.md`]).text, version);
  let existingSha = tagSha(tag);
  if (existingSha && existingSha !== merged) throw new Error(`Existing release tag ${tag} points to ${existingSha}, not ${merged}.`);
  const existing = release(repo, tag);
  if (existing && !existingSha) throw new Error(`Existing release ${tag} has no verifiable tag.`);
  if (!existing) {
    const args = ["release", "create", tag, "--repo", repo, "--target", merged, "--title", tag, "--notes", notes];
    if (stableVersions().some(value => compareVersion(value, version) > 0)) args.push("--latest=false");
    command("gh", args);
    fetchMain();
    existingSha = tagSha(tag);
    if (existingSha !== merged || !release(repo, tag)) throw new Error("Created release does not match the verified merge commit.");
  }
  updateFloatingTags(version, merged);
  // Refresh identity, immutable SHA and label state before label mutations.
  pr = readPr(repo, pr.number);
  if (pr.state !== "MERGED" || pr.mergeCommit.oid !== merged) throw new Error("Release PR changed before label update.");
  const labels = pr.labels.map(label => label.name);
  if (!labels.includes(TAGGED) || labels.includes(PENDING)) {
    const args = ["pr", "edit", String(pr.number), "--repo", repo, "--add-label", TAGGED];
    if (labels.includes(PENDING)) args.push("--remove-label", PENDING);
    command("gh", args);
  }
  // GITHUB_TOKEN suppresses release-event workflows; dispatch is exempt. Never use moving main.
  command("gh", ["workflow", "run", "publish.yml", "--repo", repo, "--ref", tag]);
  summary(`Published ${tag} from verified release PR #${pr.number}, merge ${merged}. npm publication dispatched at ${tag}.`);
}

function main() {
  const repo = context();
  const phase = process.argv[2];
  if (phase === "select") select(repo);
  else if (phase === "checkout") checkout(repo);
  else if (phase === "publish") publish(repo);
  else throw new Error("Expected release-control phase: select, checkout, or publish.");
}

module.exports = { extractNotes };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
