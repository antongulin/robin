import { DEFAULT_SKIP_PATH_PATTERNS, filterDiff, matchPathPattern, shouldSkipPath } from "./diff-filter";

describe("matchPathPattern", () => {
  it("matches lockfiles and dist paths", () => {
    expect(matchPathPattern("**/package-lock.json", "frontend/package-lock.json")).toBe(true);
    expect(matchPathPattern("**/dist/**", "dist/index.js")).toBe(true);
    expect(matchPathPattern("**/*.min.js", "public/app.min.js")).toBe(true);
    expect(matchPathPattern("src/**", "src/index.ts")).toBe(true);
  });
});

describe("filterDiff", () => {
  it("removes skipped file hunks from a unified diff", () => {
    const diff = [
      "diff --git a/package-lock.json b/package-lock.json",
      "index 111..222 100644",
      "--- a/package-lock.json",
      "+++ b/package-lock.json",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/app.ts b/src/app.ts",
      "index 333..444 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-const x = 1;",
      "+const x = 2;",
    ].join("\n");

    const { filtered, removedFiles } = filterDiff(diff);

    expect(removedFiles).toEqual(["package-lock.json"]);
    expect(filtered).toContain("src/app.ts");
    expect(filtered).not.toContain("package-lock.json");
  });

  it("honors extra skip patterns from repo config", () => {
    const diff = [
      "diff --git a/generated/out.ts b/generated/out.ts",
      "index 111..222 100644",
      "--- a/generated/out.ts",
      "+++ b/generated/out.ts",
      "@@ -1 +1 @@",
      "+export {}",
    ].join("\n");

    const { filtered, removedFiles } = filterDiff(diff, ["**/generated/**"]);
    expect(removedFiles).toEqual(["generated/out.ts"]);
    expect(filtered.trim()).toBe("");
  });
});

describe("shouldSkipPath", () => {
  it("combines default and custom patterns", () => {
    expect(shouldSkipPath("yarn.lock", DEFAULT_SKIP_PATH_PATTERNS)).toBe(true);
    expect(shouldSkipPath("src/index.ts", ["**/generated/**"])).toBe(false);
    expect(shouldSkipPath("generated/out.ts", ["**/generated/**"])).toBe(true);
  });
});
