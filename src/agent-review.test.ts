jest.mock("@actions/core", () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

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
    expect(calls[2].options).toEqual({ toolChoice: "none" });
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
    expect(calls[1].options).toEqual({ toolChoice: "none" });
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
    expect(retried.options).toEqual({ toolChoice: "none" });
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
