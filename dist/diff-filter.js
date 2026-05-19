"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SKIP_PATH_PATTERNS = void 0;
exports.matchPathPattern = matchPathPattern;
exports.shouldSkipPath = shouldSkipPath;
exports.splitDiffIntoFiles = splitDiffIntoFiles;
exports.filterDiff = filterDiff;
exports.DEFAULT_SKIP_PATH_PATTERNS = [
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
function matchPathPattern(pattern, filePath) {
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
        const regex = new RegExp(`^${pattern
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\/\*\*\//g, "/(?:.*/)?")
            .replace(/\*\*\//g, "(?:.*/)?")
            .replace(/\*\*/g, ".*")
            .replace(/\*/g, "[^/]*")}$`);
        return regex.test(normalized);
    }
    return normalized === pattern || normalized.endsWith(`/${pattern}`);
}
function shouldSkipPath(filePath, patterns) {
    return patterns.some((pattern) => matchPathPattern(pattern, filePath));
}
function splitDiffIntoFiles(diff) {
    const parts = diff.split(/^diff --git /m);
    const files = [];
    for (const part of parts) {
        if (!part.trim())
            continue;
        const headerLine = part.split("\n")[0] || "";
        const match = headerLine.match(/a\/(.+?) b\/(.+)$/);
        const path = match ? match[2] : headerLine;
        files.push({ path, content: `diff --git ${part}` });
    }
    return files;
}
function filterDiff(diff, extraSkipPatterns = []) {
    const patterns = [...exports.DEFAULT_SKIP_PATH_PATTERNS, ...extraSkipPatterns];
    const files = splitDiffIntoFiles(diff);
    const removedFiles = [];
    const kept = [];
    for (const file of files) {
        if (shouldSkipPath(file.path, patterns)) {
            removedFiles.push(file.path);
        }
        else {
            kept.push(file.content);
        }
    }
    return { filtered: kept.join(""), removedFiles };
}
//# sourceMappingURL=diff-filter.js.map