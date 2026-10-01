import { detectLlmProvider, isOpenAIReasoningModel, normalizeLlmBaseUrl } from "./llm-provider";

describe("detectLlmProvider", () => {
  it("recognizes the hosted providers by hostname", () => {
    expect(detectLlmProvider("https://api.anthropic.com/v1")).toBe("anthropic");
    expect(detectLlmProvider("https://api.anthropic.com")).toBe("anthropic");
    expect(detectLlmProvider("https://api.openai.com/v1")).toBe("openai");
    expect(detectLlmProvider("https://openrouter.ai/api/v1")).toBe("openrouter");
  });

  it("treats everything else as a generic OpenAI-compatible endpoint", () => {
    expect(detectLlmProvider("https://api.groq.com/openai/v1")).toBe("other");
    expect(detectLlmProvider("http://localhost:11434/v1")).toBe("other");
    expect(detectLlmProvider("not a url")).toBe("other");
    expect(detectLlmProvider("https://openai.com.evil.example/v1")).toBe("other");
  });
});

describe("normalizeLlmBaseUrl", () => {
  it.each([
    ["https://api.anthropic.com", "https://api.anthropic.com/v1"],
    ["https://api.anthropic.com/", "https://api.anthropic.com/v1"],
    ["https://api.anthropic.com/v1", "https://api.anthropic.com/v1"],
    ["https://api.anthropic.com/v1/", "https://api.anthropic.com/v1"],
    ["https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1"],
    ["https://api.anthropic.com/v1/chat/completions", "https://api.anthropic.com/v1"],
    ["  https://api.anthropic.com/v1  ", "https://api.anthropic.com/v1"],
  ])("maps Anthropic URL %s to %s", (input, expected) => {
    expect(normalizeLlmBaseUrl(input)).toBe(expected);
  });

  it.each([
    ["https://api.openai.com", "https://api.openai.com/v1"],
    ["https://api.openai.com/v1", "https://api.openai.com/v1"],
    ["https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1"],
  ])("maps OpenAI URL %s to %s", (input, expected) => {
    expect(normalizeLlmBaseUrl(input)).toBe(expected);
  });

  it("only strips the endpoint suffix for other hosts", () => {
    expect(normalizeLlmBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeLlmBaseUrl("https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeLlmBaseUrl("https://api.groq.com/openai/v1/chat/completions")).toBe(
      "https://api.groq.com/openai/v1"
    );
    expect(normalizeLlmBaseUrl("http://my-server:11434/v1")).toBe("http://my-server:11434/v1");
    expect(normalizeLlmBaseUrl("https://gateway.example/custom/path")).toBe(
      "https://gateway.example/custom/path"
    );
  });

  it("returns unparseable input unchanged so the SDK reports the real error", () => {
    expect(normalizeLlmBaseUrl("not a url")).toBe("not a url");
  });
});

describe("isOpenAIReasoningModel", () => {
  it.each([
    "o1",
    "o1-mini",
    "o1-preview",
    "o3",
    "o3-mini",
    "o3-pro",
    "o4-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5-codex",
    "codex-mini-latest",
    "openai/gpt-5",
    "OpenAI/O3-Mini",
  ])("detects %s", (model) => {
    expect(isOpenAIReasoningModel(model)).toBe(true);
  });

  it.each([
    "gpt-4o",
    "gpt-4.1",
    "gpt-4o-mini",
    "gpt-oss-120b",
    "claude-sonnet-4-5",
    "llama3.2",
    "openrouter/free",
    "o",
    "obsidian-7b",
    "",
    undefined,
  ])("does not flag %s", (model) => {
    expect(isOpenAIReasoningModel(model)).toBe(false);
  });
});
