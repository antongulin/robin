import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..");
const releaseWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "release.yml"),
  "utf8",
);
const contributing = readFileSync(join(repoRoot, "CONTRIBUTING.md"), "utf8");
const advancedDocs = readFileSync(join(repoRoot, "docs", "ADVANCED.md"), "utf8");

describe("release workflow", () => {
  it("automatically verifies, merges, and publishes release PRs", () => {
    expect(releaseWorkflow).toContain("prs_created:");
    expect(releaseWorkflow).toContain("pr: ${{ steps.release.outputs.pr }}");
    expect(releaseWorkflow).toContain("auto-release:");
    expect(releaseWorkflow).toContain(
      "if: needs.release-please.outputs.prs_created == 'true'",
    );
    expect(releaseWorkflow).toContain("gh pr merge \"$number\" --merge --delete-branch");
    expect(releaseWorkflow).toContain("gh release create \"$tag\"");
    expect(releaseWorkflow).toContain("git push origin -f \"v$major\" \"v$major.$minor\"");
  });

  it("documents that releases publish automatically after merges to main", () => {
    expect(contributing).toContain(
      "Release PRs are verified, merged, and published automatically by the workflow.",
    );
    expect(advancedDocs).toContain(
      "Release PRs are verified, merged, and published automatically by the workflow.",
    );
  });
});
