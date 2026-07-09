import { readFileSync, readdirSync } from "fs";
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
const advancedDocs = readFileSync(join(repoRoot, "docs", "ADVANCED.md"), "utf8");
const actionYml = readFileSync(join(repoRoot, "action.yml"), "utf8");

const slashCommandGate =
  "startsWith(github.event.comment.body, '/robin')";

/** Inputs that are secrets / token on the action, not workflow_call inputs. */
const ACTION_ONLY_SECRETS = new Set([
  "github-token",
  "llm-api-key",
  "llm-base-url",
  "model",
]);

/** Workflow-only input (not an action input). */
const WORKFLOW_ONLY_INPUTS = new Set(["runner"]);

/** Empty default means "defer to .github/robin.yml" — must stay string, not boolean. */
const DEFER_TO_CONFIG_INPUTS = ["request-changes", "use-json-response-mode"] as const;

function parseActionInputs(source: string): string[] {
  return [...source.matchAll(/^  ([a-z0-9-]+):\n    description:/gm)].map(
    (match) => match[1],
  );
}

function publicActionInputs(): string[] {
  return parseActionInputs(actionYml).filter((name) => !ACTION_ONLY_SECRETS.has(name));
}

/** Keys under `on.workflow_call.inputs` (4-space indent under `inputs:`). */
function workflowCallInputNames(source: string): string[] {
  const callSection = source.split(/\n\s+secrets:\n/)[0] ?? source;
  const inputsBlock = callSection.split(/\n\s+inputs:\n/)[1];
  if (!inputsBlock) return [];
  return [...inputsBlock.matchAll(/^      ([a-z0-9-]+):\n/gm)].map((match) => match[1]);
}

/**
 * Collect `key:` names from a YAML mapping that starts after `with:`.
 * Skips blank lines and `#` comments so fixtures can document values.
 */
function mappingKeysAfterWith(source: string, withIndent: string): string[] {
  const marker = `\n${withIndent}with:\n`;
  const start = source.indexOf(marker);
  if (start < 0) return [];
  const body = source.slice(start + marker.length);
  const keyIndent = `${withIndent}  `;
  const keys: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!line.startsWith(keyIndent)) break;
    if (line.slice(keyIndent.length).startsWith(" ")) continue; // nested
    const match = line.slice(keyIndent.length).match(/^([a-z0-9-]+):/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** `with:` keys on the Robin action step inside review.yml. */
function forwardedActionInputNames(source: string): string[] {
  return mappingKeysAfterWith(source, "        ").filter(
    (name) => !ACTION_ONLY_SECRETS.has(name),
  );
}

/** Top-level `with:` keys under the consumer job that calls the reusable workflow. */
function consumerWorkflowWithKeys(source: string): string[] {
  return mappingKeysAfterWith(source, "    ");
}

function workflowCallInputBlock(source: string, name: string): string | undefined {
  const callSection = source.split(/\n\s+secrets:\n/)[0] ?? source;
  const match = callSection.match(
    new RegExp(`^      ${name}:\\n((?:        [^\\n]*\\n)+)`, "m"),
  );
  return match?.[1];
}

describe("reusable review workflow", () => {
  it.each([
    ["review.yml", reviewWorkflow],
    ["self-test.yml", selfTestWorkflow],
    ["templates/robin.yml", robinTemplate],
  ])("accepts /robin comment triggers in %s", (_name, workflow) => {
    expect(workflow).toContain(slashCommandGate);
    expect(workflow).toContain("startsWith(github.event.comment.body, '/review')");
  });

  it("exposes every non-secret action input through workflow_call and forwards it", () => {
    const expected = [...publicActionInputs(), ...WORKFLOW_ONLY_INPUTS].sort();
    expect(workflowCallInputNames(reviewWorkflow).sort()).toEqual(expected);

    const forwarded = forwardedActionInputNames(reviewWorkflow).sort();
    expect(forwarded).toEqual(publicActionInputs().sort());

    for (const name of publicActionInputs()) {
      expect(reviewWorkflow).toContain(`${name}: \${{ inputs.${name} }}`);
    }
  });

  it("keeps defer-to-config knobs as empty-default strings (not booleans)", () => {
    for (const name of DEFER_TO_CONFIG_INPUTS) {
      const block = workflowCallInputBlock(reviewWorkflow, name);
      expect(block).toBeDefined();
      expect(block).toContain("type: string");
      expect(block).toContain('default: ""');
    }
  });

  it("documents every public action input in ADVANCED.md", () => {
    for (const name of publicActionInputs()) {
      expect(advancedDocs).toContain(`\`${name}\``);
    }
  });

  it("keeps a consumer fixture that exercises every workflow_call input", () => {
    const fixtureDir = join(repoRoot, "testdata", "consumer-workflows");
    const fixtures = readdirSync(fixtureDir).filter((name) => name.endsWith(".yml"));
    expect(fixtures).toContain("all-inputs.yml");

    const fixture = readFileSync(join(fixtureDir, "all-inputs.yml"), "utf8");
    expect(consumerWorkflowWithKeys(fixture).sort()).toEqual(
      workflowCallInputNames(reviewWorkflow).sort(),
    );
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
