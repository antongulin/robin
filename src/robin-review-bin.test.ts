import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const BIN = path.resolve(__dirname, "..", "bin", "robin-review.js");

describe("robin-review CLI", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "robin-bin-"));
    cp.execSync("git init -q", { cwd: dir });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (env: Record<string, string> = {}) =>
    cp.execSync(`node "${BIN}"`, {
      stdio: "pipe",
      cwd: dir,
      env: { ...process.env, ROBIN_SKILL: "0", ...env },
    }).toString();

  it("creates the workflow with the given ref and never overwrites it", () => {
    run({ ROBIN_REF: "v2" });

    const workflowPath = path.join(dir, ".github", "workflows", "robin.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("uses: antongulin/robin/.github/workflows/review.yml@v2");
    expect(workflow).toContain("LLM_API_KEY: ${{ secrets.LLM_API_KEY }}");

    fs.writeFileSync(workflowPath, "custom: yes\n");
    const output = run();
    expect(output).toContain("leaving it untouched");
    expect(fs.readFileSync(workflowPath, "utf8")).toBe("custom: yes\n");
  });

  it("rejects a ROBIN_REF with YAML metacharacters", () => {
    expect(() => run({ ROBIN_REF: "main\njobs: {}" })).toThrow();
    expect(fs.existsSync(path.join(dir, ".github", "workflows", "robin.yml"))).toBe(false);
  });

  it("fails outside a git repository", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "robin-nogit-"));
    try {
      expect(() =>
        cp.execSync(`node "${BIN}"`, {
          cwd: bare,
          env: { ...process.env, ROBIN_SKILL: "0" },
          stdio: "pipe",
        })
      ).toThrow();
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
