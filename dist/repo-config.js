"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REUSABLE_WORKFLOW_MAX_COMMENTS = exports.DEFAULT_ACTION_MAX_COMMENTS = exports.DEFAULT_ACTION_MAX_DIFF_SIZE = exports.DEFAULT_CONFIG_FILE = void 0;
exports.parseRepoConfigYaml = parseRepoConfigYaml;
exports.resolveMaxDiffSize = resolveMaxDiffSize;
exports.resolveMaxComments = resolveMaxComments;
exports.resolveJsonResponseMode = resolveJsonResponseMode;
exports.DEFAULT_CONFIG_FILE = ".github/universal-code-reviewer.yml";
exports.DEFAULT_ACTION_MAX_DIFF_SIZE = 50000;
exports.DEFAULT_ACTION_MAX_COMMENTS = 25;
/** Reusable workflow default in `.github/workflows/review.yml` */
exports.REUSABLE_WORKFLOW_MAX_COMMENTS = 10;
function parseRepoConfigYaml(text) {
    const config = {};
    let inSkipPaths = false;
    for (const rawLine of text.split("\n")) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        if (trimmed === "skip-paths:") {
            inSkipPaths = true;
            continue;
        }
        if (inSkipPaths) {
            if (trimmed.startsWith("- ")) {
                const value = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, "");
                if (value) {
                    config.skipPaths = config.skipPaths || [];
                    config.skipPaths.push(value);
                }
                continue;
            }
            inSkipPaths = false;
        }
        const maxDiffMatch = trimmed.match(/^max-diff-size:\s*(\d+)\s*$/i);
        if (maxDiffMatch) {
            config.maxDiffSize = parseInt(maxDiffMatch[1], 10);
            continue;
        }
        const maxCommentsMatch = trimmed.match(/^max-comments:\s*(\d+)\s*$/i);
        if (maxCommentsMatch) {
            config.maxComments = parseInt(maxCommentsMatch[1], 10);
            continue;
        }
        const jsonModeMatch = trimmed.match(/^json-response-mode:\s*(true|false)\s*$/i);
        if (jsonModeMatch) {
            config.jsonResponseMode = jsonModeMatch[1].toLowerCase() === "true";
        }
    }
    return config;
}
function resolveMaxDiffSize(actionInput, repoConfig) {
    const parsed = parseInt(actionInput, 10);
    if (repoConfig?.maxDiffSize !== undefined &&
        Number.isFinite(parsed) &&
        parsed === exports.DEFAULT_ACTION_MAX_DIFF_SIZE &&
        repoConfig.maxDiffSize !== exports.DEFAULT_ACTION_MAX_DIFF_SIZE) {
        return repoConfig.maxDiffSize;
    }
    return Number.isFinite(parsed) && parsed > 0 ? parsed : exports.DEFAULT_ACTION_MAX_DIFF_SIZE;
}
function resolveMaxComments(actionInput, repoConfig) {
    const parsed = parseInt(actionInput, 10);
    const isUnsetOrWorkflowDefault = Number.isFinite(parsed) &&
        (parsed === exports.DEFAULT_ACTION_MAX_COMMENTS || parsed === exports.REUSABLE_WORKFLOW_MAX_COMMENTS);
    if (repoConfig?.maxComments !== undefined && isUnsetOrWorkflowDefault) {
        return repoConfig.maxComments;
    }
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : exports.DEFAULT_ACTION_MAX_COMMENTS;
}
function resolveJsonResponseMode(actionInput, repoConfig) {
    if (actionInput === "true")
        return true;
    if (actionInput === "false")
        return false;
    return repoConfig?.jsonResponseMode ?? true;
}
//# sourceMappingURL=repo-config.js.map