jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import { createHash } from "crypto";
import * as core from "@actions/core";
import { runAgentReview } from "./agent-review";
import type { ChatCompletionResult, ChatMessage, LLMClient } from "./llm-client";
import { ReviewParser } from "./review-parser";
import { REVIEW_TOOLS } from "./review-tools";

const FINAL_JSON = '{"summary":"ok","high":[],"medium":[],"low":[],"suggestions":[]}';
const REPAIR_PROMPT =
  "Your previous reply could not be parsed as the required review. Do not call any tools. " +
  "Using the investigation so far, return only the single JSON object described in the system prompt, " +
  "with no markdown and no prose.";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: JSON.stringify(args) };
}

interface RecordedCall {
  messages: ChatMessage[];
  tools: unknown;
  toolChoice?: string;
  usageContext?: { phase: string; agentTurn: number; recovery: boolean };
}

type Script = ChatCompletionResult | Error;

interface Harness {
  calls: RecordedCall[];
  llm: { chatWithTools: jest.Mock; chatCompletion: jest.Mock };
  progress: Array<{ turn: number; phase: string; activity: string }>;
  run: () => ReturnType<typeof runAgentReview>;
}

function harness(
  scripts: Script[],
  options: {
    maxTurns?: number;
    deadlineMs?: number;
    now?: () => number;
    summaries?: Array<string | Error>;
    onProgress?: (update: { turn: number; phase: string; activity: string }) => void;
  } = {}
): Harness {
  const calls: RecordedCall[] = [];
  const progress: Array<{ turn: number; phase: string; activity: string }> = [];
  const summaries = options.summaries ?? [];
  const chatWithTools = jest.fn(
    async (
      messages: ChatMessage[],
      tools: unknown,
      callOptions?: { toolChoice?: string; usageContext?: RecordedCall["usageContext"] }
    ) => {
      calls.push({
        messages: messages.map((message) => ({ ...message })),
        tools,
        toolChoice: callOptions?.toolChoice,
        usageContext: callOptions?.usageContext,
      });
      const next = scripts.shift();
      if (next === undefined) throw new Error("no more scripted responses");
      if (next instanceof Error) throw next;
      return next;
    }
  );
  const chatCompletion = jest.fn(async () => {
    const next = summaries.shift();
    if (next === undefined) throw new Error("no more scripted summaries");
    if (next instanceof Error) throw next;
    return { content: next };
  });
  const toolbox = {
    execute: jest.fn(async (name: string, args: string) => `${name} result for ${args}`),
    describe: jest.fn(() => "Running read_file"),
  };
  const budgets: { maxTurns?: number; deadlineMs?: number } = {};
  if (options.maxTurns !== undefined) budgets.maxTurns = options.maxTurns;
  if (options.deadlineMs !== undefined) budgets.deadlineMs = options.deadlineMs;
  return {
    calls,
    llm: { chatWithTools, chatCompletion },
    progress,
    run: () =>
      runAgentReview({
        llm: { chatWithTools, chatCompletion } as unknown as Pick<LLMClient, "chatWithTools" | "chatCompletion">,
        toolbox,
        annotatedDiff: "diff",
        changedFiles: [],
        instructions: "",
        ...(Object.keys(budgets).length > 0 ? { budgets } : {}),
        ...(options.now === undefined ? {} : { now: options.now }),
        onProgress: (update) => {
          progress.push({ turn: update.turn, phase: update.phase, activity: update.activity });
          options.onProgress?.(update);
        },
      }),
  };
}

const infoLines = () => (core.info as jest.Mock).mock.calls.map(([line]) => line);
const warningLines = () => (core.warning as jest.Mock).mock.calls.map(([line]) => line);

beforeEach(() => jest.clearAllMocks());

describe("FR1/FR2 a parseable final answer sends today's requests and log lines", () => {
  it("FR1 natural finish after one tool turn", async () => {
    const scenario = harness([
      { content: "", toolCalls: [toolCall("c1", "read_file", { path: "src/a.ts" })] },
      { content: FINAL_JSON },
    ]);
    const result = await scenario.run();

    expect(result).toEqual({ content: FINAL_JSON, turns: 2, toolCalls: 1, compactions: 0 });
    expect(
      scenario.calls.map((call) => ({
        toolChoice: call.toolChoice,
        usageContext: call.usageContext,
        messages: digest(call.messages),
      }))
    ).toEqual([
      {
        toolChoice: undefined,
        usageContext: { phase: "agent", agentTurn: 1, recovery: false },
        messages: "6b41e6a09cd19e7d96043133e536b9bd67f2ca68058363ecac58deb9e56f3108",
      },
      {
        toolChoice: undefined,
        usageContext: { phase: "agent", agentTurn: 2, recovery: false },
        messages: "417cfedbe541dd4b22100485bf188b72ffe3835711ff9e18255cfc80c8e24ed5",
      },
    ]);
    expect(scenario.calls.every((call) => call.tools === REVIEW_TOOLS)).toBe(true);
    expect(infoLines()).toEqual([
      "Agent turn 1/40",
      "Agent tool: Running read_file",
      "Agent turn 2/40",
      "Agent finished after 2 turn(s), 1 tool call(s), 0 compaction(s).",
    ]);
    expect(warningLines()).toEqual([]);
    expect(scenario.progress.map((update) => update.turn)).toEqual([1, 1, 2]);
  });

  it.each([
    { maxTurns: 1, key: "FR2a" },
    { maxTurns: 0, key: "FR2b" },
  ])("FR2 forced final with a JSON answer ($key)", async ({ maxTurns, key }) => {
    const scripts: Script[] =
      maxTurns === 0
        ? [{ content: FINAL_JSON }]
        : [{ content: "", toolCalls: [toolCall("c1", "read_file", { path: "src/a.ts" })] }, { content: FINAL_JSON }];
    const scenario = harness(scripts, { maxTurns });
    const result = await scenario.run();

    expect(result).toEqual({ content: FINAL_JSON, turns: maxTurns === 0 ? 1 : 2, toolCalls: maxTurns === 0 ? 0 : 1, compactions: 0 });
    expect(
      scenario.calls.map((call) => ({
        toolChoice: call.toolChoice,
        usageContext: call.usageContext,
        messages: digest(call.messages),
      }))
    ).toEqual(
      key === "FR2a"
        ? [
            {
              toolChoice: undefined,
              usageContext: { phase: "agent", agentTurn: 1, recovery: false },
              messages: "60f8efb7a41206b797298a43aab56a78648b22300e4b1202c456c2b157525ebf",
            },
            {
              toolChoice: "none",
              usageContext: { phase: "forced-final", agentTurn: 2, recovery: false },
              messages: "45951c2014a98d62b5bffef12571f26fa986e8cead553ea8eeb690475f1790b8",
            },
          ]
        : [
            {
              toolChoice: "none",
              usageContext: { phase: "forced-final", agentTurn: 1, recovery: false },
              messages: "54ebc53a5089680d19f5b8f3773ae28ad34be926c603342a33fdd95d9798f065",
            },
          ]
    );
    expect(warningLines()).toEqual([]);
    expect(infoLines()).toEqual(
      key === "FR2a"
        ? [
            "Agent turn 1/1",
            "Agent tool: Running read_file",
            "Agent reached the 1-turn limit; requesting the final review without tools.",
          ]
        : ["Agent reached the 0-turn limit; requesting the final review without tools."]
    );
  });
});

describe("FR3/FR3b the repair only covers a forced final that a robot cannot parse", () => {
  it.each(["oops", "no issues"])("FR3 natural finish stays unchanged for %j", async (answer) => {
    const scenario = harness([{ content: answer }]);
    const result = await scenario.run();

    expect(result).toEqual({ content: answer, turns: 1, toolCalls: 0, compactions: 0 });
    expect(scenario.calls.map((call) => digest(call.messages))).toEqual([
      "6b41e6a09cd19e7d96043133e536b9bd67f2ca68058363ecac58deb9e56f3108",
    ]);
    expect(infoLines()).toEqual(["Agent turn 1/40", "Agent finished after 1 turn(s), 0 tool call(s), 0 compaction(s)."]);
    expect(warningLines()).toEqual([]);
  });

  const rows = [
    { label: 'short prose "oops"', content: "oops", repair: false },
    { label: 'short prose "no issues"', content: "no issues", repair: false },
    {
      label: "long markdown summary",
      content: "## Summary\nThe change looks fine overall, though I did not inspect every caller in detail.",
      repair: false,
    },
    {
      label: "markdown with a finding",
      content: "## High\n- src/a.ts:2 — Something is wrong in this line.",
      repair: false,
    },
    { label: "JSON with zero findings", content: FINAL_JSON, repair: false },
    { label: "fenced JSON", content: "```json\n" + FINAL_JSON + "\n```", repair: false },
    { label: "prose with an embedded JSON object", content: "Here is the review: " + FINAL_JSON, repair: false },
  ];

  it.each(rows)("FR3b forced final: $label", async ({ content, repair }) => {
    const scenario = harness(repair ? [{ content }, { content: FINAL_JSON }] : [{ content }], { maxTurns: 0 });
    const result = await scenario.run();

    expect(scenario.calls).toHaveLength(repair ? 2 : 1);
    expect(result.content).toBe(repair ? FINAL_JSON : content);
    expect(result.turns).toBe(repair ? 2 : 1);
    if (repair) {
      expect(scenario.calls[1].toolChoice).toBe("none");
      expect(infoLines().at(-1)).toBe("Final review repair: used the corrected answer.");
      expect(infoLines().filter((line) => line.startsWith("Final review repair:"))).toEqual([
        "Final review repair: used the corrected answer.",
      ]);
    } else {
      expect(infoLines()).toEqual(["Agent reached the 0-turn limit; requesting the final review without tools."]);
    }
    expect(warningLines()).toEqual([]);
  });
});

describe("PQ1 silent parsing keeps the default output and logs", () => {
  it("default parseDetailed output and logs are unchanged", () => {
    jest.clearAllMocks();
    expect(ReviewParser.parseDetailed(FINAL_JSON)).toEqual({
      findings: {
        summary: "ok",
        high: [],
        medium: [],
        low: [],
        suggestions: [],
        rawResponse: FINAL_JSON,
      },
      usedJson: true,
    });
    expect(infoLines()).toEqual(["Parsed JSON review: 0 high, 0 medium, 0 low, 0 suggestions"]);

    jest.clearAllMocks();
    const markdown = "## Summary\nSomething to check.\n\n## High\n- src/a.ts:2 — Broken.";
    expect(ReviewParser.parseDetailed(markdown)).toEqual({
      findings: {
        summary: "Something to check.",
        high: [
          {
            severity: "high",
            category: "",
            description: "Broken.",
            recommendation: "",
            file: "src/a.ts",
            line: 2,
          },
        ],
        medium: [],
        low: [],
        suggestions: [],
        rawResponse: markdown,
      },
      usedJson: false,
    });
    expect(infoLines()).toEqual(["Parsed: 1 high, 0 medium, 0 low, 0 suggestions"]);
    expect(warningLines()).toEqual([]);
  });
});
