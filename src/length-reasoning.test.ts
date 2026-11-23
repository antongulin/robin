import { CompletionLengthError } from "./llm-client";

const PREFIX = "Incomplete LLM output (finish_reason=length";
const DISCARDED = ". Partial text and tool calls were discarded.";
const REASONING_NOTE = (reasoning: number, completion: number) =>
  ` Reasoning used the whole output budget (reasoning_tokens=${reasoning}, completion_tokens=${completion}), ` +
  "so no answer text was produced: raise max-output-tokens or lower reasoning-effort.";

test("L1 names reasoning that consumed the whole output budget", () => {
  const error = new CompletionLengthError({
    prompt_tokens: 111265,
    completion_tokens: 64000,
    total_tokens: 175265,
    cached_input_tokens: 108160,
    reasoning_tokens: 64000,
  });

  expect(error.message).toBe(
    `${PREFIX}; prompt_tokens=111265, completion_tokens=64000, total_tokens=175265, ` +
      "cached_input_tokens=108160, reasoning_tokens=64000). Partial text and tool calls were discarded. " +
      "Reasoning used the whole output budget (reasoning_tokens=64000, completion_tokens=64000), " +
      "so no answer text was produced: raise max-output-tokens or lower reasoning-effort."
  );
  expect(error.finishReason).toBe("length");
  expect(error.usage).toMatchObject({ reasoning_tokens: 64000, completion_tokens: 64000 });
});

test("L1 also names reasoning above the completion total", () => {
  const error = new CompletionLengthError({
    prompt_tokens: 100,
    completion_tokens: 64000,
    total_tokens: 64100,
    reasoning_tokens: 64001,
  });

  expect(error.message).toBe(
    `${PREFIX}; prompt_tokens=100, completion_tokens=64000, total_tokens=64100, ` +
      `reasoning_tokens=64001). Partial text and tool calls were discarded.${REASONING_NOTE(64001, 64000)}`
  );
});

it.each([
  {
    name: "reasoning below the completion total",
    usage: { prompt_tokens: 100, completion_tokens: 64000, total_tokens: 64100, reasoning_tokens: 63999 },
    message: `${PREFIX}; prompt_tokens=100, completion_tokens=64000, total_tokens=64100, reasoning_tokens=63999)${DISCARDED}`,
  },
  {
    name: "missing reasoning count",
    usage: { prompt_tokens: 100, completion_tokens: 64000, total_tokens: 64100 },
    message: `${PREFIX}; prompt_tokens=100, completion_tokens=64000, total_tokens=64100)${DISCARDED}`,
  },
  {
    name: "missing completion count",
    usage: { prompt_tokens: 100, reasoning_tokens: 64000 },
    message: `${PREFIX}; prompt_tokens=100, reasoning_tokens=64000)${DISCARDED}`,
  },
  {
    name: "zero completion and zero reasoning",
    usage: { completion_tokens: 0, reasoning_tokens: 0 },
    message: `${PREFIX}; completion_tokens=0, reasoning_tokens=0)${DISCARDED}`,
  },
  {
    name: "no usage at all",
    usage: undefined,
    message: "Incomplete LLM output (finish_reason=length). Partial text and tool calls were discarded.",
  },
])("L2 keeps today's exact text for $name", ({ usage, message }) => {
  expect(new CompletionLengthError(usage).message).toBe(message);
  expect(new CompletionLengthError(usage).message).not.toContain("Reasoning used the whole output budget");
});
