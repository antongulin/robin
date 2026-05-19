# Universal Code Reviewer v1 Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1 improvements: repo config file, diff pre-filter, JSON response mode with parse retry, workflow concurrency, beginner-friendly docs, and `@main` pinning for agents.

**Architecture:** Load optional `.github/universal-code-reviewer.yml` from the PR base branch, merge limits with action inputs, filter the unified diff before truncation, call the LLM with optional `response_format: json_object`, parse JSON with one retry, post reviews via existing `GitHubReviewer`. Docs and `AGENTS.md` live outside the action runtime.

**Tech Stack:** TypeScript, GitHub Actions (`@actions/core`, `@actions/github`), OpenAI SDK (OpenAI-compatible), Jest, ESLint, `@vercel/ncc` bundle → `dist/index.js`, Node 24.

**Worktree:** `.worktrees/feat-v1-improvements` on branch `feat/v1-improvements`.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/diff-filter.ts` | Split unified diff by file; glob skip patterns |
| `src/diff-filter.test.ts` | Tests for pattern matching and filtering |
| `src/repo-config.ts` | Parse repo YAML subset; resolve inputs vs config |
| `src/repo-config.test.ts` | Config parser and resolver tests |
| `src/llm-client.ts` | JSON mode, model logging, `{ content, model }` result |
| `src/main.ts` | Wire config, filter, LLM, parse retry |
| `action.yml` | `config-file`, `use-json-response-mode` inputs |
| `.github/workflows/review.yml` | `concurrency` group per PR |
| `.github/universal-code-reviewer.yml.example` | Consumer template |
| `README.md` | Junior-friendly setup; `@main` only |
| `docs/ADVANCED.md` | Power-user reference |
| `AGENTS.md` | Rules for AI agents (`@main`, not `@v0`) |
| `.agents/skills/add-to-repository/SKILL.md` | Agent skill for adding to repos |
| `CHANGELOG.md` | Unreleased section |

---

### Task 1: Diff filter module

**Files:**
- Create: `src/diff-filter.ts`
- Create: `src/diff-filter.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/diff-filter.test.ts
import { filterDiff, matchPathPattern } from "./diff-filter";

it("removes lockfiles from unified diff", () => {
  const diff = [
    "diff --git a/package-lock.json b/package-lock.json",
    "--- a/package-lock.json",
    "+++ b/package-lock.json",
    "@@ -1 +1 @@",
    "+x",
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1 +1 @@",
    "+const x = 1;",
  ].join("\n");
  const { filtered, removedFiles } = filterDiff(diff);
  expect(removedFiles).toEqual(["package-lock.json"]);
  expect(filtered).toContain("src/app.ts");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/diff-filter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `diff-filter.ts`**

Export `DEFAULT_SKIP_PATH_PATTERNS`, `matchPathPattern`, `splitDiffIntoFiles`, `filterDiff`. Default skips: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `*.min.js`, `*.min.css`, `dist/**`, `node_modules/**`.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/diff-filter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/diff-filter.ts src/diff-filter.test.ts
git commit -m "feat: filter lockfiles and generated paths from review diff"
```

---

### Task 2: Repo config loader

**Files:**
- Create: `src/repo-config.ts`
- Create: `src/repo-config.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { parseRepoConfigYaml, resolveMaxDiffSize, DEFAULT_ACTION_MAX_DIFF_SIZE } from "./repo-config";

it("parses max-diff-size and skip-paths", () => {
  const cfg = parseRepoConfigYaml("max-diff-size: 25000\nskip-paths:\n  - \"**/generated/**\"");
  expect(cfg.maxDiffSize).toBe(25000);
  expect(cfg.skipPaths).toEqual(["**/generated/**"]);
});

it("uses repo max-diff when action input is default 50000", () => {
  expect(resolveMaxDiffSize("50000", { maxDiffSize: 25000 })).toBe(25000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/repo-config.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `repo-config.ts`**

Constants: `DEFAULT_CONFIG_FILE = ".github/universal-code-reviewer.yml"`, `DEFAULT_ACTION_MAX_DIFF_SIZE = 50000`, `DEFAULT_ACTION_MAX_COMMENTS = 25`. Implement `parseRepoConfigYaml`, `resolveMaxDiffSize`, `resolveMaxComments`, `resolveJsonResponseMode`.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/repo-config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/repo-config.ts src/repo-config.test.ts
git commit -m "feat: load universal-code-reviewer.yml repo config"
```

---

### Task 3: LLM JSON mode and model logging

**Files:**
- Modify: `src/llm-client.ts`

- [ ] **Step 1: Change return type to `ChatCompletionResult`**

```typescript
export interface ChatCompletionResult {
  content: string;
  model?: string;
}

async chatCompletion(systemPrompt: string, userContent: string, jsonResponseMode = false): Promise<ChatCompletionResult> {
  // ...
  if (jsonResponseMode) {
    request.response_format = { type: "json_object" };
  }
  const response = await this.client.chat.completions.create(request);
  const resolvedModel = response.model || this.model;
  core.info(resolvedModel !== this.model
    ? `LLM resolved model: ${resolvedModel} (requested: ${this.model})`
    : `LLM response model: ${resolvedModel}`);
  return { content: response.choices[0]?.message?.content || "", model: resolvedModel };
}
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: PASS (no llm-client unit tests yet)

- [ ] **Step 3: Commit**

```bash
git add src/llm-client.ts
git commit -m "feat: support JSON response mode and log resolved model"
```

---

### Task 4: Wire main orchestration

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Load repo config after PR number is known**

Call `loadRepoConfig(octokit, gitUtils, owner, repo, prNumber, configFile, baseRef)` reading file via `gitUtils.getFileContent` on base SHA.

- [ ] **Step 2: Apply resolvers and diff filter**

```typescript
const maxDiffSize = resolveMaxDiffSize(maxDiffSizeInput, repoConfig);
const maxComments = resolveMaxComments(maxCommentsInput, repoConfig);
const jsonResponseMode = resolveJsonResponseMode(jsonResponseModeInput, repoConfig);
const { filtered, removedFiles } = filterDiff(diff, repoConfig.skipPaths || []);
const reviewDiff = filtered.trim() ? filtered : diff;
```

- [ ] **Step 3: Parse retry on empty structured review**

```typescript
let findings = ReviewParser.parse(reviewText);
if (shouldRetryStructuredReview(findings)) {
  const retryText = (await runReview(llm, truncatedDiff,
    `${reviewInstructions}\n\nReturn ONLY a single valid JSON object. Do not use markdown.`, true)).content;
  findings = ReviewParser.parse(retryText);
}
```

`shouldRetryStructuredReview`: no findings in any bucket and summary length ≤ 40.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: integrate config, diff filter, and JSON parse retry"
```

---

### Task 5: Action and workflow inputs

**Files:**
- Modify: `action.yml`
- Modify: `.github/workflows/review.yml`

- [ ] **Step 1: Add action inputs**

```yaml
  config-file:
    default: ".github/universal-code-reviewer.yml"
  use-json-response-mode:
    default: "true"
```

- [ ] **Step 2: Add workflow concurrency**

```yaml
concurrency:
  group: ucr-${{ github.event.pull_request.number || github.event.issue.number }}-${{ github.workflow }}
  cancel-in-progress: true
```

- [ ] **Step 3: Commit**

```bash
git add action.yml .github/workflows/review.yml
git commit -m "feat: add config inputs and cancel duplicate PR reviews"
```

---

### Task 6: Documentation and agent guardrails

**Files:**
- Create: `README.md` (simplified)
- Create: `docs/ADVANCED.md`
- Create: `AGENTS.md`
- Create: `.github/universal-code-reviewer.yml.example`
- Create: `.agents/skills/add-to-repository/SKILL.md`
- Modify: `SECURITY.md`, `CHANGELOG.md`
- Modify: `.gitignore` (add `.worktrees/`)

- [ ] **Step 1: Simplify README**

3-step setup; OpenRouter free table; workflow uses `@main` only; warn against `@v0`; link to ADVANCED.md.

- [ ] **Step 2: Add AGENTS.md**

Explicit: use `antongulin/universal-code-reviewer/.github/workflows/review.yml@main`; never `@v0`.

- [ ] **Step 3: Add example config and ADVANCED config section**

- [ ] **Step 4: Commit**

```bash
git add README.md docs/ AGENTS.md .agents/ .github/universal-code-reviewer.yml.example SECURITY.md CHANGELOG.md .gitignore
git commit -m "docs: simplify README and add agent setup guardrails"
```

---

### Task 7: Build and verify bundle

**Files:**
- Modify: `dist/index.js` (generated)

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: ncc completes without errors

- [ ] **Step 2: Verify bundle committed**

Run: `git diff --exit-code dist/index.js`
Expected: exit 0 after `git add dist/`

- [ ] **Step 3: Full CI locally**

Run: `npm run lint && npm test && npm run build`
Expected: 27+ tests PASS

- [ ] **Step 4: Commit bundle**

```bash
git add dist/
git commit -m "chore: rebuild action bundle"
```

---

### Task 8: Ship branch

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/v1-improvements
```

- [ ] **Step 2: Open PR to `main`**

```bash
gh pr create --title "feat: v1 config, diff filter, JSON mode, simpler docs" --body "$(cat <<'EOF'
## Summary
- Repo config file support (`.github/universal-code-reviewer.yml`)
- Diff pre-filter for lockfiles, dist, node_modules, minified assets
- JSON response mode + parse retry + OpenRouter model logging
- Workflow concurrency per PR
- Beginner README + AGENTS.md (`@main` only)

## Test plan
- [ ] CI passes on PR
- [ ] Dogfood review with OpenRouter `openrouter/free` on a test PR
EOF
)"
```

---

## Self-review

| Requirement | Task |
| --- | --- |
| Repo config file | Task 2, 4, 6 |
| Diff pre-filter | Task 1, 4 |
| JSON mode + retry | Task 3, 4 |
| Concurrency | Task 5 |
| Simple README + `@main` | Task 6 |
| OpenRouter docs | Task 6 |
| Tests | Tasks 1–4, 7 |
| Bundle | Task 7 |

**Placeholder scan:** None.

**Status:** All tasks complete. PR https://github.com/antongulin/universal-code-reviewer/pull/7 is mergeable (28 tests passing).

---

## Out of scope (v1.x follow-up)

- Large PR chunking by file/hunk
- Provider presets (`provider: openrouter-free`)
- GitHub App + external worker
