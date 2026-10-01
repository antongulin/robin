import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { REVIEW_TOOLS, ReviewToolbox } from "./review-tools";

describe("ReviewToolbox", () => {
  let base: string;
  let root: string;
  let toolbox: ReviewToolbox;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "robin-tools-"));
    root = join(base, "repo");
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "src", "auth.ts"), "export function login(user: string) {\n  return user;\n}\n");
    writeFileSync(join(root, "src", "nested", "use.ts"), "import { login } from '../auth';\nlogin('a');\n");
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "login('vendored');\n");
    writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    writeFileSync(join(base, "secret.txt"), "TOP SECRET\n");
    toolbox = new ReviewToolbox(root);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("declares read_file, grep, and list_files", () => {
    expect(REVIEW_TOOLS.map((tool) => tool.function.name)).toEqual(["read_file", "grep", "list_files"]);
  });

  it("reads files with new-file line numbers and supports ranges", async () => {
    const full = await toolbox.execute("read_file", JSON.stringify({ path: "src/auth.ts" }));
    expect(full).toContain("File: src/auth.ts (lines 1-3 of 3)");
    expect(full).toContain("    2    return user;");

    const range = await toolbox.execute("read_file", JSON.stringify({ path: "/src/auth.ts", start_line: 3 }));
    expect(range).toContain("(lines 3-3 of 3)");
    expect(range).not.toContain("return user");
  });

  it("rejects paths that escape the repository", async () => {
    const result = await toolbox.execute("read_file", JSON.stringify({ path: "../secret.txt" }));
    expect(result).toMatch(/^Error: .*outside the repository/);
    expect(result).not.toContain("TOP SECRET");
  });

  it("rejects symlinks that resolve outside the repository", async () => {
    symlinkSync(join(base, "secret.txt"), join(root, "src", "link.txt"));
    const result = await toolbox.execute("read_file", JSON.stringify({ path: "src/link.txt" }));
    expect(result).toMatch(/^Error: .*resolves outside the repository/);
    expect(result).not.toContain("TOP SECRET");
  });

  it("does not follow symlinked directories while searching", async () => {
    symlinkSync(base, join(root, "escape"), "dir");
    const result = await toolbox.execute("grep", JSON.stringify({ pattern: "TOP SECRET" }));
    expect(result).toMatch(/^No matches/);
  });

  it("finds callers with grep, skipping vendored and binary files", async () => {
    const result = await toolbox.execute("grep", JSON.stringify({ pattern: "login\\(" }));
    expect(result).toContain("src/auth.ts:1:");
    expect(result).toContain("src/nested/use.ts:2: login('a');");
    expect(result).not.toContain("node_modules");
  });

  it("filters grep by file-name glob and treats invalid regex as a literal", async () => {
    const byGlob = await toolbox.execute("grep", JSON.stringify({ pattern: "login", glob: "use.ts" }));
    expect(byGlob).toContain("src/nested/use.ts");
    expect(byGlob).not.toContain("src/auth.ts");

    writeFileSync(join(root, "src", "odd.ts"), "const x = call(;\n");
    const literal = await toolbox.execute("grep", JSON.stringify({ pattern: "call(" }));
    expect(literal).toContain("src/odd.ts:1:");
  });

  it("lists directories, recursively when asked", async () => {
    const top = await toolbox.execute("list_files", "{}");
    expect(top).toContain("src/");
    expect(top).toContain("image.png");

    const nested = await toolbox.execute("list_files", JSON.stringify({ path: "src", recursive: true }));
    expect(nested).toContain("src/nested/use.ts");
    expect(nested).not.toContain("node_modules");
  });

  it("shows surrounding lines for grep matches when context_lines is set", async () => {
    const result = await toolbox.execute(
      "grep",
      JSON.stringify({ pattern: "return user", context_lines: 1 })
    );
    expect(result).toContain("src/auth.ts-1- export function login(user: string) {");
    expect(result).toContain("src/auth.ts:2:   return user;");
    expect(result).toContain("src/auth.ts-3- }");
  });

  it("stops read_file on a whole line at the output cap and says where to continue", async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1} ${"x".repeat(40)}`);
    writeFileSync(join(root, "long.txt"), lines.join("\n") + "\n");
    const small = new ReviewToolbox(root, 2_000);

    const first = await small.execute("read_file", JSON.stringify({ path: "long.txt" }));
    const shownThrough = Number(first.match(/\(lines 1-(\d+) of 200\)/)?.[1]);
    expect(shownThrough).toBeGreaterThan(10);
    expect(shownThrough).toBeLessThan(200);
    expect(first).toContain(`call read_file with start_line=${shownThrough + 1}`);
    expect(first).not.toContain("output truncated");
  });

  it("caps output size", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(200) + "\n".repeat(1) + "y".repeat(200));
    const small = new ReviewToolbox(root, 50);
    const result = await small.execute("read_file", JSON.stringify({ path: "big.txt" }));
    expect(result).toContain("[... output truncated at 50 characters]");
  });

  it("reports binary files and bad arguments as text instead of throwing", async () => {
    expect(await toolbox.execute("read_file", JSON.stringify({ path: "image.png" }))).toBe(
      "image.png is a binary file."
    );
    expect(await toolbox.execute("read_file", "{not json")).toMatch(/not valid JSON/);
    expect(await toolbox.execute("read_file", "{}")).toMatch(/"path" is required/);
    expect(await toolbox.execute("delete_everything", "{}")).toMatch(/unknown tool/);
    expect(await toolbox.execute("read_file", JSON.stringify({ path: "missing.ts" }))).toMatch(/does not exist/);
  });

  it("describes tool calls for status updates", () => {
    expect(toolbox.describe("read_file", JSON.stringify({ path: "src/auth.ts" }))).toBe("Reading `src/auth.ts`");
    expect(toolbox.describe("grep", JSON.stringify({ pattern: "login" }))).toBe("Searching for `login`");
    expect(toolbox.describe("list_files", "{}")).toBe("Listing `.`");
  });
});
