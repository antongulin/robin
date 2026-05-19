"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shouldRetryStructuredReview = shouldRetryStructuredReview;
function shouldRetryStructuredReview(findings) {
    return (findings.high.length +
        findings.medium.length +
        findings.low.length +
        findings.suggestions.length ===
        0);
}
//# sourceMappingURL=review-retry.js.map