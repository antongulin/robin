import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(__dirname, "..");
const reviewWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "review.yml"),
  "utf8",
);
const selfTestWorkflow = readFileSync(
  join(repoRoot, ".github", "workflows", "self-test.yml"),
  "utf8",
);
const robinTemplate = readFileSync(join(repoRoot, "templates", "robin.yml"), "utf8");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

const slashCommandGate =
  "startsWith(github.event.comment.body, '/robin')";

describe("reusable review workflow", () => {
  it.each([
    ["review.yml", reviewWorkflow],
    ["self-test.yml", selfTestWorkflow],
    ["templates/robin.yml", robinTemplate],
  ])("accepts /robin comment triggers in %s", (_name, workflow) => {
    expect(workflow).toContain(slashCommandGate);
    expect(workflow).toContain("startsWith(github.event.comment.body, '/review')");
  });

  it("lets callers choose a GitHub-hosted or self-hosted runner", () => {
    expect(reviewWorkflow).toContain("runner:");
    expect(reviewWorkflow).toContain(
      'description: "Runner label or JSON array of labels to use for the review job."',
    );
    expect(reviewWorkflow).toContain("default: '\"ubuntu-latest\"'");
    expect(reviewWorkflow).toContain("runs-on: ${{ fromJSON(inputs.runner) }}");
  });

  it("documents local and Coolify self-hosted runner usage", () => {
    expect(readme).toContain("## Running on a self-hosted runner");
    expect(readme).toContain("runner: '[\"self-hosted\", \"local\"]'");
    expect(readme).toContain(
      "runner: '[\"self-hosted\", \"linux\", \"coolify\"]'",
    );
    expect(readme).toContain("runner: '\"ubuntu-latest\"'");
    expect(readme).toContain(
      "Self-hosted runners can execute arbitrary workflow code.",
    );
    expect(readme).toContain(
      "Repository Settings -> Actions -> Runners -> New self-hosted runner",
    );
    expect(readme).toContain(
      "A matching self-hosted runner must be online when GitHub starts the review job.",
    );
    expect(readme).toContain(
      "Docker is optional; it is just one way to run the GitHub Actions runner.",
    );
    expect(readme).toContain(
      "If no matching runner is online, GitHub queues the job until one comes online.",
    );
  });
});
