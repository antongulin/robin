#!/usr/bin/env node
/**
 * npx robin-review — adds the Robin code-review workflow to the current repo.
 * Node port of scripts/install.sh, so it works anywhere npx does (incl. Windows).
 *
 * Writes one file (.github/workflows/robin.yml), never overwrites an existing
 * one, then best-effort installs the Robin companion skill for coding agents.
 * Env overrides: ROBIN_REF=v1 (action ref), ROBIN_SKILL=0 (skip skill install).
 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const info = (msg) => console.log("\x1b[0;32m🏹 " + msg + "\x1b[0m");
const warn = (msg) => console.log("\x1b[0;33m🏹 " + msg + "\x1b[0m");
const die = (msg) => {
  console.error("\x1b[0;31m🏹 " + msg + "\x1b[0m");
  process.exit(1);
};

const ref = process.env.ROBIN_REF || "main";

let root;
try {
  root = cp
    .execSync("git rev-parse --show-toplevel", { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  die("Not a git repository. cd into your repo and run again.");
}

const workflowPath = path.join(root, ".github", "workflows", "robin.yml");
const workflow = `name: Robin

on:
  pull_request:
    types: [opened, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@${ref}
    secrets:
      LLM_API_KEY: \${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: \${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: \${{ secrets.LLM_MODEL }}
`;

if (fs.existsSync(workflowPath)) {
  warn(workflowPath + " already exists — leaving it untouched.");
} else {
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, workflow);
  info("Created " + path.relative(root, workflowPath));
}

if (process.env.ROBIN_SKILL !== "0") {
  info("Installing the Robin chat skill for coding agents…");
  try {
    cp.execSync(
      'npx -y skills add https://github.com/antongulin/robin --skill robin --agent "*" --global --yes',
      { stdio: "ignore" }
    );
    info('Robin chat skill installed (all agents). Say "review with Robin".');
  } catch {
    warn(
      "Couldn't auto-install the skill. Run: npx skills add https://github.com/antongulin/robin --all --global"
    );
  }
}

info("Next steps:");
console.log(`
  1. Add three repository secrets (Settings → Secrets and variables → Actions):
       LLM_API_KEY   — e.g. your OpenRouter key (sk-or-…)
       LLM_BASE_URL  — e.g. https://openrouter.ai/api/v1
       LLM_MODEL     — e.g. openrouter/free
  2. Commit and push .github/workflows/robin.yml
  3. Open a PR — Robin reviews it automatically. Comment /robin to re-run.

  Docs: https://github.com/antongulin/robin#readme
`);
