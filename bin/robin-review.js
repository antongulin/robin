#!/usr/bin/env node
/**
 * From a Git repository root, npx robin-review adds Robin to that repository.
 * Node port of scripts/install.sh, so it works anywhere npx does (incl. Windows).
 *
 * Keeps one canonical .github/workflows/robin.yml. Historical Robin workflow
 * variants are moved outside the workflows directory before the canonical file
 * is written, then the companion skill is installed or updated globally.
 * Env overrides: ROBIN_REF=v1 (action ref), ROBIN_SKILL=0 (skip skill install).
 */
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const info = (msg) => console.log("\x1b[0;32mRobin: " + msg + "\x1b[0m");
const warn = (msg) => console.log("\x1b[0;33mRobin: " + msg + "\x1b[0m");
const die = (msg) => {
  console.error("\x1b[0;31mRobin: " + msg + "\x1b[0m");
  process.exit(1);
};

const ref = process.env.ROBIN_REF || "main";
if (!/^[A-Za-z0-9._/-]{1,100}$/.test(ref)) die("Invalid ROBIN_REF: " + JSON.stringify(ref));

let root;
try {
  root = cp
    .execSync("git rev-parse --show-toplevel", { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  die("Not a git repository. cd into your repo and run again.");
}

const workflowDir = path.join(root, ".github", "workflows");
const workflowPath = path.join(workflowDir, "robin.yml");
const archiveDir = path.join(root, ".github", "robin-workflow-archive");
const robinReference = /^[ \t]*(?:-[ \t]*)?uses:\s*antongulin\/(?:robin|universal-code-reviewer)(?:\/\.github\/workflows\/review\.ya?ml)?@[^\s#]+/im;
const normalize = (value) => value.replace(/\r\n/g, "\n").trimEnd() + "\n";
const relative = (target) => path.relative(root, target) || ".";

// Keep line positions while hiding comments and block-scalar data from structural
// checks. Scalar indentation is explicit (|2, >-2) or set by its first content line.
function workflowStructure(source) {
  let scalarBase = -1, scalarIndent = 0;
  return source.replace(/\r\n/g, "\n").split("\n").map(line => {
    const d = line.match(/^ */)[0].length;
    if (scalarBase >= 0) {
      if (/^\s*$/.test(line)) return "";
      if (!scalarIndent && d > scalarBase) scalarIndent = d;
      if (scalarIndent && d >= scalarIndent) return "";
      scalarBase = -1;
    }
    let quote = "", code = line;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (quote === '"' && c === "\\") i++;
        else if (c === quote) {
          if (quote === "'" && line[i + 1] === "'") i++;
          else quote = "";
        }
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) { code = line.slice(0, i); break; }
    }
    const header = code.match(/: *[|>]([1-9][+-]?|[+-][1-9]?)? *$/);
    if (header) {
      scalarBase = code.match(/^ *(?:- +)?/)[0].length;
      const explicit = (header[1] || "").match(/[1-9]/);
      scalarIndent = explicit ? scalarBase + Number(explicit[0]) : 0;
    }
    return code;
  });
}

const isRobinSourceRepository = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return (
      pkg.name === "robin-review" &&
      fs.existsSync(path.join(root, "action.yml")) &&
      fs.existsSync(path.join(root, "skills", "robin", "SKILL.md")) &&
      fs.existsSync(path.join(root, ".github", "workflows", "self-test.yml"))
    );
  } catch {
    return false;
  }
})();

const workflowFiles = fs.existsSync(workflowDir)
  ? fs
      .readdirSync(workflowDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => path.join(workflowDir, entry.name))
  : [];

const robinWorkflows = workflowFiles.filter((candidate) =>
  workflowStructure(fs.readFileSync(candidate, "utf8")).some(line => robinReference.test(line))
);

// Keep the whole workflow: custom identity can depend on other steps/jobs. Rebuilding
// just its secrets block would erase that wiring. Conservative detection is intentional.
const customIdentityWorkflows = workflowFiles.filter((candidate) => {
  const source = fs.readFileSync(candidate, "utf8");
  return /antongulin\/robin(?:\/\.github\/workflows\/review\.ya?ml)?@/i.test(source)
    && (/\b(?:ROBIN_TOKEN|github-token)["']?\s*:/.test(source)
      || /\bsecrets["']?\s*:\s*["']?inherit\b/.test(source)
      || /uses:\s*actions\/create-github-app-token@/.test(source));
});

// A narrow block-YAML reader, not a general YAML parser. Refuse forms we cannot
// preserve before touching any workflows or archives. Keep this standalone: npm ships bin/ only.
const modernReference = /antongulin\/robin\/\.github\/workflows\/review\.ya?ml@/i;
function modernCallerLines(source, structure = workflowStructure(source)) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  return structure.flatMap((line, i) => {
    const key = line.match(/(?:^|[{,])[ \t]*(?:-[ \t]*)?["']?uses["']?[ \t]*:/i);
    if (!key) return [];
    const value = line.slice(key.index + key[0].length).trim();
    if (modernReference.test(value)) return [i];
    // Unsupported multiline/quoted/folded calls must still fail closed. Only
    // inspect continuations of this uses value, never a sibling with/run value.
    if (!value || /^["'|>&*!]/.test(value)) {
      const base = line.match(/^ */)[0].length;
      for (let j = i + 1; j < lines.length; j++) {
        const continuation = /^[|>]/.test(value) ? lines[j] : structure[j];
        if (/^\s*$/.test(continuation)) continue;
        if (lines[j].match(/^ */)[0].length <= base) break;
        if (modernReference.test(continuation)) return [i];
      }
    }
    return [];
  });
}
const hasModernCaller = source => modernCallerLines(source).length > 0;
const defaultRunner = "      runner: ${{ github.repository_owner == 'antongulin' && '\"ubicloud-standard-2\"' || '\"ubuntu-latest\"' }}";
function preservedInputs(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const structure = workflowStructure(source);
  const indent = line => line.match(/^ */)[0].length;
  const content = line => !/^\s*(?:#|$)/.test(line);
  const refs = modernCallerLines(source, structure);
  if (!refs.length) return null; // Legacy action inputs use a different schema.
  if (refs.length !== 1 || structure.some(line => /^ *\t/.test(line))) throw new Error("unsupported YAML");
  const u = refs[0];
  const use = lines[u].match(/^ +uses: *antongulin\/robin\/\.github\/workflows\/review\.ya?ml@([A-Za-z0-9._/-]+) *(?:#.*)?$/);
  if (!use) throw new Error("unsupported reusable job");
  const base = indent(lines[u]);
  let start = u - 1, end = u + 1;
  while (start >= 0 && (!content(lines[start]) || indent(lines[start]) >= base)) start--;
  while (end < lines.length && (!content(lines[end]) || indent(lines[end]) >= base)) end++;
  if (start < 0 || !/^ +[A-Za-z0-9_-]+: *(?:#.*)?$/.test(lines[start])) throw new Error("unsupported job mapping");
  let parent = start - 1;
  while (parent >= 0 && (!content(lines[parent]) || indent(lines[parent]) >= indent(lines[start]))) parent--;
  if (parent < 0 || !/^jobs: *(?:#.*)?$/.test(lines[parent])) throw new Error("unsupported jobs mapping");
  const jobLines = lines.slice(start + 1, end);
  if (jobLines.some(line => content(line) && indent(line) === base && !/^ *(?:[A-Za-z0-9_-]+):/.test(line))) throw new Error("unsupported job key");
  const withKeys = jobLines.filter(line => indent(line) === base && /^ *with:/.test(line));
  if (withKeys.length > 1 || (withKeys.length && !/^ *with: *(?:#.*)?$/.test(withKeys[0]))) throw new Error("unsupported with mapping");
  if (!withKeys.length) return { ref: use[1], block: "", hasRunner: false };
  const w = lines.indexOf(withKeys[0], start + 1);
  let stop = w + 1;
  while (stop < end && (!content(structure[stop]) || indent(structure[stop]) > base)) stop++;
  const body = lines.slice(w + 1, stop);
  // Trailing blanks and indented # lines can be literal data in a |+ scalar.
  const entries = structure.slice(w + 1, stop).filter(content);
  const entryIndent = entries.length ? Math.min(...entries.map(indent)) : base + 2;
  if (entries.some(line => /^[&*!]/.test(line.trimStart()))) throw new Error("unsupported input alias/tag");
  const keys = new Set();
  for (const line of entries.filter(line => indent(line) === entryIndent)) {
    const entry = line.trimStart().match(/^([A-Za-z0-9_-]+):(?:\s|$)(.*)$/);
    if (!entry || keys.has(entry[1]) || /^[&*!{[]/.test(entry[2].trimStart())) throw new Error("unsupported input entry");
    keys.add(entry[1]);
  }
  const block = ["    " + lines[w].trimStart(), ...body.map(line =>
    line.length ? " ".repeat(Math.max(0, 4 + indent(line) - base)) + line.slice(indent(line)) : "")];
  return { ref: use[1], block: keys.size ? block.join("\n") : "", hasRunner: keys.has("runner"), runnerIndent: 4 + entryIndent - base };
}

const donor = robinWorkflows.includes(workflowPath) ? workflowPath : robinWorkflows.length === 1 ? robinWorkflows[0] : null;
let preservationError = "";
let preserved = null;
try {
  // Even an explicit ref cannot disambiguate which existing settings to keep.
  if (!donor && robinWorkflows.length > 1 && robinWorkflows.some(file => hasModernCaller(fs.readFileSync(file, "utf8")))) {
    throw new Error("ambiguous modern workflow donors");
  }
  // A quoted/flow/anchored reusable call can fall outside the legacy recognizer.
  for (const file of workflowFiles) {
    const source = fs.readFileSync(file, "utf8");
    if (hasModernCaller(source)) {
      const inputs = preservedInputs(source);
      if (!robinWorkflows.includes(file)) throw new Error("unsupported workflow syntax");
      if (file === donor) preserved = inputs;
    }
  }
} catch (error) {
  preservationError = error.message;
}
let selectedRef = ref;
if (!process.env.ROBIN_REF && preserved && preserved.ref !== "v0") selectedRef = preserved.ref;
if (!process.env.ROBIN_REF && !donor && robinWorkflows.length > 1 && !preservationError) {
  warn(`Multiple Robin workflows found; using default ref (${ref}).`);
}
// Historical/custom refs may not declare runner. Decide only after ref selection;
// preserve explicit inputs without guessing compatibility or fetching a remote schema.
let inputBlock = preserved ? preserved.block : "";
const missingRunner = !preserved || !preserved.hasRunner;
if (missingRunner && selectedRef === "main") {
  inputBlock = inputBlock
    ? inputBlock + "\n" + " ".repeat(preserved.runnerIndent) + defaultRunner.trimStart()
    : "    with:\n" + defaultRunner;
}

const workflow = `# Generated by robin-review. Re-run \`npx robin-review\` to check for updates.
name: Robin

on:
  pull_request:
    types: [opened, reopened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  actions: read
  contents: read
  pull-requests: write

jobs:
  review:
    uses: antongulin/robin/.github/workflows/review.yml@${selectedRef}${inputBlock ? "\n" + inputBlock : ""}
    secrets:
      LLM_API_KEY: \${{ secrets.LLM_API_KEY }}
      LLM_BASE_URL: \${{ secrets.LLM_BASE_URL }}
      LLM_MODEL: \${{ secrets.LLM_MODEL }}
`;

let archivedWorkflowCount = 0;
const archiveWorkflow = (source) => {
  fs.mkdirSync(archiveDir, { recursive: true });
  const original = fs.readFileSync(source, "utf8");
  const base = path.basename(source);
  let destination = path.join(archiveDir, base + ".disabled");
  let suffix = 1;
  while (fs.existsSync(destination) && normalize(fs.readFileSync(destination, "utf8")) !== normalize(original)) {
    destination = path.join(archiveDir, `${base}.${suffix}.disabled`);
    suffix += 1;
  }
  if (fs.existsSync(destination)) {
    fs.unlinkSync(source);
    info(`Removed ${relative(source)} (identical copy already at ${relative(destination)}).`);
  } else {
    fs.renameSync(source, destination);
    info(`Archived ${relative(source)} → ${relative(destination)} (cannot trigger in this location).`);
  }
  archivedWorkflowCount += 1;
};

let workflowChanged = false;
if (isRobinSourceRepository) {
  warn("Robin source repository detected — leaving its self-test workflows untouched.");
  if (fs.existsSync(workflowPath) && robinReference.test(fs.readFileSync(workflowPath, "utf8"))) {
    warn(`${relative(workflowPath)} is a redundant consumer workflow; remove it instead of committing it here.`);
  }
} else if (customIdentityWorkflows.length > 0) {
  warn("Preserved custom identity workflows; no workflow files were changed or archived.");
  for (const file of customIdentityWorkflows) info(relative(file));
  warn("Update workflow refs/settings manually, including any requested ROBIN_REF override.");
} else if (preservationError) {
  warn(`Preserved workflows: ${preservationError}; no workflow files were changed or archived. Update settings manually.`);
} else {
  if (missingRunner && selectedRef !== "main") {
    warn(`Ref ${selectedRef} was not given a runner input; check its declared inputs and repair the pin/runner routing manually.`);
  }
  if (fs.existsSync(workflowPath) && !robinReference.test(fs.readFileSync(workflowPath, "utf8"))) {
    die(`${relative(workflowPath)} exists but is not a Robin workflow. Move or rename it, then run again.`);
  }

  const desired = normalize(workflow);
  const canonicalIsCurrent =
    fs.existsSync(workflowPath) && normalize(fs.readFileSync(workflowPath, "utf8")) === desired;

  for (const candidate of robinWorkflows) {
    if (candidate === workflowPath && canonicalIsCurrent) continue;
    archiveWorkflow(candidate);
    workflowChanged = true;
  }

  if (canonicalIsCurrent) {
    info(`${relative(workflowPath)} is already current.`);
  } else {
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(workflowPath, workflow);
    info(`Created canonical ${relative(workflowPath)} (ref: ${selectedRef}).`);
    workflowChanged = true;
  }
}

if (process.env.ROBIN_SKILL !== "0") {
  info("Installing the Robin chat skill for coding agents…");
  try {
    cp.execSync(
      'npx -y skills add https://github.com/antongulin/robin --skill robin --agent "*" --global --yes',
      { stdio: "ignore", timeout: 180000 }
    );
    info("Robin chat skill installed (all agents). It activates automatically for PR work.");
  } catch {
    warn(
      "Couldn't auto-install the skill. Run: npx -y skills add https://github.com/antongulin/robin --skill robin --agent \"*\" --global --yes"
    );
  }
}

info("Next steps:");
if (isRobinSourceRepository) {
  console.log(`
  Robin's source repository already reviews itself through Self-Test.
  The global companion skill was installed or updated; no consumer workflow is needed here.
`);
} else if (customIdentityWorkflows.length > 0) {
  console.log("Keep your existing token setup. Docs: https://github.com/antongulin/robin/blob/main/docs/ADVANCED.md#custom-review-identity");
} else if (preservationError) {
  info("Review the existing workflow settings manually before rerunning the installer.");
} else {
  console.log(`
  1. Add three repository secrets (Settings → Secrets and variables → Actions):
       LLM_API_KEY   — e.g. your OpenRouter key (sk-or-…)
       LLM_BASE_URL  — e.g. https://openrouter.ai/api/v1
       LLM_MODEL     — e.g. openrouter/free
  2. Commit and push .github/workflows/robin.yml
     ${archivedWorkflowCount > 0 ? "Review and remove .github/robin-workflow-archive after confirming the migration." : workflowChanged ? "A canonical workflow was created." : "No workflow change was needed."}
  3. Open a PR — Robin reviews it automatically. Comment /robin to re-run.

  Docs: https://github.com/antongulin/robin#readme
`);
}
