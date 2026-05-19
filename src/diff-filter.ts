export const DEFAULT_SKIP_PATH_PATTERNS = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/Cargo.lock",
  "**/Gemfile.lock",
  "**/poetry.lock",
  "**/*.min.js",
  "**/*.min.css",
  "**/dist/**",
  "**/node_modules/**",
];

export function matchPathPattern(pattern: string, filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, "");

  if (pattern.startsWith("**/") && pattern.endsWith("/**")) {
    const segment = pattern.slice(3, -3);
    return normalized === segment || normalized.startsWith(`${segment}/`) || normalized.includes(`/${segment}/`);
  }

  if (pattern.startsWith("**/") && !pattern.slice(3).includes("*")) {
    const suffix = pattern.slice(3);
    return normalized === suffix || normalized.endsWith(`/${suffix}`);
  }

  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }

  if (pattern.includes("*")) {
    const regex = new RegExp(
      `^${pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\/\*\*\//g, "/(?:.*/)?")
        .replace(/\*\*\//g, "(?:.*/)?")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*")}$`
    );
    return regex.test(normalized);
  }

  return normalized === pattern || normalized.endsWith(`/${pattern}`);
}

export function shouldSkipPath(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchPathPattern(pattern, filePath));
}

export function splitDiffIntoFiles(diff: string): Array<{ path: string; content: string }> {
  const parts = diff.split(/^diff --git /m);
  const files: Array<{ path: string; content: string }> = [];

  for (const part of parts) {
    if (!part.trim()) continue;

    const headerLine = part.split("\n")[0] || "";
    const match = headerLine.match(/a\/(.+?) b\/(.+)$/);
    const path = match ? match[2] : headerLine;
    files.push({ path, content: `diff --git ${part}` });
  }

  return files;
}

export function filterDiff(
  diff: string,
  extraSkipPatterns: string[] = []
): { filtered: string; removedFiles: string[] } {
  const patterns = [...DEFAULT_SKIP_PATH_PATTERNS, ...extraSkipPatterns];
  const files = splitDiffIntoFiles(diff);
  const removedFiles: string[] = [];
  const kept: string[] = [];

  for (const file of files) {
    if (shouldSkipPath(file.path, patterns)) {
      removedFiles.push(file.path);
    } else {
      kept.push(file.content);
    }
  }

  return { filtered: kept.join(""), removedFiles };
}
