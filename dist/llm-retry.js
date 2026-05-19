"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRetriableLlmError = isRetriableLlmError;
exports.shouldUseJsonResponseMode = shouldUseJsonResponseMode;
exports.computeRetryDelayMs = computeRetryDelayMs;
exports.getLlmCompletionAttemptCount = getLlmCompletionAttemptCount;
exports.delayMs = delayMs;
const config_1 = require("./config");
function isRetriableLlmError(error) {
    if (!error)
        return false;
    if (typeof error === "object" && error !== null && "status" in error) {
        const status = Number(error.status);
        if (status === 429 || (Number.isFinite(status) && status >= 500)) {
            return true;
        }
        if (Number.isFinite(status) && status >= 400 && status < 500) {
            return false;
        }
    }
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    return (message.includes("timeout") ||
        message.includes("timed out") ||
        message.includes("econnreset") ||
        message.includes("econnrefused") ||
        message.includes("network") ||
        message.includes("socket hang up") ||
        message.includes("rate limit") ||
        message.includes("overloaded") ||
        message.includes("empty response from llm"));
}
function shouldUseJsonResponseMode(attempt, jsonResponseMode) {
    return jsonResponseMode && attempt === 1;
}
function computeRetryDelayMs(attempt, baseDelayMs = config_1.DEFAULT_LLM_RETRY_DELAY_MS) {
    return baseDelayMs * attempt;
}
function getLlmCompletionAttemptCount(maxAttempts = config_1.DEFAULT_LLM_COMPLETION_ATTEMPTS) {
    return Math.max(1, Math.floor(maxAttempts));
}
async function delayMs(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=llm-retry.js.map