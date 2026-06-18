import { annotateDiffWithLineNumbers } from "./diff-annotate";

describe("annotateDiffWithLineNumbers", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index 1111111..2222222 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 3;",
    "+const c = 4;",
    " const d = 5;",
  ].join("\n");

  const annotated = annotateDiffWithLineNumbers(diff);
  const lines = annotated.split("\n");

  it("numbers context lines with their new-file line number", () => {
    expect(lines).toContain("    1   const a = 1;");
    expect(lines).toContain("    4   const d = 5;");
  });

  it("numbers added lines, accounting for the removed line in between", () => {
    expect(lines).toContain("    2  +const b = 3;");
    expect(lines).toContain("    3  +const c = 4;");
  });

  it("leaves removed lines and headers unnumbered", () => {
    expect(lines).toContain("       -const b = 2;");
    expect(lines).toContain("       @@ -1,3 +1,4 @@");
    expect(lines).toContain("       +++ b/src/foo.ts");
  });

  it("resets the counter for each file using the hunk header", () => {
    const twoFiles = [
      "diff --git a/a.ts b/a.ts",
      "@@ -10,1 +10,2 @@",
      " keep",
      "+addedInA",
      "diff --git a/b.ts b/b.ts",
      "@@ -1,0 +1,1 @@",
      "+addedInB",
    ].join("\n");
    const result = annotateDiffWithLineNumbers(twoFiles).split("\n");
    expect(result).toContain("   11  +addedInA");
    expect(result).toContain("    1  +addedInB");
  });
});
