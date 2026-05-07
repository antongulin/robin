import { Octokit } from "@octokit/rest";
import { StructuredReview } from "./review-parser";
export declare class GitHubReviewer {
    private octokit;
    private maxComments;
    constructor(octokit: Octokit, maxComments?: number);
    postReview(owner: string, repo: string, pullNumber: number, findings: StructuredReview): Promise<void>;
    /**
     * Build separate line-level comments for each finding that can be mapped to a line.
     * Each comment appears as an individual thread the repo owner can reply to and resolve.
     */
    private buildReviewComments;
    private formatCommentBody;
    private shouldRetryWithoutInlineComments;
    /**
     * Build a concise summary body. Findings are shown here ONLY if they
     * could not be mapped to individual line comments.
     */
    private buildReviewBody;
    private formatUnpostedFinding;
    /**
     * Check whether a new-file line number is present in the diff.
     * GitHub only accepts review comments on lines included in the PR diff.
     */
    private isLineInNewDiff;
}
//# sourceMappingURL=github-reviewer.d.ts.map