import * as core from "@actions/core";
import * as github from "@actions/github";
import { LLMClient } from "./llm-client";
import { GitUtils } from "./git-utils";
import { ReviewParser, StructuredReview } from "./review-parser";
import { shouldRetryStructuredReview } from "./review-retry";
import { GitHubReviewer } from "./github-reviewer";
import { DEFAULT_LLM_TIMEOUT_MS, parseLLMTimeout } from "./config";
import { filterDiff, splitDiffIntoFiles } from "./diff-filter";
import { annotateDiffWithLineNumbers } from "./diff-annotate";
import {
  DEFAULT_CONFIG_FILE,
  RepoConfig,
  parseRepoConfigYaml,
  resolveJsonResponseMode,
  resolveMaxComments,
  resolveMaxDiffSize,
} from "./repo-config";
import { getReviewPrompt, getSummaryPrompt, getHelpMessage } from "./prompts/review-prompts";
import { ReviewerCommand, hasRequiredPermission, parseSlashCommand } from "./commands";

async function run(): Promise<void> {
  let octokit: ReturnType<typeof github.getOctokit> | undefined;
  let statusOwner = "";
  let statusRepo = "";
  let statusCommentId: number | undefined;
  let statusCommand: "review" | "summary" = "review";

  try {
    const eventName = github.context.eventName;
    const payload = github.context.payload;
    const token = core.getInput("github-token", { required: true });
    octokit = github.getOctokit(token);
    const minCommandPermission = core.getInput("min-command-permission") || "write";
    const reviewOnSynchronize = core.getBooleanInput("review-on-synchronize");

    core.info(`Event: ${eventName}`);

    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;
    statusOwner = owner;
    statusRepo = repo;

    let shouldRun = false;
    let prNumber: number | undefined;
    let command: ReviewerCommand = "review"; // default command for PR events

    if (eventName === "pull_request_target") {
      core.warning("pull_request_target is intentionally not supported because it can expose secrets to untrusted PR code. Use pull_request or maintainer-only issue_comment commands instead.");
      return;
    }

    if (eventName === "pull_request") {
      if (payload.action === "synchronize" && !reviewOnSynchronize) {
        core.info("Skipping pull_request synchronize event. Pushes to an existing PR are reviewed manually with /review unless review-on-synchronize is true.");
        return;
      }

      shouldRun = true;
      prNumber = payload.pull_request?.number;
    } else if (eventName === "issue_comment") {
      const commentBody: string = payload.comment?.body || "";

      if (!payload.issue?.pull_request) {
        core.info("Issue comment is not on a pull request. Skipping.");
        return;
      }

      if (payload.comment?.user?.type === "Bot") {
        core.info("Ignoring bot comment.");
        return;
      }

      const parsedCommand = parseSlashCommand(commentBody);
      if (!parsedCommand) {
        core.info("No supported slash command found. Skipping.");
        return;
      }

      const commentAuthor = payload.comment?.user?.login;
      const authorized = await isAuthorizedCommenter(
        octokit,
        owner,
        repo,
        commentAuthor,
        minCommandPermission
      );

      if (!authorized) {
        core.warning(
          `Ignoring /${parsedCommand} from ${commentAuthor || "unknown user"}; minimum permission is ${minCommandPermission}.`
        );
        return;
      }

      await addEyesReaction(octokit, owner, repo, payload.comment?.id);

      command = parsedCommand;
      prNumber = payload.issue.number;

      if (command === "help") {
        await postHelpComment(octokit, payload);
        return;
      }

      shouldRun = true;
    }

    if (!shouldRun || !prNumber) {
      core.info("No matching trigger found. Skipping.");
      return;
    }

    const apiKey = core.getInput("llm-api-key") || core.getInput("api-key") || "ollama";
    const baseUrl = core.getInput("llm-base-url") || core.getInput("base-url") || "";
    const model = core.getInput("model") || "";
    const failOnHigh = core.getInput("fail-on-high") === "true" || core.getInput("fail-on-critical") === "true";
    const maxDiffSizeInput = core.getInput("max-diff-size") || "50000";
    const maxCommentsInput = core.getInput("max-comments") || "25";
    const maxOutputTokensInput = core.getInput("max-output-tokens") || "";
    const maxOutputTokens = maxOutputTokensInput ? parseInt(maxOutputTokensInput, 10) : undefined;
    const llmTimeoutMsInput = core.getInput("llm-timeout-ms") || "";
    const { value: llmTimeoutMs, valid: llmTimeoutValid } = parseLLMTimeout(llmTimeoutMsInput);
    if (!llmTimeoutValid) {
      core.warning(`Invalid llm-timeout-ms value "${llmTimeoutMsInput}", using default ${DEFAULT_LLM_TIMEOUT_MS}`);
    }
    const inlineReviewInstructions = core.getInput("review-instructions") || "";
    const reviewInstructionsFile = core.getInput("review-instructions-file") || "";
    const configFile = core.getInput("config-file") || DEFAULT_CONFIG_FILE;
    const jsonResponseModeInput = core.getInput("use-json-response-mode") || "";

    core.info(`Model: ${model || "(not configured)"}`);

    core.info(`Running /${command} on PR #${prNumber} in ${owner}/${repo}`);
    statusCommand = command === "summary" ? "summary" : "review";
    statusCommentId = await postStatusComment(octokit, owner, repo, prNumber, command, model || "not configured");

    if (!baseUrl) {
      throw new Error("Input required and not supplied: llm-base-url");
    }
    if (!model) {
      throw new Error("Input required and not supplied: model");
    }

    const gitUtils = new GitUtils(octokit as any);
    const baseRef = payload.pull_request?.base?.sha;
    const repoConfig = await loadRepoConfig(
      octokit,
      gitUtils,
      owner,
      repo,
      prNumber,
      configFile,
      baseRef
    );
    const maxDiffSize = resolveMaxDiffSize(maxDiffSizeInput, repoConfig);
    const maxComments = resolveMaxComments(maxCommentsInput, repoConfig);
    const jsonResponseMode = resolveJsonResponseMode(jsonResponseModeInput, repoConfig);

    const diff = await gitUtils.getPullRequestDiff(owner, repo, prNumber);
    
    if (!diff || diff.trim().length === 0) {
      core.warning("No diff found for this PR.");
      return;
    }

    const diffFiles = splitDiffIntoFiles(diff);
    const { filtered: filteredDiff, removedFiles } = filterDiff(diff, repoConfig.skipPaths || []);
    if (removedFiles.length > 0) {
      core.info(`Skipped ${removedFiles.length} file(s) before review: ${removedFiles.join(", ")}`);
    }

    if (diffFiles.length > 0 && !filteredDiff.trim()) {
      core.info("All changed files were skipped by diff filters; no LLM review needed.");
      await updateStatusComment(
        octokit,
        owner,
        repo,
        statusCommentId,
        buildSkippedFilterStatusBody(removedFiles)
      );
      return;
    }

    const reviewDiff = filteredDiff.trim() ? filteredDiff : diff;
    if (!reviewDiff.trim()) {
      core.warning("No reviewable diff remained after filtering skipped paths.");
      return;
    }

    const truncatedDiff = reviewDiff.length > maxDiffSize 
      ? reviewDiff.slice(0, maxDiffSize) + "\n\n[... Diff truncated due to size limit]"
      : reviewDiff;

    core.info(
      `Diff size: ${reviewDiff.length} chars${reviewDiff.length > maxDiffSize ? " (truncated)" : ""}${removedFiles.length > 0 ? ` (${removedFiles.length} file(s) filtered)` : ""}`
    );
    const reviewInstructions = command === "review"
      ? await loadReviewInstructions(
        octokit,
        gitUtils,
        owner,
        repo,
        prNumber,
        inlineReviewInstructions,
        reviewInstructionsFile,
        baseRef
      )
      : "";

    const llm = new LLMClient(baseUrl, apiKey, model, maxOutputTokens, llmTimeoutMs);
    const useJsonMode = command === "review" && jsonResponseMode;
    
    let reviewText: string;
    if (command === "summary") {
      reviewText = (await runSummary(llm, truncatedDiff)).content;
    } else {
      reviewText = (await runReview(llm, truncatedDiff, reviewInstructions, useJsonMode)).content;
    }

    if (command === "summary") {
      // Post summary as a regular comment
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: ["## :bow_and_arrow: Robin · Summary", "", reviewText].join("\n"),
      });
      await updateStatusComment(octokit, owner, repo, statusCommentId, buildCompletedStatusBody("summary"));
    } else {
      // Full review parsed and posted as a review
      core.info("Parsing review response...");
      let parsedReview = ReviewParser.parseDetailed(reviewText);
      let findings = parsedReview.findings;

      if (shouldRetryStructuredReview(findings, parsedReview.usedJson)) {
        core.warning("Structured review parse was empty; retrying once with JSON-only instructions.");
        const retryText = (
          await runReview(
            llm,
            truncatedDiff,
            `${reviewInstructions}\n\nReturn ONLY a single valid JSON object. Do not use markdown.`,
            true
          )
        ).content;
        parsedReview = ReviewParser.parseDetailed(retryText);
        findings = parsedReview.findings;
      }

      core.info(`Found ${findings.high.length} high, ${findings.medium.length} medium, ${findings.low.length} low, ${findings.suggestions.length} suggestions`);

      const reviewer = new GitHubReviewer(octokit as any, maxComments);
      await reviewer.postReview(owner, repo, prNumber, findings);
      await updateStatusComment(octokit, owner, repo, statusCommentId, buildCompletedStatusBody("review", findings));

      if (findings.high.length > 0 && failOnHigh) {
        core.setFailed(`Found ${findings.high.length} high severity issue(s). Failing check.`);
      }
    }

    core.info("Done.");

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (octokit && statusOwner && statusRepo && statusCommentId) {
      await updateStatusComment(octokit, statusOwner, statusRepo, statusCommentId, buildFailedStatusBody(message, statusCommand));
    }
    core.setFailed(message);
  }
}

async function addEyesReaction(
  octokit: any,
  owner: string,
  repo: string,
  commentId: number | undefined
): Promise<void> {
  if (!commentId) return;

  try {
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: "eyes",
    });
  } catch (error) {
    core.warning(`Could not add eyes reaction to trigger comment: ${error}`);
  }
}

async function postStatusComment(
  octokit: any,
  owner: string,
  repo: string,
  issueNumber: number,
  command: ReviewerCommand,
  model: string
): Promise<number | undefined> {
  try {
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: [
        "## :bow_and_arrow: Robin",
        "",
        ":eyes: On it — taking a look at this pull request.",
        "",
        `Mode: ${command === "summary" ? "summary" : "code review"}`,
        `Model: ${model}`,
      ].join("\n"),
    });
    return data.id;
  } catch (error) {
    core.warning(`Could not post status comment: ${error}`);
    return undefined;
  }
}

async function updateStatusComment(
  octokit: any,
  owner: string,
  repo: string,
  commentId: number | undefined,
  body: string
): Promise<void> {
  if (!commentId) return;

  try {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
  } catch (error) {
    core.warning(`Could not update status comment: ${error}`);
  }
}

function buildCompletedStatusBody(command: "review" | "summary", findings?: StructuredReview): string {
  if (command === "summary") {
    return [
      "## :bow_and_arrow: Robin",
      "",
      ":white_check_mark: Summary's ready above.",
      "",
      "Want the full review? Comment `/robin`.",
    ].join("\n");
  }

  const totalFindings = findings
    ? findings.high.length + findings.medium.length + findings.low.length + findings.suggestions.length
    : 0;
  const result = totalFindings === 0
    ? "Nothing worth flagging — looks clean to me."
    : `I flagged ${totalFindings} thing${totalFindings === 1 ? "" : "s"} worth a look.`;

  return [
    "## :bow_and_arrow: Robin",
    "",
    `:white_check_mark: Review done. ${result}`,
    "",
    "Push fixes whenever you like, then comment `/robin` for another pass.",
  ].join("\n");
}

function buildSkippedFilterStatusBody(removedFiles: string[]): string {
  const preview = removedFiles.slice(0, 8).join(", ");
  const suffix = removedFiles.length > 8 ? `, and ${removedFiles.length - 8} more` : "";

  return [
    "## :bow_and_arrow: Robin",
    "",
    ":white_check_mark: Nothing to review here — only ignored paths changed.",
    "",
    `Skipped: ${preview}${suffix}`,
    "",
    "Add `skip-paths` in `.github/robin.yml` if that's not what you expected.",
  ].join("\n");
}

function buildFailedStatusBody(errorMessage: string, command: "review" | "summary"): string {
  return [
    "## :bow_and_arrow: Robin",
    "",
    `:warning: I couldn't finish the ${command === "summary" ? "summary" : "review"} this time.`,
    "",
    `Reason: ${errorMessage}`,
    "",
    "Free model routes drop sometimes — comment `/robin` to try again. (No secrets are included in this message.)",
  ].join("\n");
}

async function loadRepoConfig(
  octokit: any,
  gitUtils: GitUtils,
  owner: string,
  repo: string,
  prNumber: number,
  configFile: string,
  baseRef?: string
): Promise<RepoConfig> {
  const filePath = configFile.trim();
  if (!filePath) return {};

  try {
    let ref = baseRef;
    if (!ref) {
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      ref = pullRequest.base.sha;
    }

    if (!ref) return {};

    const fileContent = await gitUtils.getFileContent(owner, repo, filePath, ref);
    if (!fileContent.trim()) return {};

    core.info(`Loaded repo config from ${filePath}`);
    return parseRepoConfigYaml(fileContent);
  } catch (error) {
    core.info(`No repo config at ${filePath} (${error})`);
    return {};
  }
}

async function loadReviewInstructions(
  octokit: any,
  gitUtils: GitUtils,
  owner: string,
  repo: string,
  prNumber: number,
  inlineInstructions: string,
  instructionsFile: string,
  baseRef?: string
): Promise<string> {
  const instructions = inlineInstructions.trim() ? [inlineInstructions.trim()] : [];
  const filePath = instructionsFile.trim();

  if (!filePath) {
    return instructions.join("\n\n");
  }

  try {
    let ref: string;
    if (baseRef) {
      ref = baseRef;
    } else {
      const { data: pullRequest } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      ref = pullRequest.base.sha;
    }

    const fileInstructions = await gitUtils.getFileContent(owner, repo, filePath, ref);
    if (fileInstructions.trim()) {
      core.info(`Loaded reviewer instructions from ${filePath}`);
      instructions.push(`Instructions from ${filePath}:\n${fileInstructions.trim()}`);
    }
  } catch (error) {
    core.warning(`Could not load review instructions from ${filePath}: ${error}`);
  }

  return instructions.join("\n\n");
}

async function isAuthorizedCommenter(
  octokit: any,
  owner: string,
  repo: string,
  username: string | undefined,
  minCommandPermission: string
): Promise<boolean> {
  if (!username) return false;

  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });

    return hasRequiredPermission(data.permission, minCommandPermission);
  } catch (error) {
    core.warning(`Could not verify permissions for ${username}: ${error}`);
    return false;
  }
}

async function postHelpComment(octokit: any, payload: any): Promise<void> {
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const issueNumber = payload.issue?.number;

  if (!issueNumber) return;

  const helpBody = getHelpMessage();
  
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: helpBody,
  });

  core.info("Posted help comment.");
}

async function runReview(
  llm: LLMClient,
  diff: string,
  reviewInstructions: string,
  jsonResponseMode: boolean
) {
  const systemPrompt = getReviewPrompt(reviewInstructions);
  const userContent = buildReviewInput(diff);
  core.info("Getting full code review...");
  return await llm.chatCompletion(systemPrompt, userContent, jsonResponseMode);
}

async function runSummary(llm: LLMClient, diff: string) {
  const systemPrompt = getSummaryPrompt();
  const userContent = buildSummaryInput(diff);
  core.info("Getting PR summary...");
  return await llm.chatCompletion(systemPrompt, userContent, false);
}

function buildReviewInput(diff: string): string {
  const annotated = annotateDiffWithLineNumbers(diff);
  return [
    "Review the following code diff and return only the strict JSON object described in the system prompt.",
    "Each line is prefixed with its line number in the NEW file (blank for removed lines and headers).",
    "For any line-specific finding, copy that exact number into the `line` field. Do not guess or recount.",
    "---",
    "CODE DIFF:",
    "```diff",
    annotated,
    "```",
  ].join("\n");
}

function buildSummaryInput(diff: string): string {
  return [
    "Summarize the following pull request diff. Provide:",
    "1. High-level overview of what changed",
    "2. Key files affected",
    "3. Any notable patterns or patterns that could be improved",
    "Be concise but informative.",
    "---",
    "CODE DIFF:",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

run();
