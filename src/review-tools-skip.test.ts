import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { REVIEW_TOOLS, ReviewToolbox } from "./review-tools";

/**
 * Reads and searches over an extracted snapshot. The skip notice must name the matched path
 * and pattern, and every non-skipped read, grep and list result must stay byte-identical.
 */
let base: string;
let root: string;
let toolbox: ReviewToolbox;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "robin-skip-"));
  root = join(base, "repo");
  const files: Record<string, string> = {
    "src/a.ts": "const a = 1;\n// GREP_MARKER in a source file\n",
    "src/b.ts": "export const b = 1;\n",
    "src/min.js": "const min = 1;\n",
    "src/dist.ts": "export const dist = 2;\n",
    "src/generated/types.ts": "export type Generated = 1;\n",
    "distribution/a.js": "const distributed = 1;\n",
    "dist/index.js": "// bundle\n// GREP_MARKER in a bundle\n",
    "pkg/dist/x.js": "// pkg bundle\n",
    "package-lock.json": '{"lockfileVersion":3}\n',
    "a/yarn.lock": "yarn lockfile\n",
    "pnpm-lock.yaml": "lockfileVersion: 6\n",
    "Cargo.lock": "version = 3\n",
    "Gemfile.lock": "GEM\n",
    "poetry.lock": "[[package]]\n",
    "node_modules/p/i.js": "// GREP_MARKER vendored\n",
    "app.min.js": "var a=1;\n",
    "style.min.css": "a{color:red}\n",
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  mkdirSync(join(root, "src", "empty"), { recursive: true });
  writeFileSync(join(root, "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  writeFileSync(join(base, "secret.txt"), "TOP SECRET\n");
  toolbox = new ReviewToolbox(root);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const read = (path: string, extra: Record<string, unknown> = {}) =>
  toolbox.execute("read_file", JSON.stringify({ path, ...extra }));

describe("read_file paths that do not match a built-in exclusion", () => {
  it("RS5 keeps every non-skipped result byte-identical", async () => {
    expect(await read("src/a.ts")).toBe(
      "File: src/a.ts (lines 1-2 of 2)\n    1  const a = 1;\n    2  // GREP_MARKER in a source file"
    );
    expect(await read("src/a.ts", { start_line: 2, end_line: 2 })).toBe(
      "File: src/a.ts (lines 2-2 of 2)\n    2  // GREP_MARKER in a source file"
    );
    expect(await read("src/a.ts", { start_line: 2 })).toBe(
      "File: src/a.ts (lines 2-2 of 2)\n    2  // GREP_MARKER in a source file"
    );
    expect(await read("image.png")).toBe("image.png is a binary file.");
    expect(await read("src")).toBe("Error: src is a directory; use list_files instead.");
    expect(await read("missing.ts")).toBe("Error: missing.ts does not exist in the repository.");
    expect(await read("../x.ts")).toBe('Error: path "../x.ts" is outside the repository.');
    expect(await read("../dist/x.js")).toBe('Error: path "../dist/x.js" is outside the repository.');
    expect(await read("dist/../src/a.ts")).toBe(
      "File: src/a.ts (lines 1-2 of 2)\n    1  const a = 1;\n    2  // GREP_MARKER in a source file"
    );
    expect(await read("distribution/a.js")).toBe(
      "File: distribution/a.js (lines 1-1 of 1)\n    1  const distributed = 1;"
    );
    expect(await read("src/min.js")).toBe("File: src/min.js (lines 1-1 of 1)\n    1  const min = 1;");
    expect(await read("src/dist.ts")).toBe("File: src/dist.ts (lines 1-1 of 1)\n    1  export const dist = 2;");

    symlinkSync(join(base, "secret.txt"), join(root, "src", "link.txt"));
    expect(await read("src/link.txt")).toBe('Error: path "src/link.txt" resolves outside the repository.');
  });
});

describe("grep and list_files keep their current exclusions", () => {
  it("RS7 keeps search and listing results byte-identical", async () => {
    expect(await toolbox.execute("grep", JSON.stringify({ pattern: "GREP_MARKER" }))).toBe(
      "1 match(es) for /GREP_MARKER/:\nsrc/a.ts:2: // GREP_MARKER in a source file"
    );
    expect(await toolbox.execute("grep", JSON.stringify({ pattern: "GREP_MARKER", path: "dist/index.js" }))).toBe(
      "1 match(es) for /GREP_MARKER/:\ndist/index.js:2: // GREP_MARKER in a bundle"
    );
    expect(await toolbox.execute("grep", JSON.stringify({ pattern: "GREP_MARKER", path: "dist" }))).toBe(
      "No matches for /GREP_MARKER/."
    );
    expect(await toolbox.execute("list_files", "{}")).toBe(
      ".:\na/\napp.min.js\nCargo.lock\ndist/\ndistribution/\nGemfile.lock\nimage.png\nnode_modules/\n" +
        "package-lock.json\npkg/\npnpm-lock.yaml\npoetry.lock\nsrc/\nstyle.min.css"
    );
    expect(await toolbox.execute("list_files", JSON.stringify({ recursive: true }))).toBe(
      ".:\nimage.png\ndistribution/a.js\nsrc/min.js\nsrc/dist.ts\nsrc/b.ts\nsrc/a.ts\nsrc/generated/types.ts"
    );
    expect(await toolbox.execute("list_files", JSON.stringify({ path: "dist", recursive: true }))).toBe(
      "dist is empty."
    );
    expect(await toolbox.execute("list_files", JSON.stringify({ path: "dist" }))).toBe("dist:\nindex.js");
  });
});

describe("tool definitions and status text", () => {
  it("RS10 keeps the tool schema byte-identical", () => {
    expect(JSON.stringify(REVIEW_TOOLS)).toBe(
      JSON.stringify([
        {
          type: "function",
          function: {
            name: "read_file",
            description:
              "Read a file from the repository at the PR head commit. Returns lines prefixed with their line numbers. Reads up to 2000 lines (about 50k characters) per call; use start_line/end_line for other ranges.",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Repository-relative file path, e.g. src/index.ts" },
                start_line: { type: "integer", description: "First line to read (1-based). Default 1." },
                end_line: { type: "integer", description: "Last line to read (inclusive)." },
              },
              required: ["path"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "grep",
            description:
              "Search repository files at the PR head commit with a JavaScript regular expression. Returns path:line: text matches (max 300). Use it to find callers, definitions, and other usages.",
            parameters: {
              type: "object",
              properties: {
                pattern: { type: "string", description: "Regular expression (JavaScript syntax)." },
                path: { type: "string", description: "Optional directory or file to limit the search to." },
                glob: {
                  type: "string",
                  description: "Optional file filter, e.g. *.ts or src/**/*.py. Patterns without / match the file name.",
                },
                ignore_case: { type: "boolean", description: "Case-insensitive search. Default false." },
                context_lines: {
                  type: "integer",
                  description: "Lines of surrounding context to show around each match (0-5). Default 0.",
                },
              },
              required: ["pattern"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "list_files",
            description:
              "List files and directories at the PR head commit. Directories end with /. Set recursive to list nested files (max 2000 entries).",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "Repository-relative directory. Default is the repository root." },
                recursive: { type: "boolean", description: "List nested files too. Default false." },
              },
            },
          },
        },
      ])
    );
  });
});

const notice = (path: string, pattern: string) =>
  `${path} was not read: it matches Robin's built-in review exclusion "${pattern}" ` +
  "for lockfiles, build output, vendored and minified files. Read the source files instead.";

describe("read_file paths that match a built-in exclusion", () => {
  it("RS1 returns the exact notice for every excluded path class", async () => {
    const cases: Array<[string, string]> = [
      ["dist/index.js", "**/dist/**"],
      ["pkg/dist/x.js", "**/dist/**"],
      ["package-lock.json", "**/package-lock.json"],
      ["a/yarn.lock", "**/yarn.lock"],
      ["pnpm-lock.yaml", "**/pnpm-lock.yaml"],
      ["Cargo.lock", "**/Cargo.lock"],
      ["Gemfile.lock", "**/Gemfile.lock"],
      ["poetry.lock", "**/poetry.lock"],
      ["node_modules/p/i.js", "**/node_modules/**"],
      ["app.min.js", "**/*.min.js"],
      ["style.min.css", "**/*.min.css"],
    ];
    for (const [path, pattern] of cases) {
      expect(await read(path)).toBe(notice(path, pattern));
    }
    expect(await read("dist/index.js", { start_line: 1, end_line: 1 })).toBe(notice("dist/index.js", "**/dist/**"));
    expect(toolbox.describe("read_file", JSON.stringify({ path: "dist/index.js" }))).toBe(
      "Reading `dist/index.js`"
    );
  });

  it("RS2 normalizes spellings to the same notice", async () => {
    const expected = notice("dist/index.js", "**/dist/**");
    for (const path of ["./dist/index.js", "/dist/index.js", "dist\\index.js", "  dist/index.js  ", "src/../dist/index.js"]) {
      expect(await read(path)).toBe(expected);
    }
  });

  it("RS3 covers directories and keeps the missing-path error", async () => {
    expect(await read("dist")).toBe(notice("dist", "**/dist/**"));
    expect(await read("node_modules/")).toBe(notice("node_modules", "**/node_modules/**"));
    expect(await read("dist/missing.js")).toBe("Error: dist/missing.js does not exist in the repository.");
  });

  it("RS4 names the path that matched, through symlinks too", async () => {
    symlinkSync("dist/index.js", join(root, "link.js"));
    expect(await read("link.js")).toBe(notice("dist/index.js", "**/dist/**"));

    symlinkSync("dist", join(root, "lib"), "dir");
    expect(await read("lib/index.js")).toBe(notice("dist/index.js", "**/dist/**"));

    symlinkSync(join(base, "secret.txt"), join(root, "dist", "out.js"));
    expect(await read("dist/out.js")).toBe('Error: path "dist/out.js" resolves outside the repository.');

    rmSync(join(root, "dist"), { recursive: true, force: true });
    symlinkSync("src/generated", join(root, "dist"), "dir");
    expect(await read("dist/types.ts")).toBe(notice("dist/types.ts", "**/dist/**"));
  });

  it("RS8 reads a path a repository might list in skip-paths normally", async () => {
    expect(await read("src/generated/types.ts")).toBe(
      "File: src/generated/types.ts (lines 1-1 of 1)\n    1  export type Generated = 1;"
    );
    const pinConstructor: new (root: string, maxOutputChars?: number) => ReviewToolbox = ReviewToolbox;
    expect(new pinConstructor(root)).toBeInstanceOf(ReviewToolbox);
  });
});
