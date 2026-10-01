import { promises as fs, realpathSync } from "fs";
import * as path from "path";
import type { ToolDefinition } from "./llm-client";
import { DEFAULT_SKIP_PATH_PATTERNS, matchPathPattern, shouldSkipPath } from "./diff-filter";

/** Per-call output cap (~12-15k tokens): a large file section or a broad search fits in one result. */
export const DEFAULT_TOOL_OUTPUT_CHARS = 50_000;
const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 2_000;
const MAX_GREP_MATCHES = 300;
const MAX_GREP_CONTEXT_LINES = 5;
const MAX_GREP_FILES = 100_000;
const MAX_GREP_LINE_CHARS = 2_000;
const MAX_MATCH_DISPLAY_CHARS = 500;
const MAX_LIST_ENTRIES = 2_000;
const NUMBER_WIDTH = 5;
const ALWAYS_SKIPPED_DIRS = new Set([".git"]);

export const REVIEW_TOOLS: ToolDefinition[] = [
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
];

type ToolArgs = Record<string, unknown>;

/** Read-only tools over an extracted repository snapshot. Every path is confined to `root`. */
export class ReviewToolbox {
  private readonly root: string;
  private readonly maxOutputChars: number;

  constructor(root: string, maxOutputChars = DEFAULT_TOOL_OUTPUT_CHARS) {
    // Resolved so realpath checks compare like with like when the temp dir itself is a symlink.
    this.root = realpathSync(path.resolve(root));
    this.maxOutputChars = maxOutputChars;
  }

  /** Runs a tool call. Failures come back as "Error: ..." text so the model can recover. */
  async execute(name: string, rawArgs: string): Promise<string> {
    let args: ToolArgs;
    try {
      const parsed = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      args = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return `Error: arguments for ${name} were not valid JSON.`;
    }

    try {
      let output: string;
      switch (name) {
        case "read_file":
          output = await this.readFile(args);
          break;
        case "grep":
          output = await this.grep(args);
          break;
        case "list_files":
          output = await this.listFiles(args);
          break;
        default:
          return `Error: unknown tool "${name}". Available tools: read_file, grep, list_files.`;
      }
      return this.truncate(output);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** Short human-readable description for status updates. */
  describe(name: string, rawArgs: string): string {
    let args: ToolArgs = {};
    try {
      args = JSON.parse(rawArgs || "{}") ?? {};
    } catch {
      // fall through with empty args
    }
    const target = (value: unknown, fallback: string) =>
      "`" + String(typeof value === "string" && value ? value : fallback).slice(0, 80) + "`";
    switch (name) {
      case "read_file":
        return `Reading ${target(args.path, "?")}`;
      case "grep":
        return `Searching for ${target(args.pattern, "?")}`;
      case "list_files":
        return `Listing ${target(args.path, ".")}`;
      default:
        return `Running ${name}`;
    }
  }

  private async readFile(args: ToolArgs): Promise<string> {
    const relInput = requireString(args.path, "path");
    const { absolute, relative } = await this.resolve(relInput);
    const stat = await fs.stat(absolute);
    if (stat.isDirectory()) {
      throw new Error(`${relative} is a directory; use list_files instead.`);
    }
    if (stat.size > MAX_READ_FILE_BYTES) {
      throw new Error(`${relative} is too large to read (${stat.size} bytes).`);
    }

    const buffer = await fs.readFile(absolute);
    if (isBinary(buffer)) {
      return `${relative} is a binary file.`;
    }

    const lines = buffer.toString("utf8").split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = clampInt(args.start_line, 1, Math.max(total, 1), 1);
    const end = clampInt(args.end_line, start, Math.max(total, start), Math.min(total, start + DEFAULT_READ_LINES - 1));

    // Stop on a whole line inside the output cap so the model can continue exactly where it left off.
    const budget = this.maxOutputChars - 200;
    const numbered: string[] = [];
    let used = 0;
    let last = start - 1;
    for (let lineNumber = start; lineNumber <= end; lineNumber++) {
      const entry = `${String(lineNumber).padStart(NUMBER_WIDTH, " ")}  ${lines[lineNumber - 1]}`;
      if (numbered.length > 0 && used + entry.length + 1 > budget) break;
      numbered.push(entry);
      used += entry.length + 1;
      last = lineNumber;
    }

    const more =
      last < total ? `\n[... ${total - last} more lines; call read_file with start_line=${last + 1}]` : "";
    return `File: ${relative} (lines ${start}-${last} of ${total})\n${numbered.join("\n")}${more}`;
  }

  private async grep(args: ToolArgs): Promise<string> {
    const pattern = requireString(args.pattern, "pattern");
    const flags = args.ignore_case === true ? "i" : "";
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    }
    const contextLines = clampInt(args.context_lines, 0, MAX_GREP_CONTEXT_LINES, 0);
    const glob = typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined;
    const start = typeof args.path === "string" && args.path.trim() ? await this.resolve(args.path) : undefined;

    const matches: string[] = [];
    let scanned = 0;
    let truncated = false;

    for await (const file of this.walk(start?.absolute ?? this.root)) {
      if (glob && !matchesGlob(glob, file.relative)) continue;
      if (++scanned > MAX_GREP_FILES) {
        truncated = true;
        break;
      }
      const stat = await fs.stat(file.absolute);
      if (stat.size > MAX_GREP_FILE_BYTES) continue;
      const buffer = await fs.readFile(file.absolute);
      if (isBinary(buffer)) continue;

      const lines = buffer.toString("utf8").split("\n");
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index].slice(0, MAX_GREP_LINE_CHARS);
        if (!regex.test(line)) continue;
        if (contextLines === 0) {
          matches.push(`${file.relative}:${index + 1}: ${line.trim().slice(0, MAX_MATCH_DISPLAY_CHARS)}`);
        } else {
          const from = Math.max(0, index - contextLines);
          const to = Math.min(lines.length - 1, index + contextLines);
          const block = [];
          for (let at = from; at <= to; at++) {
            const marker = at === index ? ":" : "-";
            block.push(`${file.relative}${marker}${at + 1}${marker} ${lines[at].slice(0, MAX_MATCH_DISPLAY_CHARS)}`);
          }
          matches.push(block.join("\n") + "\n--");
        }
        if (matches.length >= MAX_GREP_MATCHES) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }

    if (matches.length === 0) {
      return `No matches for /${pattern}/${flags}${glob ? ` in ${glob}` : ""}.`;
    }
    const note = truncated ? `\n[... results truncated; narrow the search with path or glob]` : "";
    return `${matches.length} match(es) for /${pattern}/${flags}:\n${matches.join("\n")}${note}`;
  }

  private async listFiles(args: ToolArgs): Promise<string> {
    const target =
      typeof args.path === "string" && args.path.trim() && args.path.trim() !== "."
        ? await this.resolve(args.path)
        : { absolute: this.root, relative: "." };
    const stat = await fs.stat(target.absolute);
    if (!stat.isDirectory()) {
      throw new Error(`${target.relative} is a file; use read_file instead.`);
    }

    const entries: string[] = [];
    let truncated = false;
    if (args.recursive === true) {
      for await (const file of this.walk(target.absolute)) {
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push(file.relative);
      }
    } else {
      const dirents = await fs.readdir(target.absolute, { withFileTypes: true });
      for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (ALWAYS_SKIPPED_DIRS.has(dirent.name)) continue;
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push(dirent.isDirectory() ? `${dirent.name}/` : dirent.name);
      }
    }

    if (entries.length === 0) return `${target.relative} is empty.`;
    const note = truncated ? `\n[... more entries not shown]` : "";
    return `${target.relative}:\n${entries.join("\n")}${note}`;
  }

  /** Walks regular files under `dir` without following symlinks, skipping vendored/generated paths. */
  private async *walk(dir: string): AsyncGenerator<{ absolute: string; relative: string }> {
    const stat = await fs.lstat(dir);
    if (stat.isFile()) {
      yield { absolute: dir, relative: this.toRelative(dir) };
      return;
    }

    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const dirents = await fs.readdir(current, { withFileTypes: true });
      dirents.sort((a, b) => b.name.localeCompare(a.name));
      for (const dirent of dirents) {
        const absolute = path.join(current, dirent.name);
        const relative = this.toRelative(absolute);
        if (dirent.isDirectory()) {
          if (ALWAYS_SKIPPED_DIRS.has(dirent.name)) continue;
          if (shouldSkipPath(`${relative}/`, DEFAULT_SKIP_PATH_PATTERNS)) continue;
          stack.push(absolute);
        } else if (dirent.isFile()) {
          if (shouldSkipPath(relative, DEFAULT_SKIP_PATH_PATTERNS)) continue;
          yield { absolute, relative };
        }
      }
    }
  }

  /** Resolves a model-supplied path and rejects anything (including symlink targets) outside the root. */
  private async resolve(input: string): Promise<{ absolute: string; relative: string }> {
    const cleaned = input.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
    const candidate = path.resolve(this.root, cleaned || ".");
    if (!this.isInside(candidate)) {
      throw new Error(`path "${input}" is outside the repository.`);
    }

    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      throw new Error(`${cleaned || "."} does not exist in the repository.`);
    }
    if (!this.isInside(real)) {
      throw new Error(`path "${input}" resolves outside the repository.`);
    }
    return { absolute: real, relative: this.toRelative(real) };
  }

  private isInside(candidate: string): boolean {
    const relative = path.relative(this.root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private toRelative(absolute: string): string {
    return path.relative(this.root, absolute).split(path.sep).join("/") || ".";
  }

  private truncate(output: string): string {
    if (output.length <= this.maxOutputChars) return output;
    return `${output.slice(0, this.maxOutputChars)}\n[... output truncated at ${this.maxOutputChars} characters]`;
  }
}

function matchesGlob(glob: string, relative: string): boolean {
  const target = glob.includes("/") ? relative : relative.slice(relative.lastIndexOf("/") + 1);
  return matchPathPattern(glob, target);
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`"${name}" is required.`);
  }
  return value;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}
