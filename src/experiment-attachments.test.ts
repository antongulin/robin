import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { buildAgentReviewInput } from "./agent-review";
import {
  buildAgentAttachmentSection,
  MAX_ATTACHED_FILE_CHARS,
} from "./agent-attachments";

const DIFF = "    1  +const added = 1;";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "robin-attachments-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relative: string, content: string | Buffer): Promise<void> {
  const absolute = path.join(root, relative);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
}

describe("attach-files input switch", () => {
  it("A1 keeps today's input when the switch is off", () => {
    const changedFiles = ["src/a.ts", "src/b.ts"];

    expect(buildAgentReviewInput(DIFF, changedFiles)).toBe(
      buildAgentReviewInput(DIFF, changedFiles, undefined)
    );
    expect(buildAgentReviewInput(DIFF, changedFiles)).toBe(
      buildAgentReviewInput(DIFF, changedFiles, "")
    );
  });

  it("A2 attaches qualifying files in diff order and lists only oversized files", async () => {
    const aLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    await write("src/a.ts", `${aLines.join("\n")}\n`);
    await write("src/b.ts", "export const b = 3;");
    await write("src/binary.bin", Buffer.from([0x61, 0x00, 0x62]));
    await write("dist/index.js", "BUNDLED_ARTIFACT();");
    await write("src/large.ts", "x".repeat(MAX_ATTACHED_FILE_CHARS + 1));

    const changedFiles = [
      "src/a.ts",
      "src/b.ts",
      "src/deleted.ts",
      "src/binary.bin",
      "dist/index.js",
      "src/large.ts",
    ];
    const section = await buildAgentAttachmentSection(root, changedFiles);
    const input = buildAgentReviewInput(DIFF, changedFiles, section);

    expect(input.indexOf("CODE DIFF:")).toBeLessThan(input.indexOf("File: src/a.ts"));
    expect(input).toContain("File: src/a.ts (lines 1-12 of 12)");
    expect(input).toContain("\n    1  line 1\n");
    expect(input).toContain("\n   12  line 12");
    expect(input).toContain("File: src/b.ts (lines 1-1 of 1)\n    1  export const b = 3;");
    expect(input.indexOf("File: src/a.ts")).toBeLessThan(input.indexOf("File: src/b.ts"));

    expect(input).not.toContain("File: src/deleted.ts");
    expect(input).not.toContain("File: src/binary.bin");
    expect(input).not.toContain("File: dist/index.js");
    expect(input).not.toContain("File: src/large.ts");
    expect(input).not.toContain("BUNDLED_ARTIFACT();");
    expect(section.split("\n").filter((line) => line.startsWith("Not attached"))).toEqual([
      "Not attached (too large or over the limit): src/large.ts",
    ]);
  });

  it("A3 stops at the total cap and names the files left over", async () => {
    const changedFiles = Array.from({ length: 5 }, (_, index) => `src/f${index + 1}.ts`);
    for (const file of changedFiles) await write(file, "a".repeat(35_000));

    const section = await buildAgentAttachmentSection(root, changedFiles);

    expect(section.match(/^File: /gm)).toHaveLength(3);
    expect(section).toContain("File: src/f3.ts (lines 1-1 of 1)");
    expect(section).not.toContain("File: src/f4.ts");
    expect(section).toContain("Not attached (too large or over the limit): src/f4.ts, src/f5.ts");
  });

  it("A4 adds nothing when no changed file qualifies", async () => {
    await write("src/binary.bin", Buffer.from([0x00, 0x01]));
    await write("dist/index.js", "BUNDLED_ARTIFACT();");
    const changedFiles = ["src/deleted.ts", "src/binary.bin", "dist/index.js"];

    const section = await buildAgentAttachmentSection(root, changedFiles);

    expect(section).toBe("");
    expect(buildAgentReviewInput(DIFF, changedFiles, section)).toBe(
      buildAgentReviewInput(DIFF, changedFiles)
    );
  });
});
