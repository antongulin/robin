import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..");
const releaseWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);
const contributing = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");
const advancedDocs = readFileSync(join(repoRoot, "docs", "ADVANCED.md"), "utf8");

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
  it("automatically verifies, merges, and publishes release PRs", () => {
    expect(releaseWorkflow).toMatch(
      /prs_created:\s*\$\{\{\s*steps\.release\.outputs\.prs_created\s*\}\}/,
    );
    expect(releaseWorkflow).toMatch(
      /pr:\s*\$\{\{\s*steps\.release\.outputs\.pr\s*\}\}/,
    );
    expect(releaseWorkflow).toMatch(/\n  auto-release:\n/);
    expect(releaseWorkflow).toContain(
      "if: needs.release-please.outputs.prs_created == 'true'",
    );
    expect(releaseWorkflow).toMatch(
      /uses:\s*googleapis\/release-please-action@v4[\s\S]*?with:[\s\S]*?skip-github-release:\s*true/,
    );
    expect(releaseWorkflow).toContain("gh pr merge \"$number\" --squash --delete-branch");
    expect(releaseWorkflow).toContain("gh release create \"$tag\"");
    expect(releaseWorkflow).toContain("git push origin -f \"v$major\" \"v$major.$minor\"");
    expect(releaseWorkflow).toContain('if [ "$major" -ne 1 ]; then');
    expect(releaseWorkflow).toContain('git tag -l "v1.*" --sort=-v:refname');
    expect(releaseWorkflow).toContain("git tag -f v1 \"$v1_sha\"");
    expect(releaseWorkflow).toContain("git push origin -f v1");
    expect(releaseWorkflow).toContain('RELEASE_PENDING_LABEL: "autorelease: pending"');
    expect(releaseWorkflow).toContain('RELEASE_TAGGED_LABEL: "autorelease: tagged"');
    expect(releaseWorkflow).toContain("pending_label=\"$RELEASE_PENDING_LABEL\"");
    expect(releaseWorkflow).toContain("tagged_label=\"$RELEASE_TAGGED_LABEL\"");
    expect(releaseWorkflow).toContain(
      "Cannot verify release PR #$number before updating labels.",
    );
    expect(releaseWorkflow).toContain("[[ ! \"$number\" =~ ^[0-9]+$ ]]");
    expect(releaseWorkflow).toContain(
      "Cannot update release PR labels for ${{ github.repository }}; invalid PR number: $number",
    );
    expect(releaseWorkflow).toContain(
      "label_action=\"add '$tagged_label'\"",
    );
    expect(releaseWorkflow).toContain(
      "label_action=\"remove '$pending_label' and add '$tagged_label'\"",
    );
    expect(releaseWorkflow).toContain(
      "Failed to $label_action on release PR #$number.",
    );
    expect(releaseWorkflow).toContain("label_args=(--add-label \"$tagged_label\")");
    expect(releaseWorkflow).toContain("grep -Fxq \"$pending_label\"");
    expect(releaseWorkflow).toContain(
      "label_args=(--remove-label \"$pending_label\" \"${label_args[@]}\")",
    );
    expect(releaseWorkflow).toContain("set -euo pipefail");
    expect(releaseWorkflow).toContain("Release notes for $tag were empty or malformed.");
    expect(releaseWorkflow).toContain("Existing release tag $tag points to");
    expect(releaseWorkflow).not.toContain("jq ");
    expect(releaseWorkflow).not.toMatch(/\n  verify-release:\n/);
    expect(releaseWorkflow).not.toContain("needs.release-please.outputs.tag_name");
    expect(releaseWorkflow).not.toContain("needs.release-please.outputs.release_created");
  });

  it("documents that releases publish automatically after merges to main", () => {
    expect(contributing).toContain(
      "Release PRs are verified, merged, and published automatically by the workflow.",
    );
    expect(advancedDocs).toContain(
      "Release PRs are verified, merged, and published automatically by the workflow.",
    );
  });

  it("extracts release notes with shell syntax that runs on ubuntu-latest", () => {
    const releaseStep = getWorkflowRunStep(
      releaseWorkflow,
      "Create release and update floating tags",
    );
    const awkMatch = releaseStep.match(/awk -v version="\$version" '\n([\s\S]*?)\n\s*'/);

    expect(awkMatch).not.toBeNull();
    expect(awkMatch?.[1]).toBeDefined();

    const awkProgram = awkMatch![1]
      .split("\n")
      .map((line) => line.trimStart())
      .join("\n");

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

    const notes = execFileSync("awk", ["-v", "version=1.2.1", awkProgram], {
      input: changelog,
      encoding: "utf8",
    });

    expect(notes).toContain("## [1.2.1]");
    expect(notes).toContain("* harden auto release workflow");
    expect(notes).not.toContain("## [1.2.0]");
  });
});
