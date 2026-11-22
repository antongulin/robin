import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { ReviewToolbox } from "./review-tools";

test("R1-R4 skipped reads, symlinks, source and search compatibility", async () => {
  const root = mkdtempSync(join(tmpdir(), "robin-skip-"));
  try {
    const paths = ["dist/index.js", "sub/dist/x.js", "package-lock.json", "a/yarn.lock", "node_modules/p/i.js", "app.min.js", "src/a.js"];
    for (const file of paths) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), "secret-marker\nsecond line\n"); }
    symlinkSync("dist/index.js", join(root, "link.js"));
    const off = new ReviewToolbox(root);
    const on = new ReviewToolbox(root, undefined, { refuseSkippedReads: true });
    const read = (box: ReviewToolbox, file: string) => box.execute("read_file", JSON.stringify({ path: file }));
    for (const file of ["dist/index.js", "package-lock.json"]) expect(await read(off, file)).toContain("secret-marker");
    for (const file of [...paths.slice(0, -1), "link.js"]) { const result = await read(on, file); expect(result).toContain("excludes it from review"); expect(result).not.toContain("secret-marker"); }
    expect(await read(on, "src/a.js")).toEqual(await read(off, "src/a.js"));
    const range = JSON.stringify({ path: "src/a.js", start_line: 2 });
    expect(await on.execute("read_file", range)).toEqual(await off.execute("read_file", range));
    for (const [name, args] of [["grep", '{"pattern":"secret-marker"}'], ["list_files", '{"recursive":true}']]) expect(await on.execute(name, args)).toEqual(await off.execute(name, args));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("R5 missing and dangling skipped paths get the skip notice; missing source paths keep today's error", async () => {
  const root = mkdtempSync(join(tmpdir(), "robin-skip-missing-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    symlinkSync("dist/gone.js", join(root, "dangling.min.js"));
    const on = new ReviewToolbox(root, undefined, { refuseSkippedReads: true });
    const off = new ReviewToolbox(root);
    const read = (box: ReviewToolbox, file: string) => box.execute("read_file", JSON.stringify({ path: file }));
    for (const file of ["dist/index.js", "./dist/index.js", "dist\\index.js", "dangling.min.js"]) expect(await read(on, file)).toContain("excludes it from review");
    expect(await read(on, "src/missing.ts")).toEqual(await read(off, "src/missing.ts"));
    expect(await read(off, "dist/index.js")).toContain("does not exist");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
