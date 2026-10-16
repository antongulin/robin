"use strict";

// Offline gh/git process boundary. No network or real repository mutation.
const fs = require("node:fs");
const fixturePath = process.env.RELEASE_FIXTURE;
const state = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const [file, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TRACE, JSON.stringify({ file, args }) + "\n");
let status = 0;
let output = "";
const json = value => { output = JSON.stringify(value); };
const option = name => args[args.indexOf(name) + 1];

if (file === "gh") {
  if (args[0] === "pr" && args[1] === "list") json(state.candidates || []);
  else if (args[0] === "pr" && args[1] === "view") {
    if (state.viewError) { status = 1; output = "API unavailable"; }
    else json(state.views?.length ? state.views.shift() : state.pr);
  } else if (args[0] === "pr" && args[1] === "merge") {
    if (state.mergeError || option("--match-head-commit") !== state.pr.headRefOid) {
      status = 1; output = "merge refused";
    } else state.pr = state.afterMerge;
  } else if (args[0] === "api") {
    const tag = args[1].split("/").at(-1);
    if (state.apiError) { status = 1; json({ status: "403", message: "Forbidden" }); }
    else if (state.releases?.[tag]) json(state.releases[tag]);
    else { status = 1; json({ status: "404", message: "Not Found" }); }
  } else if (args[0] === "release" && args[1] === "create") {
    const tag = args[2];
    state.tags[tag] = option("--target");
    state.releases ||= {};
    state.releases[tag] = { tag_name: tag, draft: false, prerelease: false };
  } else if (args[0] === "pr" && args[1] === "edit") {
    if (state.labelError) { status = 1; output = "label update refused"; }
    else state.pr.labels = [{ name: "autorelease: tagged" }];
  } else if (args[0] === "workflow" && args[1] === "run") {
    if (state.dispatchError) { status = 1; output = "dispatch refused"; }
  } else { status = 2; output = "Unexpected fake gh command"; }
} else if (file === "git") {
  if (args[0] === "fetch" || args[0] === "checkout" || args[0] === "push") {
    if (state.fetchError && args[0] === "fetch") { status = 1; output = "fetch failed"; }
  } else if (args[0] === "rev-parse") {
    const ref = args[1].replace(/\^\{commit\}$/, "");
    output = state.tags[ref] || ref;
  } else if (args[0] === "merge-base") status = state.onMain === false ? 1 : 0;
  else if (args[0] === "diff") status = state.treeChanged ? 1 : 0;
  else if (args[0] === "show") {
    const path = args[1].split(":")[1];
    if (path === ".release-please-manifest.json") json({ ".": state.version || "2.12.0" });
    else if (path === "package.json") json({ name: "robin-review", version: state.packageVersion || state.version || "2.12.0" });
    else if (path === "CHANGELOG.md") output = state.changelog || `# Changelog\n\n## [${state.version || "2.12.0"}](https://example.com/compare)\n\n### Bug Fixes\n\n* release recovery\n`;
    else { status = 2; output = "Unexpected file"; }
  } else if (args[0] === "show-ref") status = state.tags[args.at(-1).replace("refs/tags/", "")] ? 0 : 1;
  else if (args[0] === "tag" && args[1] === "--list") output = Object.keys(state.tags).join("\n");
  else if (args[0] === "tag" && args[1] === "-f") state.tags[args[2]] = args[3];
  else { status = 2; output = "Unexpected fake git command"; }
} else { status = 2; output = "Unexpected fixture executable"; }

fs.writeFileSync(fixturePath, JSON.stringify(state));
process.stdout.write(output);
if (status) process.stderr.write(output);
process.exitCode = status;
