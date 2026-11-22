import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_AGENT_ATTACHMENT_CHARS, MAX_ATTACHMENT_NOTICE_CHARS, readAgentAttachments, renderAgentAttachments } from "./agent-attachments";

const file = (path: string, lineCount: number, width = 60) => ({
  path,
  lines: Array.from({ length: lineCount }, (_, index) => `${index}`.padEnd(width, "x")),
});

test("A5 every changed file too large: only the not-attached notice is added", () => {
  const section = renderAgentAttachments({ files: [], omitted: ["big/a.ts", "big/b.ts"] });
  expect(section).toBe("---\nNot attached (too large or over the limit): big/a.ts, big/b.ts");
});

test("A6 the not-attached notice counts toward the total cap and is itself bounded", () => {
  const many = Array.from({ length: 400 }, (_, index) => `very/long/path/name/number-${index}-of-many-omitted-files.ts`);
  const files = [file("a.ts", 600), file("b.ts", 600), file("c.ts", 600)];
  const section = renderAgentAttachments({ files, omitted: many });
  expect(section.length).toBeLessThanOrEqual(MAX_AGENT_ATTACHMENT_CHARS);
  const notice = section.split("\n").pop()!;
  expect(notice.startsWith("Not attached (too large or over the limit): ")).toBe(true);
  expect(notice.length).toBeLessThanOrEqual(MAX_ATTACHMENT_NOTICE_CHARS + 30);
  const more = /and (\d+) more$/.exec(notice);
  expect(more).not.toBeNull();
  const listed = many.filter((name) => notice.includes(name)).length;
  const attachedOrListed = files.filter((f) => section.includes(`File: ${f.path} (lines`) || notice.includes(f.path)).length;
  // Every omitted or dropped name is either listed or counted in "and N more".
  expect(listed + attachedOrListed + Number(more![1])).toBeGreaterThanOrEqual(many.length + files.length);
});

test("A7 a huge omission list alone stays within the section cap", () => {
  const many = Array.from({ length: 20_000 }, (_, index) => `dir/file-number-${index}.ts`);
  const section = renderAgentAttachments({ files: [], omitted: many });
  expect(section.length).toBeLessThanOrEqual(MAX_AGENT_ATTACHMENT_CHARS);
  expect(section).toMatch(/and \d+ more$/);
});

test("A8 an oversized binary file is not reported as too large", async () => {
  const root = mkdtempSync(join(tmpdir(), "robin-attach-binary-"));
  try {
    const binary = Buffer.alloc(200_000, 1);
    binary[10] = 0;
    writeFileSync(join(root, "image.dat"), binary);
    writeFileSync(join(root, "big.ts"), "x".repeat(200_000));
    const data = await readAgentAttachments(root, ["image.dat", "big.ts"]);
    expect(data.omitted).toEqual(["big.ts"]);
    expect(renderAgentAttachments(await readAgentAttachments(root, ["image.dat"]))).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
