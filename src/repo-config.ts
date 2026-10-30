export const DEFAULT_CONFIG_FILE = ".github/robin.yml";
export const DEFAULT_ACTION_MAX_DIFF_SIZE = 50000;
/** Single default shared by action.yml and the reusable review.yml workflow. */
export const DEFAULT_MAX_COMMENTS = 15;

export interface RepoConfig {
  maxDiffSize?: number;
  maxComments?: number;
  skipPaths?: string[];
  jsonResponseMode?: boolean;
  requestChanges?: boolean;
  reasoningEffort?: string;
  agentMode?: AgentMode;
  agentMaxTurns?: number;
  agentMaxDiffSize?: number;
  /** Preserve invalid values so automatic bot reviews fail closed with a diagnostic. */
  botReviewPolicy?: string;
  /** null means a malformed YAML sequence; omitted means an empty allowlist. */
  botAllowlist?: string[] | null;
}

export type AgentMode = "auto" | "off";
/** Single-shot diff review unless the caller explicitly opts into the multi-turn agent review. */
export const DEFAULT_AGENT_MODE: AgentMode = "off";
export const DEFAULT_AGENT_MAX_TURNS = 40;
const MAX_AGENT_MAX_TURNS = 100;
/** Diff characters sent up front in agent mode (~50-65k tokens); a larger filtered diff fails before the agent request. The single-shot fallback keeps max-diff-size. */
export const DEFAULT_AGENT_MAX_DIFF_SIZE = 200_000;

/** Strips a trailing ` # comment` only outside quotes, so quoted values keep `#` intact. */
function stripTrailingComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && index > 0 && /\s/.test(line[index - 1])) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line;
}

export function parseRepoConfigYaml(text: string): RepoConfig {
  const config: RepoConfig = {};
  let inSkipPaths = false;
  let inBotAllowlist = false;
  let botAllowlistIsInline = false;

  for (const rawLine of text.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const setting = stripTrailingComment(trimmed);

    if (inBotAllowlist) {
      if (setting.startsWith("-") || /^\s/.test(rawLine)) {
        const item = setting.match(/^-\s+(.+)$/)?.[1];
        const login = item === undefined ? undefined : parseBotLogin(item);
        if (login && !botAllowlistIsInline && config.botAllowlist) config.botAllowlist.push(login);
        else config.botAllowlist = null;
        continue;
      }
      inBotAllowlist = false;
    }

    const botPolicyMatch = setting.match(/^bot-review-policy:\s*(.*)$/i);
    if (botPolicyMatch) {
      config.botReviewPolicy = unquoteBotValue(botPolicyMatch[1]);
      inSkipPaths = false;
      continue;
    }
    const botListMatch = setting.match(/^bot-allowlist:\s*(.*)$/i);
    if (botListMatch) {
      const value = botListMatch[1];
      config.botAllowlist = value === "" || value === "[]" ? [] : null;
      inBotAllowlist = true;
      botAllowlistIsInline = value !== "";
      inSkipPaths = false;
      continue;
    }

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

    // Scalar settings tolerate the inline comments the shipped examples use
    // (`reasoning-effort: high   # provider note`); a `#` inside a quoted value is kept.
    const maxDiffMatch = setting.match(/^max-diff-size:\s*(\d+)\s*$/i);
    if (maxDiffMatch) {
      config.maxDiffSize = parseInt(maxDiffMatch[1], 10);
      continue;
    }

    const maxCommentsMatch = setting.match(/^max-comments:\s*(\d+)\s*$/i);
    if (maxCommentsMatch) {
      config.maxComments = parseInt(maxCommentsMatch[1], 10);
      continue;
    }

    const jsonModeMatch = setting.match(/^json-response-mode:\s*(true|false)\s*$/i);
    if (jsonModeMatch) {
      config.jsonResponseMode = jsonModeMatch[1].toLowerCase() === "true";
      continue;
    }

    const requestChangesMatch = setting.match(/^request-changes:\s*(true|false)\s*$/i);
    if (requestChangesMatch) {
      config.requestChanges = requestChangesMatch[1].toLowerCase() === "true";
      continue;
    }

    const agentModeMatch = setting.match(/^agent-mode:\s*['"]?(auto|off)['"]?\s*$/i);
    if (agentModeMatch) {
      config.agentMode = agentModeMatch[1].toLowerCase() as AgentMode;
      continue;
    }

    const agentMaxTurnsMatch = setting.match(/^agent-max-turns:\s*(\d+)\s*$/i);
    if (agentMaxTurnsMatch) {
      config.agentMaxTurns = parseInt(agentMaxTurnsMatch[1], 10);
      continue;
    }

    const agentMaxDiffMatch = setting.match(/^agent-max-diff-size:\s*(\d+)\s*$/i);
    if (agentMaxDiffMatch) {
      config.agentMaxDiffSize = parseInt(agentMaxDiffMatch[1], 10);
      continue;
    }

    const reasoningEffortMatch = setting.match(
      /^reasoning-effort:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(.+))\s*$/i
    );
    if (reasoningEffortMatch) {
      const quotedValue = reasoningEffortMatch[1] ?? reasoningEffortMatch[2];
      const value = (
        quotedValue !== undefined
          ? quotedValue.replace(/\\(.)/g, "$1")
          : reasoningEffortMatch[3] ?? ""
      ).trim();
      if (value) {
        config.reasoningEffort = value;
      }
      continue;
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

export type BotReviewPolicy = "all" | "none" | "allowlist";

export interface BotReviewSettings {
  policy: BotReviewPolicy;
  allowlist: string[];
  errors: string[];
}

function unquoteBotValue(value: string): string {
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

function isBotLogin(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\[bot\])?$/i.test(value);
}

function parseBotLogin(value: string): string | undefined {
  // YAML numbers/booleans/null are not string logins. Quoting keeps numeric names valid.
  if (/^(?:true|false|null|~|[-+]?\d+)$/i.test(value)) return undefined;
  const login = unquoteBotValue(value);
  return isBotLogin(login) ? login : undefined;
}

/** Nonblank inputs override the same base-config setting; [] explicitly clears the list. */
export function resolveBotReviewSettings(
  policyInput: string,
  allowlistInput: string,
  repoConfig?: RepoConfig
): BotReviewSettings {
  const value = policyInput.trim() || repoConfig?.botReviewPolicy;
  const policy = value === undefined ? "all" : value;
  const errors: string[] = [];
  const validPolicy = policy === "all" || policy === "none" || policy === "allowlist";
  if (!validPolicy) errors.push("Invalid bot-review-policy; expected all, none, or allowlist. Automatic bot reviews are skipped.");

  const input = allowlistInput.trim();
  const allowlist = input
    ? input === "[]" ? [] : input.split(",").map(login => login.trim())
    : repoConfig?.botAllowlist === undefined ? [] : repoConfig.botAllowlist;
  if (allowlist === null || !allowlist.every(isBotLogin)) {
    errors.push("Invalid bot-allowlist; use comma-separated logins in the input or a YAML sequence of string logins in repo config. Automatic bot reviews are skipped.");
  }
  return { policy: validPolicy ? policy : "none", allowlist: allowlist ?? [], errors };
}

/** Filter only authors GitHub identifies as Bots; ordinary automated User accounts pass. */
export function shouldReviewAuthor(
  author: { type?: string; login?: string } | null | undefined,
  settings: BotReviewSettings
): boolean {
  if (author?.type !== "Bot") return true;
  if (settings.errors.length > 0) return false;
  if (settings.policy === "all") return true;
  return settings.policy === "allowlist" && settings.allowlist.some(
    login => login.toLowerCase() === author.login?.toLowerCase()
  );
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

/** Whether a High finding submits a blocking REQUEST_CHANGES review. Default true (gatekeeper). */
export function resolveRequestChanges(actionInput: string, repoConfig?: RepoConfig): boolean {
  if (actionInput === "true") return true;
  if (actionInput === "false") return false;
  return repoConfig?.requestChanges ?? true;
}

/** Multi-turn tool review: explicit input first, then `.github/robin.yml`, else single-shot (`off`). */
export function resolveAgentMode(actionInput: string, repoConfig?: RepoConfig): AgentMode {
  const input = actionInput.trim().toLowerCase();
  if (input === "auto" || input === "off") return input;
  return repoConfig?.agentMode ?? DEFAULT_AGENT_MODE;
}

export function resolveAgentMaxTurns(actionInput: string, repoConfig?: RepoConfig): number {
  const parsed = parseInt(actionInput, 10);
  const value =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : repoConfig?.agentMaxTurns && repoConfig.agentMaxTurns > 0
        ? repoConfig.agentMaxTurns
        : DEFAULT_AGENT_MAX_TURNS;
  return Math.min(value, MAX_AGENT_MAX_TURNS);
}

export function resolveAgentMaxDiffSize(actionInput: string, repoConfig?: RepoConfig): number {
  const parsed = parseInt(actionInput, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (repoConfig?.agentMaxDiffSize && repoConfig.agentMaxDiffSize > 0) return repoConfig.agentMaxDiffSize;
  return DEFAULT_AGENT_MAX_DIFF_SIZE;
}

/**
 * Sentinel value that sends no reasoning configuration at all.
 *
 * There is deliberately no applied default: when neither the action input nor
 * `.github/robin.yml` sets `reasoning-effort`, Robin sends no reasoning control and
 * lets the provider/model choose. An explicit value (including `high`) is still sent.
 */
export const REASONING_EFFORT_OFF = "off";

/**
 * Reasoning effort is provider configuration: explicit input first, then `.github/robin.yml`,
 * else unset so the provider default applies. `off` (any case) also disables reasoning
 * configuration entirely.
 */
export function resolveReasoningEffort(
  actionInput: string,
  repoConfig?: RepoConfig
): string | undefined {
  const configured = configuredReasoningEffort(actionInput, repoConfig);
  if (configured === undefined) return undefined;
  return configured.toLowerCase() === REASONING_EFFORT_OFF ? undefined : configured;
}

/** True when the user set `reasoning-effort` themselves (input or repo config), not the default. */
export function isReasoningEffortConfigured(actionInput: string, repoConfig?: RepoConfig): boolean {
  return configuredReasoningEffort(actionInput, repoConfig) !== undefined;
}

function configuredReasoningEffort(actionInput: string, repoConfig?: RepoConfig): string | undefined {
  const trimmed = actionInput.trim();
  if (trimmed) return trimmed;
  const fromRepo = repoConfig?.reasoningEffort?.trim();
  return fromRepo || undefined;
}
