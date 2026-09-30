import {
  DEFAULT_AGENT_MAX_DIFF_SIZE,
  DEFAULT_AGENT_MAX_TURNS,
  DEFAULT_MAX_COMMENTS,
  DEFAULT_ACTION_MAX_DIFF_SIZE,
  DEFAULT_REASONING_EFFORT,
  isReasoningEffortConfigured,
  parseRepoConfigYaml,
  resolveAgentMaxDiffSize,
  resolveAgentMaxTurns,
  resolveAgentMode,
  resolveJsonResponseMode,
  resolveMaxComments,
  resolveMaxDiffSize,
  resolveReasoningEffort,
  resolveRequestChanges,
} from "./repo-config";

describe("parseRepoConfigYaml", () => {
  it("parses supported keys", () => {
    const config = parseRepoConfigYaml(`
max-diff-size: 25000
max-comments: 8
json-response-mode: false
skip-paths:
  - "**/generated/**"
  - vendor/**
`);

    expect(config.maxDiffSize).toBe(25000);
    expect(config.maxComments).toBe(8);
    expect(config.jsonResponseMode).toBe(false);
    expect(config.skipPaths).toEqual(["**/generated/**", "vendor/**"]);
  });

  it("parses reasoning-effort as a case-preserving string", () => {
    expect(parseRepoConfigYaml("reasoning-effort: high").reasoningEffort).toBe("high");
    expect(parseRepoConfigYaml('reasoning-effort: "xhigh"').reasoningEffort).toBe("xhigh");
    expect(parseRepoConfigYaml("reasoning-effort: 'medium'").reasoningEffort).toBe("medium");
    expect(parseRepoConfigYaml("reasoning-effort: ProviderCustom").reasoningEffort).toBe(
      "ProviderCustom"
    );
  });

  it("leaves reasoning-effort unset when the repo config value is empty", () => {
    expect(parseRepoConfigYaml("reasoning-effort:").reasoningEffort).toBeUndefined();
    expect(parseRepoConfigYaml('reasoning-effort: ""').reasoningEffort).toBeUndefined();
  });

  it("tolerates the inline comments the shipped examples use", () => {
    expect(
      parseRepoConfigYaml("reasoning-effort: high   # provider-dependent; unset sends none")
        .reasoningEffort
    ).toBe("high");
    expect(
      parseRepoConfigYaml("request-changes: false # advisor mode").requestChanges
    ).toBe(false);
  });

  it("keeps a hash that is part of a quoted value", () => {
    expect(parseRepoConfigYaml('reasoning-effort: "provider#custom"').reasoningEffort).toBe(
      "provider#custom"
    );
    expect(parseRepoConfigYaml('reasoning-effort: "provider #custom"').reasoningEffort).toBe(
      "provider #custom"
    );
    expect(
      parseRepoConfigYaml('reasoning-effort: "provider #custom" # trailing note').reasoningEffort
    ).toBe("provider #custom");
  });

  it("strips an inline comment containing an apostrophe", () => {
    expect(
      parseRepoConfigYaml("reasoning-effort: high   # provider's note").reasoningEffort
    ).toBe("high");
  });

  it("handles escaped quotes and multi-word unquoted values", () => {
    expect(parseRepoConfigYaml('reasoning-effort: "a\\"b" # note').reasoningEffort).toBe('a"b');
    expect(parseRepoConfigYaml("reasoning-effort: very high").reasoningEffort).toBe("very high");
  });
});

describe("resolveMaxDiffSize", () => {
  it("uses repo config when action input is still the default", () => {
    expect(
      resolveMaxDiffSize(String(DEFAULT_ACTION_MAX_DIFF_SIZE), { maxDiffSize: 25000 })
    ).toBe(25000);
  });

  it("keeps explicit action input over repo config", () => {
    expect(resolveMaxDiffSize("12000", { maxDiffSize: 25000 })).toBe(12000);
  });
});

describe("resolveMaxComments", () => {
  it("uses repo config when action input is still the default", () => {
    expect(
      resolveMaxComments(String(DEFAULT_MAX_COMMENTS), { maxComments: 8 })
    ).toBe(8);
  });

  it("honors an explicit non-default action input over repo config", () => {
    expect(resolveMaxComments("5", { maxComments: 8 })).toBe(5);
  });

  it("honors max-comments 0 from repo config", () => {
    expect(resolveMaxComments(String(DEFAULT_MAX_COMMENTS), { maxComments: 0 })).toBe(0);
  });
});

describe("resolveJsonResponseMode", () => {
  it("prefers explicit action input, then repo config, then default true", () => {
    expect(resolveJsonResponseMode("false", { jsonResponseMode: true })).toBe(false);
    expect(resolveJsonResponseMode("true", { jsonResponseMode: false })).toBe(true);
    expect(resolveJsonResponseMode("", { jsonResponseMode: false })).toBe(false);
    expect(resolveJsonResponseMode("", undefined)).toBe(true);
  });
});

describe("resolveRequestChanges", () => {
  it("prefers explicit action input, then repo config, then default true", () => {
    expect(resolveRequestChanges("false", { requestChanges: true })).toBe(false);
    expect(resolveRequestChanges("true", { requestChanges: false })).toBe(true);
    expect(resolveRequestChanges("", { requestChanges: false })).toBe(false);
    expect(resolveRequestChanges("", undefined)).toBe(true);
  });
});

describe("resolveReasoningEffort", () => {
  it("prefers a non-empty action input over repo config and trims it", () => {
    expect(resolveReasoningEffort("  low ", { reasoningEffort: "high" })).toBe("low");
  });

  it("falls back to repo config when the input is empty or whitespace", () => {
    expect(resolveReasoningEffort("", { reasoningEffort: "high" })).toBe("high");
    expect(resolveReasoningEffort("   ", { reasoningEffort: "high" })).toBe("high");
  });

  it("defaults to high when neither the input nor repo config sets it", () => {
    expect(DEFAULT_REASONING_EFFORT).toBe("high");
    expect(resolveReasoningEffort("", undefined)).toBe("high");
    expect(resolveReasoningEffort("  ", {})).toBe("high");
    expect(resolveReasoningEffort("", { reasoningEffort: "  " })).toBe("high");
  });

  it("sends nothing when the value is off, in any case", () => {
    expect(resolveReasoningEffort("off", undefined)).toBeUndefined();
    expect(resolveReasoningEffort(" OFF ", { reasoningEffort: "high" })).toBeUndefined();
    expect(resolveReasoningEffort("", { reasoningEffort: "Off" })).toBeUndefined();
  });

  it("keeps none as a provider value rather than an opt-out", () => {
    expect(resolveReasoningEffort("none", undefined)).toBe("none");
  });
});

describe("isReasoningEffortConfigured", () => {
  it("is true only when the user set a value via input or repo config", () => {
    expect(isReasoningEffortConfigured("high", undefined)).toBe(true);
    expect(isReasoningEffortConfigured("", { reasoningEffort: "low" })).toBe(true);
    expect(isReasoningEffortConfigured("off", undefined)).toBe(true);
    expect(isReasoningEffortConfigured("", undefined)).toBe(false);
    expect(isReasoningEffortConfigured("  ", {})).toBe(false);
    expect(isReasoningEffortConfigured("", { reasoningEffort: "  " })).toBe(false);
  });
});

describe("agent mode config", () => {
  it("parses agent-mode and agent-max-turns", () => {
    const config = parseRepoConfigYaml("agent-mode: off   # diff only\nagent-max-turns: 6\n");
    expect(config.agentMode).toBe("off");
    expect(config.agentMaxTurns).toBe(6);
    expect(parseRepoConfigYaml("agent-mode: sometimes").agentMode).toBeUndefined();
  });

  it("prefers the action input, then repo config, then auto", () => {
    expect(resolveAgentMode("", {})).toBe("auto");
    expect(resolveAgentMode("", { agentMode: "off" })).toBe("off");
    expect(resolveAgentMode("auto", { agentMode: "off" })).toBe("auto");
    expect(resolveAgentMode("OFF", {})).toBe("off");
    expect(resolveAgentMode("bogus", { agentMode: "off" })).toBe("off");
  });

  it("resolves max turns with a default and an upper cap", () => {
    expect(resolveAgentMaxTurns("", {})).toBe(DEFAULT_AGENT_MAX_TURNS);
    expect(resolveAgentMaxTurns("", { agentMaxTurns: 4 })).toBe(4);
    expect(resolveAgentMaxTurns("7", { agentMaxTurns: 4 })).toBe(7);
    expect(resolveAgentMaxTurns("0", {})).toBe(DEFAULT_AGENT_MAX_TURNS);
    expect(resolveAgentMaxTurns("500", {})).toBe(100);
  });

  it("resolves the agent diff size separately from max-diff-size", () => {
    expect(parseRepoConfigYaml("agent-max-diff-size: 120000").agentMaxDiffSize).toBe(120000);
    expect(resolveAgentMaxDiffSize("", {})).toBe(DEFAULT_AGENT_MAX_DIFF_SIZE);
    expect(resolveAgentMaxDiffSize("", { agentMaxDiffSize: 90000, maxDiffSize: 25000 })).toBe(90000);
    expect(resolveAgentMaxDiffSize("300000", { agentMaxDiffSize: 90000 })).toBe(300000);
    expect(resolveAgentMaxDiffSize("0", {})).toBe(DEFAULT_AGENT_MAX_DIFF_SIZE);
  });
});
