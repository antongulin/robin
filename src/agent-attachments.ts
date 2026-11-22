import { promises as fs } from "fs";
import * as path from "path";
import { DEFAULT_SKIP_PATH_PATTERNS, shouldSkipPath } from "./diff-filter";

/** Experiment `attach-files`: changed files are attached whole only below these limits. */
export const MAX_ATTACHED_FILE_CHARS = 40_000;
export const MAX_AGENT_ATTACHMENT_CHARS = 120_000;
const BINARY_SCAN_BYTES = 8_000;
const NUMBER_WIDTH = 5;

const ATTACHMENT_HEADER = [
  "---",
  "CHANGED FILES AT THE PR HEAD (full content, line-numbered like read_file; already in context, so do not read them again unless you need a part not shown):",
];

export interface AgentAttachedFile {
  path: string;
  /** File lines without their trailing newline, as `read_file` returns them. */
  lines: string[];
}

export interface AgentAttachmentData {
  files: AgentAttachedFile[];
  /** Existing text files left out only because they are too large or past the section cap. */
  omitted: string[];
}

/**
 * Reads whole changed files from the snapshot the toolbox uses, in diff order. Deleted,
 * binary and skip-pattern files are dropped silently: there is nothing useful to attach or
 * point the model back to. Oversized files are remembered so the section can name them.
 */
export async function readAgentAttachments(
  root: string,
  changedFiles: string[]
): Promise<AgentAttachmentData> {
  const files: AgentAttachedFile[] = [];
  const omitted: string[] = [];
  let resolvedRoot: string;
  try {
    resolvedRoot = await fs.realpath(path.resolve(root));
  } catch {
    return { files, omitted };
  }

  for (const changedFile of changedFiles) {
    const cleaned = changedFile.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
    const candidate = path.resolve(resolvedRoot, cleaned || ".");
    if (!isInside(resolvedRoot, candidate)) continue;
    if (shouldSkipPath(cleaned, DEFAULT_SKIP_PATH_PATTERNS)) continue;

    let real: string;
    let buffer: Buffer;
    try {
      real = await fs.realpath(candidate);
      if (!isInside(resolvedRoot, real)) continue;
      const stat = await fs.stat(real);
      if (!stat.isFile()) continue;
      // Every UTF-16 code unit needs at most 3 UTF-8 bytes, so a longer file cannot fit.
      if (stat.size > MAX_ATTACHED_FILE_CHARS * 3) {
        omitted.push(cleaned);
        continue;
      }
      buffer = await fs.readFile(real);
    } catch {
      // Deleted at the head, or unreadable: nothing to attach.
      continue;
    }

    const relative = path.relative(resolvedRoot, real).split(path.sep).join("/");
    if (!relative || shouldSkipPath(relative, DEFAULT_SKIP_PATH_PATTERNS)) continue;
    if (buffer.subarray(0, BINARY_SCAN_BYTES).includes(0)) continue;

    const content = buffer.toString("utf8");
    if (content.length > MAX_ATTACHED_FILE_CHARS) {
      omitted.push(relative);
      continue;
    }

    const lines = content.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    files.push({ path: relative, lines });
  }

  return { files, omitted };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Renders the attachment block appended to the immutable review input. Files are added in
 * diff order until the section would pass its total cap; the rest are named in one line so
 * the model knows to read them with tools. Returns "" when no file qualifies.
 */
export function renderAgentAttachments(data: AgentAttachmentData): string {
  if (data.files.length === 0 && data.omitted.length === 0) return "";

  const header = ATTACHMENT_HEADER.join("\n");
  const blocks: Array<{ path: string; text: string }> = [];
  const overLimit: string[] = [];
  let total = header.length;

  for (const file of data.files) {
    if (overLimit.length > 0) {
      overLimit.push(file.path);
      continue;
    }
    const text = renderFileBlock(file);
    if (total + 1 + text.length > MAX_AGENT_ATTACHMENT_CHARS) {
      overLimit.push(file.path);
      continue;
    }
    blocks.push({ path: file.path, text });
    total += 1 + text.length;
  }

  // The omission notice counts toward the cap: drop the last attached files until it fits.
  const notice = () => {
    const names = [...data.omitted, ...overLimit];
    return names.length > 0 ? `Not attached (too large or over the limit): ${names.join(", ")}` : "";
  };
  while (blocks.length > 0 && notice() && total + 1 + notice().length > MAX_AGENT_ATTACHMENT_CHARS) {
    const dropped = blocks.pop()!;
    total -= 1 + dropped.text.length;
    overLimit.unshift(dropped.path);
  }

  if (blocks.length === 0) {
    // Nothing fits, but the model should still know which changed files to read with tools.
    return notice() ? ["---", notice()].join("\n") : "";
  }
  const section = [header, ...blocks.map((block) => block.text)];
  if (notice()) section.push(notice());
  return section.join("\n");
}

/** Reads and renders in one step for the agent review caller. */
export async function buildAgentAttachmentSection(
  root: string,
  changedFiles: string[]
): Promise<string> {
  return renderAgentAttachments(await readAgentAttachments(root, changedFiles));
}

function renderFileBlock(file: AgentAttachedFile): string {
  const total = file.lines.length;
  const numbered = file.lines.map(
    (line, index) => `${String(index + 1).padStart(NUMBER_WIDTH, " ")}  ${line}`
  );
  return [`File: ${file.path} (lines 1-${total} of ${total})`, ...numbered].join("\n");
}
