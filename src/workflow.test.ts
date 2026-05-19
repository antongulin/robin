import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..");
const reviewWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "review.yml"),
  "utf8",
);
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

describe("reusable review workflow", () => {
  it("lets callers choose a GitHub-hosted or self-hosted runner", () => {
    expect(reviewWorkflow).toContain("runner:");
    expect(reviewWorkflow).toContain(
      'description: "Runner label or JSON array of labels to use for the review job."',
    );
    expect(reviewWorkflow).toContain("default: '\"ubuntu-latest\"'");
    expect(reviewWorkflow).toContain("runs-on: ${{ fromJSON(inputs.runner) }}");
  });

  it("documents Coolify self-hosted runner usage", () => {
    expect(readme).toContain(
      "runner: '[\"self-hosted\", \"linux\", \"coolify\"]'",
    );
  });
});
