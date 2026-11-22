import { resolveExperimentAgentTurns } from "./experiment";
import { getAgentReviewPrompt, getReviewPrompt } from "./prompts/review-prompts";

const efficientLine = (maxTurns: number) =>
  `- Be efficient. You have at most ${maxTurns} tool turns; request several independent tool calls in the same turn.`;

const planBatchLine = (maxTurns: number) =>
  `- Plan before you call tools: in your first turn, list what you need to verify, then request all independent reads and searches together (up to 16 calls per turn). Later turns should also batch independent calls. Do not read a file again while its content is still in the conversation. You have at most ${maxTurns} tool turns.`;

const calibrationLines = [
  "- A review with no findings is a valid, good result when the change is sound. Do not add findings to fill the review.",
  "- Report Low and Suggestion items only when a maintainer would act on them in this pull request. Skip style preferences, speculative hardening, and points the code already handles.",
  "- Never drop or downgrade a High or Medium problem to keep the review short.",
];

const agentPromptLines = (prompt: string) => prompt.split("\n");
const occurrences = (lines: string[], line: string) => lines.filter((candidate) => candidate === line).length;

describe("plan-batch prompt switch", () => {
  it("P1 keeps today's prompt when the switch is off", () => {
    const current = getAgentReviewPrompt("x", 40);

    expect(getAgentReviewPrompt("x", 40, {})).toBe(current);
    expect(getAgentReviewPrompt("x", 40, { planBatch: false })).toBe(current);
    expect(current).toContain(efficientLine(40));
    expect(current).not.toContain("Plan before you call tools");
  });

  it("P2 replaces only the efficiency line when the switch is on", () => {
    const off = agentPromptLines(getAgentReviewPrompt("x", 40));
    const on = agentPromptLines(getAgentReviewPrompt("x", 40, { planBatch: true }));

    const index = off.indexOf(efficientLine(40));
    expect(index).toBeGreaterThan(-1);
    expect(on).toHaveLength(off.length);
    expect(on[index]).toBe(planBatchLine(40));
    expect(on).not.toContain(efficientLine(40));
    expect([...on.slice(0, index), ...on.slice(index + 1)]).toEqual([
      ...off.slice(0, index),
      ...off.slice(index + 1),
    ]);
  });
});

describe("calibrate prompt switch", () => {
  it("C1 keeps today's prompt when the switch is off", () => {
    const current = getAgentReviewPrompt("x", 40);

    expect(getAgentReviewPrompt("x", 40, { calibrate: false })).toBe(current);
    for (const line of calibrationLines) expect(current).not.toContain(line);
  });

  it("C2 adds the three lines once, after the shared guidelines and before the no-hallucination rule", () => {
    const lines = agentPromptLines(getAgentReviewPrompt("x", 40, { calibrate: true }));

    for (const line of calibrationLines) expect(occurrences(lines, line)).toBe(1);

    const sharedEnd = lines.indexOf("- Propose concrete code examples when helpful.");
    const noHallucination = lines.indexOf(
      "- Do not hallucinate issues. Only flag problems you can support with the diff or with what you read through the tools."
    );
    expect(sharedEnd).toBeGreaterThan(-1);
    expect(noHallucination).toBeGreaterThan(sharedEnd);
    expect(lines.slice(sharedEnd + 1, noHallucination)).toEqual(calibrationLines);

    const singleShot = getReviewPrompt("x");
    for (const line of calibrationLines) expect(singleShot).not.toContain(line);
    expect(singleShot).toContain("- Do not hallucinate issues. Only flag problems actually visible in the diff.");
  });
});

describe("all prompt-affecting switches on together", () => {
  it("X1 keeps both changes and adds no duplicate lines", () => {
    const turns = resolveExperimentAgentTurns(40, 9_999, true);
    const lines = agentPromptLines(
      getAgentReviewPrompt("x", turns, { planBatch: true, calibrate: true })
    );

    expect(turns).toBe(20);
    expect(lines).toContain(planBatchLine(20));
    expect(lines).not.toContain(efficientLine(20));
    for (const line of calibrationLines) expect(occurrences(lines, line)).toBe(1);
    expect(occurrences(lines, planBatchLine(20))).toBe(1);
  });
});
