import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = path.resolve(__dirname, "..");
const installers = [
  ["npm", process.execPath, path.join(root, "bin/robin-review.js")],
  ["shell", "bash", path.join(root, "scripts/install.sh")],
];

describe.each(installers)("%s custom identity preservation", (_name, command, script) => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "robin-identity-"));
    cp.execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.mkdirSync(path.join(dir, ".github/workflows"), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = () => cp.execFileSync(command, [script], {
    cwd: dir,
    env: { ...process.env, ROBIN_SKILL: "0", ROBIN_REF: "main" },
    encoding: "utf8",
  });

  it.each([
    ["robin.yml", "    secrets:\n      ROBIN_TOKEN: ${{ secrets.REVIEW_PAT }}\n      LLM_API_KEY: ${{ secrets.CUSTOM_LLM_KEY }}"],
    ["custom-review.yaml", "    secrets: inherit"],
    ["robin.yml", "    secrets:\n      'ROBIN_TOKEN': ${{ secrets.REVIEW_PAT }}"],
    ["robin.yml", "    secrets: { ROBIN_TOKEN: '${{ secrets.REVIEW_PAT }}' }"],
    ["robin.yml", "    secrets: 'inherit'"],
    ["robin.yml", "    secrets:\n      inherit"],
  ])("keeps %s and its job dependencies intact on repeated installs", (filename, secrets) => {
    const workflow = [
      "name: Custom reviewer", "on: [pull_request]", "jobs:",
      "  prepare:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo ready",
      "  review:", "    needs: prepare",
      "    uses: antongulin/robin/.github/workflows/review.yml@v2",
      "    with:", '      llm-temperature: "1"', secrets, "",
    ].join("\r\n");
    const target = path.join(dir, ".github/workflows", filename);
    fs.writeFileSync(target, workflow);
    for (let i = 0; i < 2; i++) {
      expect(run()).toContain("custom identity");
      expect(fs.readFileSync(target, "utf8")).toBe(workflow);
      expect(fs.readdirSync(path.join(dir, ".github/workflows"))).toEqual([filename]);
      expect(fs.existsSync(path.join(dir, ".github/robin-workflow-archive"))).toBe(false);
    }
  });

  it("keeps App token creation and the direct action in the same job", () => {
    const workflow = [
      "name: App reviewer", "on: [pull_request]", "jobs:", "  review:",
      "    runs-on: ubuntu-latest", "    steps:",
      "      - uses: actions/create-github-app-token@v2", "        id: app-token",
      "        with:", "          app-id: ${{ vars.ROBIN_APP_ID }}",
      "          private-key: ${{ secrets.ROBIN_APP_PRIVATE_KEY }}",
      "      - uses: antongulin/robin@v2", "        with:",
      "          github-token: ${{ steps.app-token.outputs.token }}", "",
    ].join("\n");
    const target = path.join(dir, ".github/workflows/app-review.yml");
    fs.writeFileSync(target, workflow);
    expect(run()).toContain("custom identity");
    expect(fs.readFileSync(target, "utf8")).toBe(workflow);
    expect(fs.readdirSync(path.join(dir, ".github/workflows"))).toEqual(["app-review.yml"]);
  });

  it.each([['"', "robin.yml"], ["'", "custom.yml"]])("preserves quoted uses values (%s)", (quote, filename) => {
    const workflow = [
      "name: Quoted identity", "on: [pull_request]", "jobs:", "  review:",
      `    uses: ${quote}antongulin/robin/.github/workflows/review.yml@v2${quote}`,
      "    secrets:", "      ROBIN_TOKEN: ${{ secrets.REVIEW_PAT }}", "",
    ].join("\n");
    const target = path.join(dir, ".github/workflows", filename);
    fs.writeFileSync(target, workflow);
    expect(run()).toContain("custom identity");
    expect(fs.readFileSync(target, "utf8")).toBe(workflow);
    expect(fs.readdirSync(path.join(dir, ".github/workflows"))).toEqual([filename]);
  });
});
