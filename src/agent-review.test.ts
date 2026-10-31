jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as core from "@actions/core";
import { runAgentReview } from "./agent-review";
import type { ChatCompletionResult, ChatMessage } from "./llm-client";
import { ToolsUnsupportedError } from "./llm-client";

const FINAL_JSON = '{"summary":"ok","high":[],"medium":[],"low":[],"suggestions":[]}';

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: JSON.stringify(args) };
}

function makeToolbox() {
  return {
    execute: jest.fn(async (name: string, args: string) => `${name} result for ${args}`),
    describe: jest.fn((name: string) => `Running ${name}`),
  };
}

/** Snapshot the messages at call time; the loop keeps appending to the same array. */
function makeLlm(
  responses: Array<ChatCompletionResult | Error>,
  summaries: Array<string | Error> = ["NOTES: auth.ts line 3 drops the token check."]
) {
  const calls: Array<{ messages: ChatMessage[]; options?: { toolChoice?: string } }> = [];
  const chatWithTools = jest.fn(async (messages: ChatMessage[], _tools: unknown, options?: { toolChoice?: string }) => {
    calls.push({ messages: messages.map((message) => ({ ...message })), options });
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    if (next instanceof Error) throw next;
    return next;
  });
  const chatCompletion = jest.fn(async (_system: string, _user: string) => {
    const next = summaries.shift();
    if (next === undefined) throw new Error("no more scripted summaries");
    if (next instanceof Error) throw next;
    return { content: next };
  });
  return { llm: { chatWithTools, chatCompletion }, calls, chatCompletion };
}

const contextFull = () =>
  Object.assign(new Error("400 This model's maximum context length is 200000 tokens."), { status: 400 });

describe("runAgentReview", () => {
  it("runs tool calls, feeds results back, and returns the final answer", async () => {
    const { llm, calls } = makeLlm([
      {
        content: "",
        toolCalls: [
          toolCall("c1", "read_file", { path: "src/a.ts" }),
          toolCall("c2", "grep", { pattern: "login" }),
        ],
      },
      { content: FINAL_JSON },
    ]);
    const toolbox = makeToolbox();
    const progress = jest.fn();

    const result = await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "    1  +const a = 1;",
      changedFiles: ["src/a.ts"],
      instructions: "Be strict about auth.",
      onProgress: progress,
    });

    expect(result).toEqual({ content: FINAL_JSON, turns: 2, toolCalls: 2, compactions: 0 });
    expect(toolbox.execute).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls.map(([update]) => update)).toEqual([
      expect.objectContaining({ phase: "model", turn: 1, toolCalls: 0, activity: expect.stringContaining("planning") }),
      expect.objectContaining({ phase: "tool", turn: 1, toolCalls: 1, activity: expect.stringContaining("read_file") }),
      expect.objectContaining({ phase: "tool", turn: 1, toolCalls: 2, activity: expect.stringContaining("grep") }),
      expect.objectContaining({ phase: "model", turn: 2, toolCalls: 2, activity: "Thinking about the next step" }),
    ]);

    const [first, second] = calls;
    expect(first.messages[0]).toMatchObject({ role: "system" });
    expect(String(first.messages[0].content)).toContain("Be strict about auth.");
    expect(String(first.messages[1].content)).toContain("- src/a.ts");
    expect(second.messages.slice(2)).toEqual([
      expect.objectContaining({
        role: "assistant",
        tool_calls: [
          expect.objectContaining({ id: "c1", function: expect.objectContaining({ name: "read_file" }) }),
          expect.objectContaining({ id: "c2", function: expect.objectContaining({ name: "grep" }) }),
        ],
      }),
      expect.objectContaining({ role: "tool", tool_call_id: "c1" }),
      expect.objectContaining({ role: "tool", tool_call_id: "c2" }),
    ]);
  });

  it("asks for a final answer without tools when the turn limit is reached", async () => {
    const { llm, calls } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "list_files", {})] },
      { content: "", toolCalls: [toolCall("c2", "list_files", {})] },
      { content: FINAL_JSON },
    ]);

    const result = await runAgentReview({
      llm,
      toolbox: makeToolbox(),
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { maxTurns: 2 },
    });

    expect(result.content).toBe(FINAL_JSON);
    expect(calls).toHaveLength(3);
    expect(calls[2].options).toEqual(expect.objectContaining({ toolChoice: "none" }));
    const lastMessage = calls[2].messages[calls[2].messages.length - 1];
    expect(lastMessage).toMatchObject({ role: "user" });
    expect(String(lastMessage.content)).toContain("2-turn limit");
  });

  it("stops investigating once the deadline passes", async () => {
    let clock = 0;
    const { llm, calls } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "list_files", {})] },
      { content: FINAL_JSON },
    ]);
    const toolbox = makeToolbox();
    toolbox.execute.mockImplementation(async () => {
      clock += 10_000;
      return "listing";
    });

    await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { deadlineMs: 5_000 },
      now: () => clock,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].options).toEqual(expect.objectContaining({ toolChoice: "none" }));
    expect(String(calls[1].messages[calls[1].messages.length - 1].content)).toContain("time limit");
  });

  it("compacts older turns into model-written notes once tool output passes the budget", async () => {
    const { llm, calls, chatCompletion } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "read_file", { path: "src/auth.ts" })] },
      { content: "", toolCalls: [toolCall("c2", "grep", { pattern: "verifyToken" })] },
      { content: FINAL_JSON },
    ]);
    const toolbox = makeToolbox();
    toolbox.execute.mockImplementation(async (name: string) =>
      name === "read_file" ? "read_file:" + "x".repeat(900) : "grep:" + "x".repeat(150)
    );

    const result = await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { maxContextChars: 1_000 },
    });

    expect(result.compactions).toBe(1);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    const summaryPrompt = chatCompletion.mock.calls[0][1];
    expect(summaryPrompt).toContain("read_file");
    expect(summaryPrompt).not.toContain("grep:");

    const afterCompaction = calls[2].messages;
    expect(String(afterCompaction[1].content)).toContain("CONTEXT WAS COMPACTED");
    expect(String(afterCompaction[1].content)).toContain("auth.ts line 3 drops the token check");
    expect(afterCompaction.slice(2)).toEqual([
      expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "c2" })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "c2" }),
    ]);
  });

  it("shrinks the default tool-output budget as the diff grows", async () => {
    const run = async (diffChars: number) => {
      const { llm, chatCompletion } = makeLlm([
        { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
        { content: FINAL_JSON },
      ]);
      const toolbox = makeToolbox();
      toolbox.execute.mockResolvedValue("x".repeat(200_000));
      await runAgentReview({
        llm,
        toolbox,
        annotatedDiff: "d".repeat(diffChars),
        changedFiles: [],
        instructions: "",
      });
      return chatCompletion.mock.calls.length;
    };

    expect(await run(10_000)).toBe(0);
    expect(await run(300_000)).toBe(1);
  });

  it("compacts and retries the turn when the provider reports the context is full", async () => {
    const { llm, calls } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
      { content: "", toolCalls: [toolCall("c2", "read_file", { path: "b" })] },
      contextFull(),
      { content: FINAL_JSON },
    ]);

    const result = await runAgentReview({
      llm,
      toolbox: makeToolbox(),
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
    });

    expect(result).toMatchObject({ content: FINAL_JSON, compactions: 1 });
    expect(calls).toHaveLength(4);
    expect(String(calls[3].messages[1].content)).toContain("CONTEXT WAS COMPACTED");
    expect(calls[3].messages.some((message) => message.role === "tool" && message.tool_call_id === "c1")).toBe(false);
  });

  it("keeps the final-answer request when compacting during the final turn", async () => {
    const { llm, calls } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "list_files", {})] },
      contextFull(),
      { content: FINAL_JSON },
    ]);

    await runAgentReview({
      llm,
      toolbox: makeToolbox(),
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { maxTurns: 1 },
    });

    const retried = calls[2];
    expect(retried.options).toEqual(expect.objectContaining({ toolChoice: "none" }));
    expect(String(retried.messages[retried.messages.length - 1].content)).toContain("Do not call any more tools");
  });

  it("drops the oldest tool results when summarization fails", async () => {
    const { llm, calls } = makeLlm(
      [
        { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
        { content: "", toolCalls: [toolCall("c2", "read_file", { path: "b" })] },
        { content: FINAL_JSON },
      ],
      [new Error("summary provider down")]
    );
    const toolbox = makeToolbox();
    toolbox.execute.mockImplementation(async (_name: string, args: string) =>
      args.includes('"a"') ? "y".repeat(800) : "z".repeat(200)
    );

    await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { maxContextChars: 900 },
    });

    const toolMessages = calls[2].messages.filter((message) => message.role === "tool");
    expect(String(toolMessages[0].content)).toContain("Earlier tool result removed");
    expect(String(toolMessages[1].content)).toBe("z".repeat(200));
  });

  it("gives up when the context is full and nothing is left to compact", async () => {
    const { llm } = makeLlm([contextFull(), contextFull()], [new Error("down"), new Error("down")]);

    await expect(
      runAgentReview({ llm, toolbox: makeToolbox(), annotatedDiff: "diff", changedFiles: [], instructions: "" })
    ).rejects.toThrow(/maximum context length/);
  });

  it("propagates ToolsUnsupportedError so the caller can fall back", async () => {
    const { llm } = makeLlm([new ToolsUnsupportedError(new Error("No endpoints found that support tool use"))]);

    await expect(
      runAgentReview({ llm, toolbox: makeToolbox(), annotatedDiff: "diff", changedFiles: [], instructions: "" })
    ).rejects.toBeInstanceOf(ToolsUnsupportedError);
  });

  it("fails when the forced final turn returns no text", async () => {
    const { llm } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "list_files", {})] },
      { content: "", toolCalls: [toolCall("c2", "list_files", {})] },
    ]);

    await expect(
      runAgentReview({
        llm,
        toolbox: makeToolbox(),
        annotatedDiff: "diff",
        changedFiles: [],
        instructions: "",
        budgets: { maxTurns: 1 },
      })
    ).rejects.toThrow(/no final answer/);
  });
});

it("RC04 retains private replay in the compaction tail and forced final, outside summaries and reporting", async () => {
  const removed = "PRIVATE_REMOVED \n Ω ";
  const retained = "PRIVATE_RETAINED \t 🐦 ";
  const { llm, calls, chatCompletion } = makeLlm([
    { content: "Inspecting a", reasoningContent: removed, toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
    { content: "Inspecting b", reasoningContent: retained, toolCalls: [toolCall("c2", "read_file", { path: "b" })] },
    { content: FINAL_JSON, reasoningContent: "PRIVATE_FINAL" },
  ]);
  const toolbox = makeToolbox();
  toolbox.execute.mockImplementation(async (_name, args) => args.includes('"a"') ? "a".repeat(900) : "b".repeat(200));
  const progress = jest.fn();
  jest.clearAllMocks();
  const result = await runAgentReview({
    llm, toolbox, annotatedDiff: "diff", changedFiles: [], instructions: "",
    budgets: { maxTurns: 2, maxContextChars: 1000 }, onProgress: progress,
  });
  expect(result).toEqual({ content: FINAL_JSON, turns: 3, toolCalls: 2, compactions: 1 });
  expect(chatCompletion).toHaveBeenCalledTimes(1);
  const summary = chatCompletion.mock.calls[0][1];
  expect(summary).toContain("Inspecting a");
  expect(summary).not.toContain("PRIVATE_");
  expect(summary).not.toContain("Inspecting b");
  expect(calls[1].messages.find(message => message.role === "assistant")).toHaveProperty("reasoning_content", removed);
  const final = calls[2];
  expect(final.options).toEqual(expect.objectContaining({ toolChoice: "none" }));
  expect(String(final.messages[1].content)).toContain("CONTEXT WAS COMPACTED");
  expect(final.messages.slice(2)).toEqual([
    expect.objectContaining({ role: "assistant", reasoning_content: retained, tool_calls: [expect.objectContaining({ id: "c2" })] }),
    expect.objectContaining({ role: "tool", tool_call_id: "c2", content: "b".repeat(200) }),
    expect.objectContaining({ role: "user", content: expect.stringContaining("Do not call any more tools") }),
  ]);
  for (const { messages } of calls) {
    for (const message of messages.filter(message => message.role !== "assistant")) {
      expect(message).not.toHaveProperty("reasoning_content");
    }
  }
  expect(JSON.stringify([result, progress.mock.calls, (core.info as jest.Mock).mock.calls,
    (core.warning as jest.Mock).mock.calls, (core.error as jest.Mock).mock.calls])).not.toContain("PRIVATE_");
});

test("UR04 real client ledger covers compaction shrinking and forced-final context recovery", async () => {
  const { LLMClient } = await import("./llm-client");
  const { UsageLedger } = await import("./usage-report");
  const ledger = new UsageLedger();
  const llm = new LLMClient("https://provider.invalid/v1", "synthetic", "model", undefined, undefined, 1, undefined, undefined, undefined, ledger);
  let count = 0;
  const create = jest.fn(async (request: any) => {
    count++;
    const usage = { prompt_tokens: count * 10, completion_tokens: count, total_tokens: count * 11 };
    if (count === 2 || count === 5) throw Object.assign(contextFull(), { error: { usage } });
    const tool = count === 1 || count === 4;
    return { model: "backend", usage, choices: [{ finish_reason: tool ? "tool_calls" : "stop", message: {
      content: request.tools ? tool ? "private turn" : FINAL_JSON : "compacted notes",
      reasoning_content: "private reasoning sentinel",
      ...(tool ? { tool_calls: [{ id: `c${count}`, type: "function", function: { name: "read_file", arguments: '{"path":"file"}' } }] } : {}),
    } }] };
  });
  (llm as any).client = { chat: { completions: { create } } };
  const toolbox = makeToolbox();
  toolbox.execute.mockResolvedValueOnce("x".repeat(2000)).mockResolvedValueOnce("y".repeat(200));
  const result = await runAgentReview({ llm, toolbox, annotatedDiff: "diff", changedFiles: ["file"], instructions: "",
    budgets: { maxTurns: 2, maxContextChars: 1000 } });
  expect(result).toMatchObject({ content: FINAL_JSON, turns: 3, toolCalls: 2, compactions: 2 });
  const r = ledger.report();
  expect(r.full.ledger.map(a => [a.phase, a.agent_turn, a.compaction_index, a.compaction_attempt, a.recovery])).toEqual([
    ["agent", 1, null, null, false],
    ["compaction", 1, 1, 1, false], ["compaction", 1, 1, 2, false],
    ["agent", 2, null, null, false],
    ["forced-final", 3, null, null, false], ["compaction", 2, 2, 1, false],
    ["forced-final", 3, null, null, true],
  ]);
  expect(r.compact.attempts).toBe(7);
  expect(r.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 280, nonfinal_attempts: 2, complete: false });
  expect(JSON.stringify(r)).not.toContain("private reasoning sentinel");
  expect(toolbox.execute).toHaveBeenCalledTimes(2);
});

test("RB03 real guard shrinks an oversize summary, then forces final with complete diff and prior usage", async () => {
  const { LLMClient } = await import("./llm-client");
  const { UsageLedger } = await import("./usage-report");
  const ledger = new UsageLedger();
  const llm = new LLMClient("https://provider.invalid/v1", "synthetic", "unknown-model", undefined, undefined, 3, undefined, undefined, undefined, ledger, 10000);
  const requests: any[] = [];
  const create = jest.fn(async (body: any) => {
    requests.push(JSON.parse(JSON.stringify(body)));
    const first = requests.length === 1;
    return { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, choices: [{
      finish_reason: first ? "tool_calls" : "stop", message: {
        content: first ? "investigation" : body.tools ? FINAL_JSON : "SHORT_INVESTIGATION_NOTES",
        reasoning_content: "PRIVATE_BUDGET_REPLAY",
        ...(first ? { tool_calls: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, type: "function", function: { name: "read_file", arguments: '{}' } })) } : {}),
      },
    }] };
  });
  (llm as any).client = { chat: { completions: { create } } };
  const toolbox = makeToolbox(); toolbox.execute.mockResolvedValue("x".repeat(20000));
  const result = await runAgentReview({ llm, toolbox, annotatedDiff: "FULL_DIFF_END_RB03", changedFiles: ["file"], instructions: "",
    budgets: { maxTurns: 1, maxContextChars: 1000000 } });
  expect(result).toMatchObject({ content: FINAL_JSON, compactions: 1, turns: 2 });
  expect(requests).toHaveLength(3);
  expect(ledger.report().full.ledger.map(a => [a.phase, a.compaction_attempt, a.recovery])).toEqual([
    ["agent", null, false], ["compaction", 2, false], ["forced-final", null, true],
  ]);
  expect(ledger.report().compact.metrics.prompt_tokens.observed_sum).toBe(30);
  expect(JSON.stringify(requests[1])).not.toContain("PRIVATE_BUDGET_REPLAY");
  for (const body of requests) {
    const input = Math.ceil(Buffer.byteLength(JSON.stringify(body, null, 2), "utf8") / 3);
    expect(input + 1250 + 625).toBeLessThanOrEqual(10000);
    if (body.tools) expect(JSON.stringify(body.messages)).toContain("FULL_DIFF_END_RB03");
  }
  expect(requests[2].tool_choice).toBe("none");
  expect(requests[2].messages.at(-1).content).toContain("Return the final review now");
  expect(requests[2].messages[1].content).toContain("SHORT_INVESTIGATION_NOTES");
});

test("RB03 base input alone fails without provider or compaction calls", async () => {
  const { LLMClient } = await import("./llm-client");
  const { UsageLedger } = await import("./usage-report");
  const { EstimatedRequestBudgetError } = await import("./request-budget");
  const ledger = new UsageLedger();
  const llm = new LLMClient("https://provider.invalid/v1", "synthetic", "unknown-model", undefined, undefined, 3, undefined, undefined, undefined, ledger, 100);
  const create = jest.fn(); (llm as any).client = { chat: { completions: { create } } };
  await expect(runAgentReview({ llm, toolbox: makeToolbox(), annotatedDiff: "whole diff", changedFiles: [], instructions: "" }))
    .rejects.toBeInstanceOf(EstimatedRequestBudgetError);
  expect(create).not.toHaveBeenCalled();
  expect(ledger.report().compact.attempts).toBe(0);
});

test("RB03 oversized assistant history cannot be summarized/elided; stops with earlier usage intact", async () => {
  const { LLMClient } = await import("./llm-client");
  const { UsageLedger } = await import("./usage-report");
  const { EstimatedRequestBudgetError } = await import("./request-budget");
  const ledger = new UsageLedger();
  const llm = new LLMClient("https://provider.invalid/v1", "synthetic", "unknown-model", undefined, undefined, 3, undefined, undefined, undefined, ledger, 10000);
  const create = jest.fn(async () => ({ usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    choices: [{ finish_reason: "tool_calls", message: { content: "a".repeat(50000),
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{}' } }] } }] }));
  (llm as any).client = { chat: { completions: { create } } };
  const toolbox = makeToolbox(); toolbox.execute.mockResolvedValue("short result");
  await expect(runAgentReview({ llm, toolbox, annotatedDiff: "whole diff", changedFiles: [], instructions: "",
    budgets: { maxTurns: 1, maxContextChars: 1000000 } })).rejects.toBeInstanceOf(EstimatedRequestBudgetError);
  expect(create).toHaveBeenCalledTimes(1);
  expect(ledger.report().full.ledger).toHaveLength(1);
  expect(ledger.report().compact.metrics.prompt_tokens.observed_sum).toBe(10);
});

test("RB03 summary notes that cannot shrink the full conversation stop after one summary", async () => {
  const { LLMClient } = await import("./llm-client");
  const { UsageLedger } = await import("./usage-report");
  const { EstimatedRequestBudgetError } = await import("./request-budget");
  const ledger = new UsageLedger();
  const llm = new LLMClient("https://provider.invalid/v1", "synthetic", "unknown-model", undefined, undefined, 3, undefined, undefined, undefined, ledger, 10000);
  let calls = 0;
  const create = jest.fn(async () => ({ usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    choices: [{ finish_reason: ++calls === 1 ? "tool_calls" : "stop", message: calls === 1
      ? { content: "inspect", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{}' } }] }
      : { content: "n".repeat(2500) } }] }));
  (llm as any).client = { chat: { completions: { create } } };
  const toolbox = makeToolbox(); toolbox.execute.mockResolvedValue("x".repeat(2000));
  await expect(runAgentReview({ llm, toolbox, annotatedDiff: "whole diff", changedFiles: [], instructions: "i".repeat(13000),
    budgets: { maxTurns: 1, maxContextChars: 1000000 } })).rejects.toBeInstanceOf(EstimatedRequestBudgetError);
  expect(create).toHaveBeenCalledTimes(2);
  expect(ledger.report().full.ledger.map(a => a.phase)).toEqual(["agent", "compaction"]);
  expect(ledger.report().compact.metrics.prompt_tokens.observed_sum).toBe(20);
});
