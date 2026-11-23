jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import { createHash } from "crypto";
import { Response } from "node-fetch";
import * as core from "@actions/core";
import { runAgentReview } from "./agent-review";
import {
  CompletionLengthError,
  LLMClient,
  LLMRequestError,
  ToolsUnsupportedError,
} from "./llm-client";
import type { ChatCompletionResult, ChatMessage } from "./llm-client";
import { LlmRequestCancelledError } from "./llm-retry";
import { EstimatedRequestBudgetError } from "./request-budget";
import type { EstimatedRequestTokenBudget } from "./request-budget";
import { ReviewParser } from "./review-parser";
import { REVIEW_TOOLS } from "./review-tools";
import { UsageLedger } from "./usage-report";

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
  toolbox: { execute: jest.Mock; describe: jest.Mock };
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
    onResponse?: (index: number) => void;
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
      options.onResponse?.(calls.length - 1);
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
    toolbox,
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
    { label: 'short prose "oops"', content: "oops", repair: true },
    { label: 'short prose "no issues"', content: "no issues", repair: true },
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

  it.each([" ", ""])("FR3c forced final with no text (%j) keeps today's error", async (content) => {
    const scenario = harness([{ content }], { maxTurns: 0 });

    await expect(scenario.run()).rejects.toThrow(
      "Agent review returned no final answer after the tool budget was used."
    );
    expect(scenario.calls).toHaveLength(1);
    expect(infoLines().filter((line) => line.startsWith("Final review repair:"))).toEqual([]);
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

describe("FR4/FR5 the repair request inside the same conversation", () => {
  it("FR4 sends exactly one extra request that reuses the forced final answer", async () => {
    const scenario = harness(
      [
        { content: "", toolCalls: [toolCall("c1", "read_file", { path: "src/a.ts" })] },
        { content: "oops" },
        { content: FINAL_JSON },
      ],
      { maxTurns: 1 }
    );
    const result = await scenario.run();

    expect(scenario.calls).toHaveLength(3);
    const forced = scenario.calls[1];
    const repair = scenario.calls[2];
    expect(repair.toolChoice).toBe("none");
    expect(repair.tools).toBe(REVIEW_TOOLS);
    expect(repair.usageContext).toEqual({ phase: "forced-final", agentTurn: forced.usageContext!.agentTurn + 1, recovery: false });
    expect(repair.messages.slice(0, forced.messages.length)).toEqual(forced.messages);
    expect(repair.messages.slice(forced.messages.length)).toEqual([
      { role: "assistant", content: "oops" },
      { role: "user", content: REPAIR_PROMPT },
    ]);
    expect(result).toEqual({ content: FINAL_JSON, turns: 3, toolCalls: 1, compactions: 0 });
    expect(infoLines().filter((line) => line.startsWith("Final review repair:"))).toEqual([
      "Final review repair: used the corrected answer.",
    ]);
    // The repair never inflates the reported turn number beyond the configured budget.
    expect(scenario.progress.every((update) => update.turn <= 1)).toBe(true);
    expect(scenario.progress.map((update) => update.turn)).toEqual([1, 1, 1, 1]);
    expect(scenario.progress.at(-1)).toMatchObject({
      phase: "model",
      turn: 1,
      activity: "Final answer could not be parsed — asking once for the JSON review",
    });
  });

  it("FR5 repairs after the investigation cutoff while the overall deadline remains", async () => {
    let clock = 0;
    const scenario = harness(
      [
        { content: "", toolCalls: [toolCall("c1", "list_files", {})] },
        { content: "oops" },
        { content: FINAL_JSON },
      ],
      { deadlineMs: 10_000, now: () => clock }
    );
    scenario.toolbox.execute.mockImplementation(async () => {
      clock = 9_500;
      return "listing";
    });

    const result = await scenario.run();

    expect(result.content).toBe(FINAL_JSON);
    expect(result.turns).toBe(3);
    expect(scenario.calls).toHaveLength(3);
    expect(scenario.calls[1].toolChoice).toBe("none");
    expect(String(scenario.calls[1].messages.at(-1)!.content)).toContain("time limit");
    expect(scenario.calls[2].toolChoice).toBe("none");
    expect(infoLines()).toContain("Final review repair: used the corrected answer.");
  });
});

describe("FR6-FR11 the repair never replaces a usable answer with a failure", () => {
  it("FR6 keeps the original answer when the repair reply is unparseable", async () => {
    const scenario = harness([{ content: "oops" }, { content: "again" }], { maxTurns: 0 });
    const result = await scenario.run();

    expect(result.content).toBe("oops");
    expect(result.turns).toBe(2);
    expect(scenario.calls).toHaveLength(2);
    expect(infoLines().filter((line) => line.startsWith("Final review repair:"))).toEqual([
      "Final review repair: the reply could not be parsed; keeping the original answer.",
    ]);
    expect(warningLines()).toEqual([]);
  });

  it("FR7 reports a provider failure category without provider text", async () => {
    const marker = "SECRET_MARKER_8317";
    const scenario = harness(
      [{ content: "oops" }, new LLMRequestError(`Provider request failed: ${marker}`, { cause: new Error(marker) })],
      { maxTurns: 0 }
    );
    const result = await scenario.run();

    expect(result.content).toBe("oops");
    expect(result.turns).toBe(2);
    expect(warningLines()).toEqual([
      "Final review repair failed (request failed); keeping the original answer.",
    ]);
    expect(JSON.stringify([
      result,
      infoLines(),
      warningLines(),
      scenario.progress,
      (core.error as jest.Mock).mock.calls,
    ])).not.toContain(marker);
  });

  it("FR8a recovers inside the repair request exactly like any other request", async () => {
    const contextError = Object.assign(new Error("400 This model's maximum context length is 200000 tokens."), { status: 400 });
    const scenario = harness(
      [
        { content: "", toolCalls: [toolCall("c1", "read_file", { path: "src/a.ts" })] },
        { content: "oops" },
        contextError,
        { content: FINAL_JSON },
      ],
      { maxTurns: 1 }
    );
    scenario.toolbox.execute.mockResolvedValue("x".repeat(2_000));

    const result = await scenario.run();

    expect(result).toMatchObject({ content: FINAL_JSON, turns: 3, compactions: 0 });
    expect(scenario.calls).toHaveLength(4);
    expect(scenario.calls[2].usageContext).toMatchObject({ phase: "forced-final", recovery: false });
    expect(scenario.calls[3].usageContext).toMatchObject({ phase: "forced-final", recovery: true });
    expect(scenario.calls[3].usageContext!.agentTurn).toBe(scenario.calls[2].usageContext!.agentTurn);
    expect(infoLines()).toContain("Final review repair: used the corrected answer.");
    expect(infoLines().some((line) => line.startsWith("Elided consumed tool results:"))).toBe(true);
  });

  it("FR8b keeps the original when an enabled budget cannot fit the repair body", async () => {
    const prose = "oops " + "The change appears fine but I could not summarize it. ".repeat(3_000);
    const budgetError = new EstimatedRequestBudgetError({
      budget: 1_000,
      estimatedInput: 900,
      outputReserve: 100,
      safetyHeadroom: 63,
    });
    let answered = false;
    let readsAfterAnswer = 0;
    const scenario = harness([{ content: prose }, budgetError], {
      maxTurns: 0,
      deadlineMs: 10_000,
      now: () => {
        if (!answered) return 0;
        readsAfterAnswer++;
        // The first read is the per-call deadline check for the forced final request.
        return readsAfterAnswer === 1 ? 0 : 9_500;
      },
      onResponse: () => {
        answered = true;
      },
    });

    const result = await scenario.run();

    expect(result.content).toBe(prose);
    expect(result.turns).toBe(2);
    expect(scenario.calls).toHaveLength(2);
    expect(scenario.llm.chatCompletion).not.toHaveBeenCalled();
    expect(warningLines()).toEqual([
      "Final review repair failed (request budget); keeping the original answer.",
    ]);
  });

  it("FR8c counts a compaction committed during the repair", async () => {
    const contextError = Object.assign(new Error("400 This model's maximum context length is 200000 tokens."), { status: 400 });
    const scenario = harness(
      [
        { content: "a".repeat(9_000), toolCalls: [toolCall("c1", "read_file", { path: "src/a.ts" })] },
        { content: "oops" },
        contextError,
        { content: FINAL_JSON },
      ],
      { maxTurns: 1, summaries: ["NOTES: read src/a.ts and found nothing to report."] }
    );
    // A small tool result cannot be elided down to the target; only a committed summary can.
    scenario.toolbox.execute.mockResolvedValue("y".repeat(500));

    const result = await scenario.run();

    expect(result).toMatchObject({ content: FINAL_JSON, turns: 3, compactions: 1 });
    expect(scenario.llm.chatCompletion).toHaveBeenCalledTimes(1);
    expect(scenario.calls).toHaveLength(4);
    expect(scenario.calls[3].usageContext).toMatchObject({ phase: "forced-final", recovery: true });
    expect(String(scenario.calls[3].messages[1].content)).toContain("CONTEXT WAS COMPACTED");
  });

  it.each([
    { label: "truncated completion", error: new CompletionLengthError({ completion_tokens: 12 }) },
    { label: "unsupported tools", error: new ToolsUnsupportedError(new Error("No endpoints found that support tool use")) },
  ])("FR9 keeps the original answer on a $label failure", async ({ error }) => {
    const scenario = harness([{ content: "oops" }, error], { maxTurns: 0 });
    const result = await scenario.run();

    expect(result.content).toBe("oops");
    expect(result.turns).toBe(2);
    expect(warningLines()).toEqual([
      "Final review repair failed (request failed); keeping the original answer.",
    ]);
  });

  it.each([
    { label: "typed cancellation", error: new LlmRequestCancelledError() },
    { label: "abort error", error: Object.assign(new Error("aborted"), { name: "AbortError" }) },
  ])("FR10 rethrows $label during the repair", async ({ error }) => {
    const scenario = harness([{ content: "oops" }, error], { maxTurns: 0 });
    await expect(scenario.run()).rejects.toBe(error);
  });

  it("FR11a skips the repair when the deadline has already passed", async () => {
    const DEADLINE = 10_000;
    let answered = 0;
    let readsAfterAnswer = 0;
    const scenario = harness([{ content: "oops" }], {
      maxTurns: 0,
      deadlineMs: DEADLINE,
      now: () => {
        if (answered === 0) return 0;
        readsAfterAnswer++;
        return readsAfterAnswer === 1 ? 0 : DEADLINE;
      },
      onResponse: () => {
        answered++;
      },
    });

    const result = await scenario.run();

    expect(result).toEqual({ content: "oops", turns: 1, toolCalls: 0, compactions: 0 });
    expect(scenario.calls).toHaveLength(1);
    expect(infoLines().filter((line) => line.startsWith("Final review repair:"))).toEqual([
      "Final review repair: skipped, the time limit was reached; keeping the original answer.",
    ]);
  });

  it("FR11b keeps the original answer when the deadline is reached during the repair", async () => {
    const DEADLINE = 10_000;
    let answered = 0;
    const scenario = harness([{ content: "oops" }, { content: FINAL_JSON }], {
      maxTurns: 0,
      deadlineMs: DEADLINE,
      now: () => (answered >= 2 ? DEADLINE : 0),
      onResponse: () => {
        answered++;
      },
    });

    const result = await scenario.run();

    expect(result.content).toBe("oops");
    expect(result.turns).toBe(2);
    expect(infoLines().filter((line) => line.startsWith("Final review repair:"))).toEqual([
      "Final review repair: skipped, the time limit was reached; keeping the original answer.",
    ]);
    expect(warningLines()).toEqual([]);
  });
});

describe("FR13 private replay on the repair's assistant message", () => {
  const PRIVATE_TOOL = "PRIVATE_TOOL_REASONING_4411";
  const PRIVATE_FINAL = "PRIVATE_FINAL_REASONING_7731";

  it.each([
    { label: "string reasoning", final: PRIVATE_FINAL, expected: PRIVATE_FINAL },
    { label: "empty reasoning", final: "", expected: "" },
    { label: "absent reasoning", final: undefined, expected: undefined },
  ])("FR13 replays $label unchanged and keeps it out of visible output", async ({ final, expected }) => {
    const scenario = harness(
      [
        { content: "", reasoningContent: PRIVATE_TOOL, toolCalls: [toolCall("c1", "read_file", { path: "src/a.ts" })] },
        { content: "oops", ...(final === undefined ? {} : { reasoningContent: final }) },
        { content: FINAL_JSON, reasoningContent: PRIVATE_FINAL },
      ],
      { maxTurns: 1 }
    );

    const result = await scenario.run();

    expect(result.content).toBe(FINAL_JSON);
    const repair = scenario.calls[2];
    const assistants = repair.messages.filter((message) => message.role === "assistant");
    const repairAssistant = assistants.at(-1) as ChatMessage & { reasoning_content?: string };
    expect(repairAssistant.content).toBe("oops");
    if (expected === undefined) expect(repairAssistant).not.toHaveProperty("reasoning_content");
    else expect(repairAssistant.reasoning_content).toBe(expected);
    // The earlier tool turn keeps its own private metadata on every later request.
    for (const call of scenario.calls.slice(1)) {
      expect(call.messages.find((message) => message.role === "assistant")).toHaveProperty(
        "reasoning_content",
        PRIVATE_TOOL
      );
    }
    expect(JSON.stringify([result, infoLines(), warningLines(), scenario.progress])).not.toContain(
      "PRIVATE_FINAL_REASONING_7731"
    );
    expect(JSON.stringify([result, infoLines(), warningLines(), scenario.progress])).not.toContain(
      "PRIVATE_TOOL_REASONING_4411"
    );
  });
});

describe("FR14 the real client records and preflights the repair request", () => {
  function offlineClient(budget: EstimatedRequestTokenBudget = "off") {
    const ledger = new UsageLedger();
    const client = new LLMClient(
      "https://provider.invalid/v1",
      "offline-not-a-key",
      "test-model",
      undefined,
      60_000,
      1,
      0.1,
      undefined,
      undefined,
      ledger,
      budget
    );
    const sdk = (client as unknown as {
      client: { fetch: (url: unknown, init?: { body?: unknown; signal?: AbortSignal | null }) => Promise<Response> };
    }).client;
    const requests: Array<{ messages: Array<{ role: string; content?: string }>; max_tokens?: number }> = [];
    sdk.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const isRepair = body.messages.some(
        (message: { role: string; content?: string }) => message.role === "user" && message.content === REPAIR_PROMPT
      );
      return completion(isRepair ? FINAL_JSON : "oops");
    };
    return { client, ledger, requests };
  }

  function completion(content: string) {
    return new Response(
      JSON.stringify({
        id: "offline",
        object: "chat.completion",
        created: 0,
        model: "offline-backend",
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  it("FR14a records the repair attempt under forced-final with the next agent turn", async () => {
    const { client, ledger, requests } = offlineClient();
    const result = await runAgentReview({
      llm: client,
      toolbox: { execute: jest.fn(), describe: jest.fn(() => "Reading") },
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { maxTurns: 0 },
    });

    expect(result).toEqual({ content: FINAL_JSON, turns: 2, toolCalls: 0, compactions: 0 });
    expect(requests).toHaveLength(2);
    expect(ledger.report().full.ledger.map((attempt) => [attempt.phase, attempt.agent_turn])).toEqual([
      ["forced-final", 1],
      ["forced-final", 2],
    ]);
  });

  it("FR14b rejects the repair body locally with no physical attempt", async () => {
    const prose = "oops " + "x".repeat(150_000);
    const ledger = new UsageLedger();
    const client = new LLMClient(
      "https://provider.invalid/v1",
      "offline-not-a-key",
      "test-model",
      undefined,
      60_000,
      1,
      0.1,
      undefined,
      undefined,
      ledger,
      40_000
    );
    const sdk = (client as unknown as {
      client: { fetch: (url: unknown, init?: { body?: unknown }) => Promise<Response> };
    }).client;
    let answered = false;
    let readsAfterAnswer = 0;
    let physical = 0;
    sdk.fetch = async () => {
      physical++;
      answered = true;
      return completion(prose);
    };
    const result = await runAgentReview({
      llm: client,
      toolbox: { execute: jest.fn(), describe: jest.fn(() => "Reading") },
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { maxTurns: 0, deadlineMs: 10_000 },
      now: () => {
        if (!answered) return 0;
        readsAfterAnswer++;
        // The first read is the per-call deadline check for the forced final request.
        return readsAfterAnswer === 1 ? 0 : 9_500;
      },
    });

    expect(result.content).toBe(prose);
    expect(physical).toBe(1);
    expect(ledger.report().full.ledger.map((attempt) => attempt.phase)).toEqual(["forced-final"]);
    expect(warningLines()).toContain(
      "Final review repair failed (request budget); keeping the original answer."
    );
  });
});

describe("PQ1 quiet parsing", () => {
  it("returns the same result without any log lines for JSON and markdown", () => {
    const quietJson = ReviewParser.parseDetailed(FINAL_JSON, { quiet: true });
    expect(quietJson).toEqual(ReviewParser.parseDetailed(FINAL_JSON));
    expect(infoLines()).toEqual(["Parsed JSON review: 0 high, 0 medium, 0 low, 0 suggestions"]);

    jest.clearAllMocks();
    const markdown = "## Summary\nSomething to check.\n\n## High\n- src/a.ts:2 — Broken.";
    const quietMarkdown = ReviewParser.parseDetailed(markdown, { quiet: true });
    expect(infoLines()).toEqual([]);
    expect(warningLines()).toEqual([]);
    jest.clearAllMocks();
    expect(quietMarkdown).toEqual(ReviewParser.parseDetailed(markdown));
    expect(infoLines()).toEqual(["Parsed: 1 high, 0 medium, 0 low, 0 suggestions"]);
  });
});
