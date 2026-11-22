import { runAgentReview } from "./agent-review";
import { LlmRequestCancelledError } from "./llm-retry";
import type { ChatMessage } from "./llm-client";

const json = '{"summary":"ok","high":[],"medium":[],"low":[],"suggestions":[]}';
function setup(responses: Array<string | Error>, enabled = true, maxTurns = 5) {
  const calls: Array<{ messages: ChatMessage[]; choice?: string }> = [];
  const llm = { chatWithTools: jest.fn(async (messages: ChatMessage[], _tools: unknown, options?: {toolChoice?: string}) => { calls.push({ messages: messages.map(m => ({...m})), choice: options?.toolChoice }); const next = responses.shift(); if (next instanceof Error) throw next; return { content: next ?? "" }; }), chatCompletion: jest.fn() };
  const toolbox = { execute: jest.fn(), describe: jest.fn() };
  return { calls, run: () => runAgentReview({ llm, toolbox, annotatedDiff: "diff", changedFiles: [], instructions: "", repairUnparseableFinal: enabled, budgets: { maxTurns } }) };
}
test("F1 off leaves prose unchanged", async () => { const s = setup(["oops"], false); expect((await s.run()).content).toBe("oops"); expect(s.calls).toHaveLength(1); });
test("F2 repair retains investigation and returns JSON", async () => { const s = setup(["oops", json]); const r = await s.run(); expect(r.content).toBe(json); expect(r.turns).toBe(2); expect(s.calls[1].choice).toBe("none"); expect(s.calls[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({role:"assistant",content:"oops"}), expect.objectContaining({role:"user",content:expect.stringContaining("investigation so far")})])); });
test("F3 failed repair returns original", async () => { const s = setup(["oops", "again"]); expect((await s.run()).content).toBe("oops"); expect(s.calls).toHaveLength(2); });
test("F4 valid JSON needs no repair", async () => { const s = setup([json]); expect((await s.run()).content).toBe(json); expect(s.calls).toHaveLength(1); });
test("F5 forced final is repaired", async () => { const s = setup(["oops", json], true, 0); const r = await s.run(); expect(r.content).toBe(json); expect(r.turns).toBe(2); });
test("F6 repair errors preserve original", async () => { const s = setup(["oops", new Error("failure")]); expect((await s.run()).content).toBe("oops"); });
test("F7 empty answer adds no empty assistant", async () => { const s = setup(["", json]); expect((await s.run()).content).toBe(json); expect(s.calls[1].messages.some(m => m.role === "assistant" && !m.content)).toBe(false); });

test("F6 cancellation propagates", async () => { const s = setup(["oops", new LlmRequestCancelledError()]); await expect(s.run()).rejects.toBeInstanceOf(LlmRequestCancelledError); });
test("F6 deadline reached after the final answer prevents repair", async () => {
  let time = 0;
  const chatWithTools = jest.fn(async () => ({ get content() { time = 1000; return "oops"; } }));
  const result = await runAgentReview({ llm: { chatWithTools, chatCompletion: jest.fn() }, toolbox: { execute: jest.fn(), describe: jest.fn() }, annotatedDiff: "diff", changedFiles: [], instructions: "", repairUnparseableFinal: true, budgets: { deadlineMs: 1000 }, now: () => time });
  expect(result.content).toBe("oops");
  expect(chatWithTools).toHaveBeenCalledTimes(1);
});
