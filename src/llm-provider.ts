/**
 * Provider detection from the configured base URL. Everything speaks the OpenAI
 * chat-completions wire format, but a few hosts need small request-shape tweaks.
 */
export type LlmProvider = "openai" | "anthropic" | "openrouter" | "other";

const OPENAI_CHAT_SUFFIX = /\/chat\/completions\/?$/i;
const ANTHROPIC_MESSAGES_SUFFIX = /\/messages\/?$/i;

function parseUrl(baseUrl: string): URL | undefined {
  try {
    return new URL(baseUrl);
  } catch {
    return undefined;
  }
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function detectLlmProvider(baseUrl: string): LlmProvider {
  const url = parseUrl(baseUrl.trim());
  if (!url) return "other";
  const host = url.hostname.toLowerCase();
  if (hostMatches(host, "anthropic.com")) return "anthropic";
  if (hostMatches(host, "openai.com")) return "openai";
  if (hostMatches(host, "openrouter.ai")) return "openrouter";
  return "other";
}

/**
 * Accept the URLs people actually paste — with or without `/v1`, with a trailing
 * slash, or the full endpoint path — and return the SDK base URL.
 *
 * Only the well-known hosted providers get `/v1` appended; self-hosted and proxy
 * URLs are passed through untouched apart from endpoint-suffix stripping, because
 * their paths are arbitrary (`/openai/v1`, `/api/v1`, …).
 */
export function normalizeLlmBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const url = parseUrl(trimmed);
  if (!url) return trimmed;

  let path = url.pathname.replace(OPENAI_CHAT_SUFFIX, "");
  const provider = detectLlmProvider(trimmed);
  if (provider === "anthropic") {
    path = path.replace(ANTHROPIC_MESSAGES_SUFFIX, "");
  }
  path = path.replace(/\/+$/, "");

  if ((provider === "anthropic" || provider === "openai") && !/\/v\d+$/i.test(path)) {
    path = `${path}/v1`;
  }

  url.pathname = path || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * OpenAI reasoning families (o-series, GPT-5, codex) reject sampling controls such as
 * `temperature` and only accept `max_completion_tokens`. Detect them up front so the
 * first request already has the right shape; unknown models still recover through the
 * reactive parameter fallback.
 */
export function isOpenAIReasoningModel(model: string | undefined): boolean {
  if (!model) return false;
  const normalized = model.trim().toLowerCase().replace(/^openai\//, "");
  return (
    /^o[1-9](?:[-.]|$)/.test(normalized) ||
    /^gpt-5(?:[-.]|$)/.test(normalized) ||
    /^codex(?:[-.]|$)/.test(normalized)
  );
}
