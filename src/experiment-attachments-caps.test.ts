import { MAX_AGENT_ATTACHMENT_CHARS, renderAgentAttachments } from "./agent-attachments";

const file = (path: string, lineCount: number, width = 60) => ({
  path,
  lines: Array.from({ length: lineCount }, (_, index) => `${index}`.padEnd(width, "x")),
});

test("A5 every changed file too large: only the not-attached notice is added", () => {
  const section = renderAgentAttachments({ files: [], omitted: ["big/a.ts", "big/b.ts"] });
  expect(section).toBe("---\nNot attached (too large or over the limit): big/a.ts, big/b.ts");
});

test("A6 the not-attached notice counts toward the total cap", () => {
  const many = Array.from({ length: 400 }, (_, index) => `very/long/path/name/number-${index}-of-many-omitted-files.ts`);
  const files = [file("a.ts", 600), file("b.ts", 600), file("c.ts", 600)];
  const section = renderAgentAttachments({ files, omitted: many });
  expect(section.length).toBeLessThanOrEqual(MAX_AGENT_ATTACHMENT_CHARS);
  expect(section).toContain("Not attached (too large or over the limit): ");
  const notice = section.split("\n").pop()!;
  for (const name of many) expect(notice).toContain(name);
  // Files dropped to make room are named in the notice, never silently lost.
  for (const f of files) {
    const attached = section.includes(`File: ${f.path} (lines`);
    expect(attached || notice.includes(f.path)).toBe(true);
  }
});
