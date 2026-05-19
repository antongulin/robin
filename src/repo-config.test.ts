import {
  DEFAULT_ACTION_MAX_COMMENTS,
  DEFAULT_ACTION_MAX_DIFF_SIZE,
  REUSABLE_WORKFLOW_MAX_COMMENTS,
  parseRepoConfigYaml,
  resolveJsonResponseMode,
  resolveMaxComments,
  resolveMaxDiffSize,
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
      resolveMaxComments(String(DEFAULT_ACTION_MAX_COMMENTS), { maxComments: 8 })
    ).toBe(8);
  });

  it("uses repo config when reusable workflow passes max-comments 10", () => {
    expect(
      resolveMaxComments(String(REUSABLE_WORKFLOW_MAX_COMMENTS), { maxComments: 8 })
    ).toBe(8);
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
