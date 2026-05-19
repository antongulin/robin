"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldRetryStructuredReview = shouldRetryStructuredReview;
const RETRY_SUMMARY_MAX_LENGTH = 40;
function shouldRetryStructuredReview(findings, usedJson) {
    const findingCount = findings.high.length +
        findings.medium.length +
        findings.low.length +
        findings.suggestions.length;
    if (findingCount > 0)
        return false;
    if (usedJson)
        return false;
    return findings.summary.trim().length <= RETRY_SUMMARY_MAX_LENGTH;
}
//# sourceMappingURL=review-retry.js.map