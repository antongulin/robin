import { execFileSync, spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..");
const releaseWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);
const contributing = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");
const advancedDocs = readFileSync(join(repoRoot, "docs", "ADVANCED.md"), "utf8");
const publishWorkflow = readFileSync(join(repoRoot, ".github/workflows/publish.yml"), "utf8");

function getWorkflowRunStep(workflow: string, stepName: string): string {
  const lines = workflow.split("\n");
  const stepIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);

  if (stepIndex === -1) {
    throw new Error(`Could not find workflow step: ${stepName}`);
  }

  const runIndex = lines.findIndex(
    (line, index) => index > stepIndex && line.trim() === "run: |",
  );

  if (runIndex === -1) {
    throw new Error(`Could not find run block for workflow step: ${stepName}`);
  }

  const runIndent = lines[runIndex].match(/^ */)?.[0].length ?? 0;
  const runBlock: string[] = [];

  for (const line of lines.slice(runIndex + 1)) {
    const indent = line.match(/^ */)?.[0].length ?? 0;

    if (line.trim() !== "" && indent <= runIndent) {
      break;
    }

    runBlock.push(line.slice(runIndent + 2));
  }

  return runBlock.join("\n");
}

describe("release workflow", () => {
  it("REL1–3: constrains merging to verified commits and supports branch-free recovery", () => {
    expect(releaseWorkflow).not.toContain("gh pr checkout");
    expect(releaseWorkflow).toContain("release-pr:");
    expect(releaseWorkflow).toContain("persist-credentials: false");
  });
  it("keeps verification read-only and publication on trusted orchestration code", () => {
    expect(releaseWorkflow).toMatch(/uses:\s*googleapis\/release-please-action@v4[\s\S]*?skip-github-release:\s*true/);
    const verify = releaseWorkflow.split("  verify-release:\n")[1].split("  publish-release:\n")[0];
    expect(verify).toContain("contents: read");
    expect(verify).toContain("needs.auto-release.outputs.state == 'OPEN'");
    expect(verify).not.toContain("APPROVED");
    expect(verify).not.toContain("contents: write");
    expect(verify).toContain('cp scripts/release-control.cjs "$RUNNER_TEMP/release-control.cjs"');
    expect(verify).toContain('node "$RUNNER_TEMP/release-control.cjs" checkout');
    expect(verify).toContain("npm ci");
    expect(verify).toContain("npm run lint");
    expect(verify).toContain("npm test -- --runInBand");
    expect(verify).toContain("git diff --exit-code dist/index.js");
    expect(releaseWorkflow).toContain("ref: ${{ github.workflow_sha }}");
    const publish = releaseWorkflow.split("  publish-release:\n")[1];
    expect(publish).toContain("needs.verify-release.result == 'success'");
    expect(publish).toContain("node scripts/release-control.cjs publish");
    expect(publish).not.toMatch(/npm (ci|test|run)/);
    expect(releaseWorkflow).toContain("!cancelled()");
    expect(releaseWorkflow).toContain("needs.release-please.result == 'skipped'");
    expect(releaseWorkflow).not.toContain("--admin");
    expect(releaseWorkflow).not.toContain("--auto");
  });

  it("documents approval waiting, automatic human-merge continuation and current-workflow recovery", () => {
    expect(contributing).toContain("WAITING");
    expect(contributing).toContain("release-pr");
    expect(contributing).toContain("deleted");
    expect(advancedDocs).toContain("release-pr");
  });

  it("extracts release notes from the selected version without including the previous release", () => {
    const changelog = [
      "# Changelog",
      "",
      "## [1.2.1](https://example.com/compare/v1.2.0...v1.2.1) (2026-05-19)",
      "",
      "### Bug Fixes",
      "",
      "* harden auto release workflow",
      "",
      "## [1.2.0](https://example.com/compare/v1.1.2...v1.2.0) (2026-05-18)",
      "",
      "* previous release",
      "",
    ].join("\n");

    const notes = execFileSync(process.execPath, ["-e",
      "const helper = require(process.argv[1]); process.stdout.write(helper.extractNotes(process.argv[2], process.argv[3]));",
      join(repoRoot, "scripts/release-control.cjs"), changelog, "1.2.1"], { encoding: "utf8" });

    expect(notes).toContain("## [1.2.1]");
    expect(notes).toContain("* harden auto release workflow");
    expect(notes).not.toContain("## [1.2.0]");
  });

  it.each([
    ["refs/tags/v2.12.0", "v2.12.0", "2.12.0", true],
    ["refs/heads/main", "main", "2.12.0", false],
    ["refs/tags/v2.12.0", "v2.12.0", "2.13.0", false],
    ["refs/tags/v2", "v2", "2.12.0", false],
  ])("REL5: npm publication enforces intended tag/package version (%s, %s, %s)", (ref, tag, version, valid) => {
    const step = getWorkflowRunStep(publishWorkflow, "Verify release version");
    const program = step.split("node - <<'JS'\n")[1].split("\nJS")[0]
      .replace("require('./package.json')", JSON.stringify({ name: "robin-review", version }));
    const result = spawnSync(process.execPath, ["-e", program], {
      env: { GITHUB_REF: ref, RELEASE_TAG: tag }, encoding: "utf8",
    });
    expect(result.status).toBe(valid ? 0 : 1);
    expect(publishWorkflow).toContain("ref: ${{ github.sha }}");
  });
});
