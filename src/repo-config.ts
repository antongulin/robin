export const DEFAULT_CONFIG_FILE = ".github/robin.yml";
export const DEFAULT_ACTION_MAX_DIFF_SIZE = 50000;
/** Single default shared by action.yml and the reusable review.yml workflow. */
export const DEFAULT_MAX_COMMENTS = 15;

export interface RepoConfig {
  maxDiffSize?: number;
  maxComments?: number;
  skipPaths?: string[];
  jsonResponseMode?: boolean;
}

export function parseRepoConfigYaml(text: string): RepoConfig {
  const config: RepoConfig = {};
  let inSkipPaths = false;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

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

export function resolveMaxDiffSize(actionInput: string, repoConfig?: RepoConfig): number {
  const parsed = parseInt(actionInput, 10);
  if (
    repoConfig?.maxDiffSize !== undefined &&
    Number.isFinite(parsed) &&
    parsed === DEFAULT_ACTION_MAX_DIFF_SIZE &&
    repoConfig.maxDiffSize !== DEFAULT_ACTION_MAX_DIFF_SIZE
  ) {
    return repoConfig.maxDiffSize;
  }
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ACTION_MAX_DIFF_SIZE;
}

export function resolveMaxComments(actionInput: string, repoConfig?: RepoConfig): number {
  const parsed = parseInt(actionInput, 10);
  const isUnset = Number.isFinite(parsed) && parsed === DEFAULT_MAX_COMMENTS;
  if (repoConfig?.maxComments !== undefined && isUnset) {
    return repoConfig.maxComments;
  }
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_COMMENTS;
}

export function resolveJsonResponseMode(actionInput: string, repoConfig?: RepoConfig): boolean {
  if (actionInput === "true") return true;
  if (actionInput === "false") return false;
  return repoConfig?.jsonResponseMode ?? true;
}
