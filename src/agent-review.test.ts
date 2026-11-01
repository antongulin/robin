jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as core from "@actions/core";
import { runAgentReview } from "./agent-review";
import type { ChatCompletionResult, ChatMessage } from "./llm-client";
import { CompletionLengthError, LLMRequestError, ToolsUnsupportedError } from "./llm-client";
import { AgentDeadlineError } from "./llm-retry";
import { assertRequestFits, EstimatedRequestBudgetError, serializedJsonBytes } from "./request-budget";

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

const bytesOf = (messages: ChatMessage[]) => serializedJsonBytes({ messages });
const hashOf = (messages: ChatMessage[]) => JSON.stringify(messages);

/** No kept tool result may be orphaned from the assistant call that requested it. */
function expectPairedToolResults(messages: ChatMessage[]) {
  const assistantIds = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" ? (message.tool_calls ?? []).map((call) => call.id) : []
    )
  );
  for (const message of messages) {
    if (message.role === "tool") expect(assistantIds).toContain(message.tool_call_id);
  }
}

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
      expect.objectContaining({ phase: "tool", turn: 1, toolCalls: 0, activity: expect.stringContaining("read_file") }),
      expect.objectContaining({ phase: "tool", turn: 1, toolCalls: 1, activity: expect.stringContaining("grep") }),
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

  it("does not dispatch a forced final once the overall deadline has passed", async () => {
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

    const run = runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { deadlineMs: 5_000 },
      now: () => clock,
    });

    await expect(run).rejects.toBeInstanceOf(AgentDeadlineError);
    await expect(run).rejects.toThrow(/overall deadline/);
    expect(calls).toHaveLength(1);
  });

  it("stops tools at the investigation cutoff but still finalizes before the overall deadline", async () => {
    let clock = 0;
    const { llm, calls } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "list_files", {})] },
      { content: FINAL_JSON },
    ]);
    const toolbox = makeToolbox();
    toolbox.execute.mockImplementation(async () => {
      clock = 9_500;
      return "listing";
    });

    const result = await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { deadlineMs: 10_000 },
      now: () => clock,
    });

    expect(result.content).toBe(FINAL_JSON);
    expect(calls).toHaveLength(2);
    expect(calls[1].options).toEqual(expect.objectContaining({ toolChoice: "none" }));
    expect(String(calls[1].messages[calls[1].messages.length - 1].content)).toContain("time limit");
  });

  it("marks unrun tool calls when the time budget ends mid-turn", async () => {
    let clock = 0;
    const { llm, calls } = makeLlm([
      {
        content: "",
        toolCalls: [toolCall("c1", "read_file", { path: "a" }), toolCall("c2", "read_file", { path: "b" })],
      },
      { content: FINAL_JSON },
    ]);
    const toolbox = makeToolbox();
    toolbox.execute.mockImplementation(async () => {
      clock = 9_500;
      return "first result";
    });

    const result = await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { deadlineMs: 10_000 },
      now: () => clock,
    });

    expect(result.content).toBe(FINAL_JSON);
    const toolMessages = calls[1].messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(String(toolMessages[0].content)).toBe("first result");
    expect(String(toolMessages[1].content)).toContain("not executed");
    expect(toolbox.execute).toHaveBeenCalledTimes(1);
    expect(calls[1].options).toEqual(expect.objectContaining({ toolChoice: "none" }));
  });

  it("does not start tools when a progress update consumes the investigation reserve", async () => {
    let clock = 0;
    const { llm, calls } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" }), toolCall("c2", "read_file", { path: "b" })] },
      { content: FINAL_JSON },
    ]);
    const toolbox = makeToolbox();
    const result = await runAgentReview({
      llm, toolbox, annotatedDiff: "diff", changedFiles: [], instructions: "",
      budgets: { deadlineMs: 10_000 }, now: () => clock,
      onProgress: async (update) => { if (update.phase === "tool") clock = 9_500; },
    });

    expect(toolbox.execute).not.toHaveBeenCalled();
    expect(result).toMatchObject({ content: FINAL_JSON, toolCalls: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[1].options?.toolChoice).toBe("none");
    expect(calls[1].messages.filter((message) => message.role === "tool")).toEqual([
      expect.objectContaining({ tool_call_id: "c1", content: expect.stringContaining("not executed") }),
      expect.objectContaining({ tool_call_id: "c2", content: expect.stringContaining("not executed") }),
    ]);
  });

  it("keeps the latest exchange as a verbatim tail when a compaction keeps a small group", async () => {
    const { llm, calls, chatCompletion } = makeLlm([
      { content: `Inspecting ${"a".repeat(24_000)}`, toolCalls: [toolCall("c1", "read_file", { path: "src/auth.ts" })] },
      { content: "", toolCalls: [toolCall("c2", "grep", { pattern: "verifyToken" })] },
      { content: FINAL_JSON },
    ]);
    const toolbox = makeToolbox();
    toolbox.execute.mockImplementation(async (name: string) =>
      name === "read_file" ? "read_file:" + "x".repeat(100) : "grep:" + "x".repeat(2_000)
    );

    const result = await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { maxContextBytes: 26_000 },
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
    expectPairedToolResults(afterCompaction);
  });

  it("keeps the working-history target independent of the diff size", async () => {
    const run = async (diffChars: number) => {
      const { llm, chatCompletion } = makeLlm([
        { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
        { content: FINAL_JSON },
      ]);
      const toolbox = makeToolbox();
      toolbox.execute.mockResolvedValue("x".repeat(460_000));
      await runAgentReview({
        llm,
        toolbox,
        annotatedDiff: "d".repeat(diffChars),
        changedFiles: [],
        instructions: "",
      });
      return chatCompletion.mock.calls.length;
    };

    expect(await run(10_000)).toBe(1);
    expect(await run(300_000)).toBe(1);
  });

  it("compacts and retries the turn when the provider reports the context is full", async () => {
    const { llm, calls } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
      { content: "", toolCalls: [toolCall("c2", "read_file", { path: "b" })] },
      contextFull(),
      { content: FINAL_JSON },
    ]);
    const toolbox = makeToolbox();
    toolbox.execute.mockResolvedValue("x".repeat(3_000));

    const result = await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
    });

    expect(result).toMatchObject({ content: FINAL_JSON, compactions: 1 });
    expect(calls).toHaveLength(4);
    expect(String(calls[3].messages[1].content)).toContain("CONTEXT WAS COMPACTED");
    expect(calls[3].messages.some((message) => message.role === "tool" && message.tool_call_id === "c1")).toBe(false);
    expectPairedToolResults(calls[3].messages);
  });

  it("keeps the final-answer request when compacting during the final turn", async () => {
    const { llm, calls } = makeLlm([
      { content: "", toolCalls: [toolCall("c1", "list_files", {})] },
      contextFull(),
      { content: FINAL_JSON },
    ]);
    const toolbox = makeToolbox();
    toolbox.execute.mockResolvedValue("x".repeat(3_000));

    await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { maxTurns: 1 },
    });

    const retried = calls[2];
    expect(retried.options).toEqual(expect.objectContaining({ toolChoice: "none" }));
    expect(String(retried.messages[retried.messages.length - 1].content)).toContain("Do not call any more tools");
  });

  it("drops only consumed tool results when summarization fails", async () => {
    const { llm, calls, chatCompletion } = makeLlm(
      [
        { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
        { content: "", toolCalls: [toolCall("c2", "read_file", { path: "b" })] },
        { content: FINAL_JSON },
      ],
      [Object.assign(new Error("summary provider down"), { name: "UNTRUSTED_PROVIDER_ERROR_NAME" })]
    );
    const toolbox = makeToolbox();
    toolbox.execute.mockResolvedValue("z".repeat(800));

    await runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { maxContextBytes: 1_500 },
    });

    expect(chatCompletion).toHaveBeenCalledTimes(1);
    const toolMessages = calls[2].messages.filter((message) => message.role === "tool");
    expect(String(toolMessages[0].content)).toContain("Earlier tool result removed");
    expect(String(toolMessages[1].content)).toBe("z".repeat(800));
    expect(JSON.stringify((core.warning as jest.Mock).mock.calls)).not.toContain("UNTRUSTED_PROVIDER_ERROR_NAME");
  });

  it("gives up when the context is full and nothing is left to compact", async () => {
    const { llm, chatCompletion } = makeLlm([contextFull()], [new Error("down")]);

    await expect(
      runAgentReview({ llm, toolbox: makeToolbox(), annotatedDiff: "diff", changedFiles: [], instructions: "" })
    ).rejects.toThrow(/maximum context length/);
    expect(llm.chatWithTools).toHaveBeenCalledTimes(1);
    expect(chatCompletion).not.toHaveBeenCalled();
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

it("A3-2 rebuilds private-heavy history into notes and keeps the newest complete exchange verbatim", async () => {
  const PRIVATE = "PRIVATE_REASONING_SENTINEL" + "p".repeat(590_000);
  const FINDING = "FINDING: src/auth.ts line 3 drops the token check.";
  const PENDING = "PENDING: verify the caller in src/routes.ts.";
  const NEWEST = "NEWEST_RESULT_SENTINEL";
  // Two complete exchanges: the first is large and private-heavy, the second is the newest
  // and small enough to be retained as a verbatim tail. The old bug kept a partial tail and
  // dropped the rest without ever sending it to the model.
  const assistantContent = `${FINDING} ${PENDING}`;
  const { llm, calls, chatCompletion } = makeLlm(
    [
      { content: assistantContent, reasoningContent: PRIVATE, toolCalls: [toolCall("c1", "read_file", { path: "src/auth.ts" })] },
      { content: "SECOND_LOOK", toolCalls: [toolCall("c2", "read_file", { path: "src/routes.ts" })] },
      { content: FINAL_JSON },
    ],
    ["SEEDED_NOTES"]
  );
  const toolbox = makeToolbox();
  toolbox.execute.mockImplementation(async (_name, args) =>
    args.includes("routes.ts") ? `${NEWEST} ${"r".repeat(15_000)}` : `OLD_RESULT ${"r".repeat(1_000)}`
  );

  const result = await runAgentReview({
    llm,
    toolbox,
    annotatedDiff: "diff",
    changedFiles: ["src/auth.ts"],
    instructions: "",
    budgets: { maxContextBytes: 600_000 },
  });

  expect(result).toEqual({ content: FINAL_JSON, turns: 3, toolCalls: 2, compactions: 1 });
  expect(chatCompletion).toHaveBeenCalledTimes(1);
  const summaryPrompt = chatCompletion.mock.calls[0][1];
  expect(summaryPrompt).toContain(FINDING);
  expect(summaryPrompt).toContain(PENDING);
  expect(summaryPrompt).not.toContain("PRIVATE_REASONING_SENTINEL");

  const rebuilt = calls[2].messages;
  expect(String(rebuilt[1].content)).toContain("CONTEXT WAS COMPACTED");
  expect(String(rebuilt[1].content)).toContain("SEEDED_NOTES");
  // The newest exchange survives intact: assistant call plus its tool result, in order.
  expect(rebuilt.slice(2)).toEqual([
    expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "c2" })] }),
    expect.objectContaining({ role: "tool", tool_call_id: "c2", content: expect.stringContaining(NEWEST) }),
  ]);
  expectPairedToolResults(rebuilt);

  const preMessages: ChatMessage[] = [
    ...calls[1].messages,
    {
      role: "assistant",
      content: "SECOND_LOOK",
      tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"src/routes.ts"}' } }],
    },
    { role: "tool", tool_call_id: "c2", content: `${NEWEST} ${"r".repeat(15_000)}` },
  ];
  expect(bytesOf(rebuilt) * 2).toBeLessThan(bytesOf(preMessages));
  expect(JSON.stringify([result, (core.info as jest.Mock).mock.calls,
    (core.warning as jest.Mock).mock.calls, (core.error as jest.Mock).mock.calls])).not.toContain("PRIVATE_REASONING_SENTINEL");
});

it.each([true, false])("uses the latest rejection to size recovery and preserves the first cause (success=%s)", async (succeeds) => {
  const calls: ChatMessage[][] = [];
  let budget = 0;
  let primary: EstimatedRequestBudgetError | undefined;
  const providerError = contextFull();
  const llm = {
    chatWithTools: jest.fn(async (messages: ChatMessage[]) => {
      calls.push(messages.map((message) => ({ ...message })));
      // The first exchange fits; adding the second exceeds this explicit allowance.
      if (!budget) budget = Math.ceil((Math.ceil((bytesOf(messages) + 15_500) / 3) + 32) * 16 / 15);
      try {
        assertRequestFits({ messages }, budget, 32);
      } catch (error) {
        if (error instanceof EstimatedRequestBudgetError) primary ??= error;
        throw error;
      }
      if (calls.length <= 2) return { content: "checking", toolCalls: [toolCall(`c${calls.length}`, "read_file", {})] };
      // Mechanical elision satisfies the local guard, but the provider needs a summary.
      if (calls.length === 4 || !succeeds) throw providerError;
      return { content: FINAL_JSON };
    }),
    chatCompletion: jest.fn(async () => ({ content: "FINDING: " + "n".repeat(2_000) })),
  };
  const toolbox = makeToolbox();
  toolbox.execute.mockResolvedValueOnce("o".repeat(14_000)).mockResolvedValueOnce("n".repeat(8_000));
  const run = runAgentReview({ llm, toolbox, annotatedDiff: "diff", changedFiles: [], instructions: "" });

  if (succeeds) await expect(run).resolves.toMatchObject({ content: FINAL_JSON, compactions: 1 });
  else {
    await expect(run).rejects.toBeInstanceOf(EstimatedRequestBudgetError);
    await expect(run).rejects.toBe(primary);
  }
  expect(primary).toBeDefined();
  expect(calls).toHaveLength(5);
  expect(bytesOf(calls[3])).toBeLessThan(bytesOf(calls[2]));
  expect(bytesOf(calls[4])).toBeLessThan(bytesOf(calls[3]));
  expect(llm.chatCompletion).toHaveBeenCalledTimes(1);
});

it("A3-3/A6-3 allows one semantic summary per evidence epoch and never repeats a body", async () => {
  const { llm, calls, chatCompletion } = makeLlm(
    [
      { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
      contextFull(),
      contextFull(),
    ],
    ["SHRUNK_NOTES"]
  );
  const toolbox = makeToolbox();
  toolbox.execute.mockResolvedValue("x".repeat(10_000));

  await expect(
    runAgentReview({ llm, toolbox, annotatedDiff: "diff", changedFiles: [], instructions: "" })
  ).rejects.toThrow(/maximum context length/);

  expect(chatCompletion).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map((call) => hashOf(call.messages))).size).toBe(calls.length);
});

it("A6-1 does not summarize or dispatch after the deadline and surfaces the primary context cause", async () => {
  let clock = 0;
  const { llm, chatCompletion } = makeLlm([contextFull()]);
  llm.chatWithTools.mockImplementation(async () => {
    clock = 100_000;
    throw contextFull();
  });

  const run = runAgentReview({
    llm,
    toolbox: makeToolbox(),
    annotatedDiff: "diff",
    changedFiles: [],
    instructions: "",
    budgets: { deadlineMs: 5_000 },
    now: () => clock,
  });

  await expect(run).rejects.toBeInstanceOf(AgentDeadlineError);
  await expect(run).rejects.toThrow(/maximum context length/);
  expect(chatCompletion).not.toHaveBeenCalled();
  expect(llm.chatWithTools).toHaveBeenCalledTimes(1);
});

it("A6-2 makes exactly one summary request and stops when that summary hits the deadline", async () => {
  let clock = 0;
  const { llm, chatCompletion } = makeLlm(
    [
      { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
      contextFull(),
    ],
    []
  );
  chatCompletion.mockImplementation(async () => {
    clock = 100_000;
    throw contextFull();
  });
  const toolbox = makeToolbox();
  toolbox.execute.mockResolvedValue("x".repeat(10_000));

  await expect(
    runAgentReview({
      llm,
      toolbox,
      annotatedDiff: "diff",
      changedFiles: [],
      instructions: "",
      budgets: { deadlineMs: 5_000 },
      now: () => clock,
    })
  ).rejects.toThrow(/maximum context length/);
  expect(chatCompletion).toHaveBeenCalledTimes(1);
});

it("rejects an oversized summary without truncating or adopting it", async () => {
  const { llm, calls, chatCompletion } = makeLlm(
    [
      { content: "", toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
      contextFull(),
    ],
    ["n".repeat(12_001)]
  );
  const toolbox = makeToolbox();
  toolbox.execute.mockResolvedValue("x".repeat(10_000));

  await expect(
    runAgentReview({ llm, toolbox, annotatedDiff: "diff", changedFiles: [], instructions: "" })
  ).rejects.toThrow(/maximum context length/);
  expect(chatCompletion).toHaveBeenCalledTimes(1);
  expect(calls.every((call) => !JSON.stringify(call.messages).includes("CONTEXT WAS COMPACTED"))).toBe(true);
});

it("removes the six-summary lifetime ceiling across more than six evidence epochs", async () => {
  const epochs = 7;
  const responses: ChatCompletionResult[] = Array.from({ length: epochs }, (_, index) => ({
    content: `thinking ${index}`,
    toolCalls: [toolCall(`c${index}`, "read_file", { path: `f${index}` })],
  }));
  responses.push({ content: FINAL_JSON });
  const summaries = Array.from({ length: epochs }, (_, index) => `NOTES_${index}`);
  const { llm, chatCompletion } = makeLlm(responses, summaries);
  const toolbox = makeToolbox();
  toolbox.execute.mockImplementation(async (_name: string, args: string) => {
    const index = args.match(/f(\d+)/)?.[1] ?? "?";
    return `EPOCH_${index}:` + "x".repeat(6_000);
  });

  const result = await runAgentReview({
    llm,
    toolbox,
    annotatedDiff: "diff",
    changedFiles: [],
    instructions: "",
    budgets: { maxTurns: epochs + 1, maxContextBytes: 5_000 },
  });

  expect(result).toEqual({ content: FINAL_JSON, turns: epochs + 1, toolCalls: epochs, compactions: epochs });
  expect(chatCompletion).toHaveBeenCalledTimes(epochs);
  for (let index = 0; index < epochs; index++) {
    expect(chatCompletion.mock.calls[index][1]).toContain(`EPOCH_${index}:`);
  }
});

it("RC04 retains private replay in the compaction tail and forced final, outside summaries and reporting", async () => {
  const removed = "PRIVATE_REMOVED \n Ω ";
  const retained = "PRIVATE_RETAINED \t 🐦 ";
  const { llm, calls, chatCompletion } = makeLlm([
    { content: `Inspecting a ${"a".repeat(24_000)}`, reasoningContent: removed, toolCalls: [toolCall("c1", "read_file", { path: "a" })] },
    { content: "Inspecting b", reasoningContent: retained, toolCalls: [toolCall("c2", "read_file", { path: "b" })] },
    { content: FINAL_JSON, reasoningContent: "PRIVATE_FINAL" },
  ]);
  const toolbox = makeToolbox();
  toolbox.execute.mockImplementation(async (_name, args) => args.includes('"a"') ? "a".repeat(100) : "b".repeat(2_000));
  const progress = jest.fn();
  jest.clearAllMocks();
  const result = await runAgentReview({
    llm, toolbox, annotatedDiff: "diff", changedFiles: [], instructions: "",
    budgets: { maxTurns: 2, maxContextBytes: 26_000 }, onProgress: progress,
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
    expect.objectContaining({ role: "tool", tool_call_id: "c2", content: "b".repeat(2_000) }),
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

test("UR04 real client ledger covers bounded compaction and forced-final context recovery", async () => {
  const { LLMClient } = await import("./llm-client");
  const { UsageLedger } = await import("./usage-report");
  const ledger = new UsageLedger();
  const llm = new LLMClient("https://provider.invalid/v1", "synthetic", "model", undefined, undefined, 1, undefined, undefined, undefined, ledger);
  let count = 0;
  const create = jest.fn(async (request: any) => {
    count++;
    const usage = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 };
    if (count === 2) throw Object.assign(contextFull(), { error: { usage } });
    const tool = count === 1 || count === 4;
    return { model: "backend", usage, choices: [{ finish_reason: tool ? "tool_calls" : "stop", message: {
      content: request.tools ? tool ? "private turn" : FINAL_JSON : "compacted notes",
      reasoning_content: "private reasoning sentinel",
      ...(tool ? { tool_calls: [{ id: `c${count}`, type: "function", function: { name: "read_file", arguments: '{"path":"file"}' } }] } : {}),
    } }] };
  });
  (llm as any).client = { chat: { completions: { create } } };
  const toolbox = makeToolbox();
  toolbox.execute.mockResolvedValueOnce("x".repeat(24_000)).mockResolvedValueOnce("y".repeat(2_000));
  const result = await runAgentReview({ llm, toolbox, annotatedDiff: "diff", changedFiles: ["file"], instructions: "",
    budgets: { maxTurns: 2, maxContextBytes: 26_000 } });
  expect(result).toMatchObject({ content: FINAL_JSON, turns: 3, toolCalls: 2, compactions: 1 });
  const r = ledger.report();
  expect(r.full.ledger.map(a => [a.phase, a.agent_turn, a.compaction_index, a.compaction_attempt, a.recovery])).toEqual([
    ["agent", 1, null, null, false],
    ["agent", 2, null, null, false],
    ["compaction", 2, 1, 1, false],
    ["agent", 2, null, null, true],
    ["forced-final", 3, null, null, false],
  ]);
  expect(r.compact.attempts).toBe(5);
  expect(r.compact.metrics.prompt_tokens).toMatchObject({ observed_sum: 50, nonfinal_attempts: 1, complete: false });
  expect(JSON.stringify(r)).not.toContain("private reasoning sentinel");
  expect(toolbox.execute).toHaveBeenCalledTimes(2);
});

test("RB03 real guard shrinks an oversize summary, then forces final with complete diff and prior usage", async () => {
  const { LLMClient } = await import("./llm-client");
  const { UsageLedger } = await import("./usage-report");
  const ledger = new UsageLedger();
  const llm = new LLMClient("https://provider.invalid/v1", "synthetic", "unknown-model", undefined, undefined, 3, undefined, undefined, undefined, ledger, 20000);
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
  const toolbox = makeToolbox(); toolbox.execute.mockResolvedValue("x".repeat(4_000));
  const annotatedDiff = `FULL_DIFF_END_RB03\n${"d".repeat(20_000)}`;
  const result = await runAgentReview({ llm, toolbox, annotatedDiff, changedFiles: ["file"], instructions: "",
    budgets: { maxTurns: 1, maxContextBytes: 1_000_000 } });
  expect(result).toMatchObject({ content: FINAL_JSON, compactions: 1, turns: 2 });
  expect(requests).toHaveLength(3);
  expect(ledger.report().full.ledger.map(a => [a.phase, a.compaction_attempt, a.recovery])).toEqual([
    ["agent", null, false], ["compaction", 1, false], ["forced-final", null, true],
  ]);
  expect(ledger.report().compact.metrics.prompt_tokens.observed_sum).toBe(30);
  expect(JSON.stringify(requests[1])).not.toContain("PRIVATE_BUDGET_REPLAY");
  for (const body of requests) {
    const input = Math.ceil(Buffer.byteLength(JSON.stringify(body, null, 2), "utf8") / 3);
    expect(input + 2500 + 1250).toBeLessThanOrEqual(20000);
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
    budgets: { maxTurns: 1, maxContextBytes: 1000000 } })).rejects.toBeInstanceOf(EstimatedRequestBudgetError);
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
      : { content: "n".repeat(12000) } }] }));
  (llm as any).client = { chat: { completions: { create } } };
  const toolbox = makeToolbox(); toolbox.execute.mockResolvedValue("x".repeat(10_000));
  await expect(runAgentReview({ llm, toolbox, annotatedDiff: "whole diff", changedFiles: [], instructions: "i".repeat(12_000),
    budgets: { maxTurns: 1, maxContextBytes: 1000000 } })).rejects.toBeInstanceOf(EstimatedRequestBudgetError);
  expect(create).toHaveBeenCalledTimes(2);
  expect(ledger.report().full.ledger.map(a => a.phase)).toEqual(["agent", "compaction"]);
  expect(ledger.report().compact.metrics.prompt_tokens.observed_sum).toBe(20);
});

/** The real client's wrapper: the native status lives on the cause, not the wrapper. */
function wrappedContext(status: number, message = "Request rejected") {
  return new LLMRequestError(`Failed to get response from LLM: ${status} ${message}`, {
    cause: Object.assign(new Error(message), { status }),
  });
}

test("RB04 default budgets keep a large immutable base in one complete request", async () => {
  const diff = `BEGIN_IMMUTABLE_DIFF\n${"d".repeat(300_000)}\nEND_IMMUTABLE_DIFF`;
  const { llm, calls, chatCompletion } = makeLlm([{ content: FINAL_JSON }]);
  const result = await runAgentReview({
    llm, toolbox: makeToolbox(), annotatedDiff: diff, changedFiles: ["src/a.ts"], instructions: "",
  });
  expect(result).toEqual({ content: FINAL_JSON, turns: 1, toolCalls: 0, compactions: 0 });
  expect(calls).toHaveLength(1);
  expect(chatCompletion).not.toHaveBeenCalled();
  const input = String(calls[0].messages[1].content);
  expect(input).toContain("BEGIN_IMMUTABLE_DIFF");
  expect(input).toContain("END_IMMUTABLE_DIFF");
  expect(input).toContain(diff);
});

test("RB04 an oversized immutable base is never summarized into nothing", async () => {
  const error = wrappedContext(413);
  const { llm, chatCompletion } = makeLlm([error]);
  const annotatedDiff = `IMMUTABLE_BASE_START\n${"d".repeat(900_000)}\nIMMUTABLE_BASE_END`;
  await expect(runAgentReview({
    llm, toolbox: makeToolbox(), annotatedDiff, changedFiles: ["src/a.ts"], instructions: "",
  })).rejects.toBe(error);
  expect(llm.chatWithTools).toHaveBeenCalledTimes(1);
  expect(chatCompletion).not.toHaveBeenCalled();
  expect((error as Error).message).toContain("413");
});

test("A5 output-length truncation is not context pressure", async () => {
  const error = new CompletionLengthError({ completion_tokens: 10, reasoning_tokens: 10 });
  const { llm, chatCompletion } = makeLlm([error]);
  await expect(runAgentReview({
    llm, toolbox: makeToolbox(), annotatedDiff: "diff", changedFiles: [], instructions: "",
  })).rejects.toBe(error);
  expect(chatCompletion).not.toHaveBeenCalled();
});

test.each([401, 429])("A5 provider %s is not recovered as context pressure", async status => {
  const error = wrappedContext(
    status,
    status === 401 ? "Unauthorized: context window access denied" : "Too many requests"
  );
  const { llm, chatCompletion } = makeLlm([error]);
  await expect(runAgentReview({
    llm, toolbox: makeToolbox(), annotatedDiff: "diff", changedFiles: [], instructions: "",
  })).rejects.toBe(error);
  expect(chatCompletion).not.toHaveBeenCalled();
});
