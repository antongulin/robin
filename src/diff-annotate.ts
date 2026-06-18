/**
 * Annotate a unified git diff with NEW-file line numbers.
 *
 * Weak/free models routinely guess wrong line numbers, which makes every
 * line-specific finding fall out of inline placement (see
 * `GitHubReviewer.isLineInNewDiff`). Prefixing each line with its real
 * new-file line number removes the guessing: the model copies the number we
 * already computed.
 *
 * Added (`+`) and context (` `) lines get their new-file line number.
 * Removed (`-`) lines, hunk/file headers, and "\ No newline" markers get a
 * blank pad so the columns line up and the model never assigns them a line.
 */
export function annotateDiffWithLineNumbers(diff: string): string {
  const lines = diff.split("\n");
  const blank = " ".repeat(NUMBER_WIDTH);
  const out: string[] = [];

  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      inHunk = false;
      out.push(`${blank}  ${line}`);
      continue;
    }

    if (line.startsWith("@@")) {
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        newLine = parseInt(match[1], 10);
      }
      inHunk = true;
      out.push(`${blank}  ${line}`);
      continue;
    }

    if (!inHunk || line.startsWith("\\")) {
      out.push(`${blank}  ${line}`);
      continue;
    }

    if (line.startsWith("-")) {
      // Removed line: exists only in the old file, no new-file number.
      out.push(`${blank}  ${line}`);
      continue;
    }

    // Added (`+`) or context (` ` / empty) line: present in the new file.
    out.push(`${pad(newLine)}  ${line}`);
    newLine++;
  }

  return out.join("\n");
}

const NUMBER_WIDTH = 5;

function pad(n: number): string {
  return String(n).padStart(NUMBER_WIDTH, " ");
}
