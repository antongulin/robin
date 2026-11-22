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

/** True only for the official OpenCode Go API endpoint after normalizing pasted suffixes. */
export function isOpenCodeGoEndpoint(baseUrl: string): boolean {
  const url = parseUrl(normalizeLlmBaseUrl(baseUrl));
  return Boolean(
    url &&
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "opencode.ai" &&
      !url.port &&
      url.pathname === "/zen/go/v1",
  );
}

/** True only for the official Mistral API host. */
export function isMistralEndpoint(baseUrl: string): boolean {
  const url = parseUrl(normalizeLlmBaseUrl(baseUrl));
  return Boolean(url && url.protocol === "https:" && url.hostname.toLowerCase() === "api.mistral.ai" && !url.port);
}

/** Adapt Mistral's validation errors to the SDK's error envelope. */
export function normalizeMistralErrorBody(status: number | undefined, body: unknown): unknown {
  if ((status !== 400 && status !== 422) || !body || typeof body !== "object" ||
      (Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null) ||
      Object.prototype.hasOwnProperty.call(body, "error")) return body;
  const value = body as Record<string, unknown>;
  if (value.object !== "error") return body;
  let message: string | undefined;
  let fieldParam: string | undefined;
  if (typeof value.message === "string" && value.message.trim()) {
    message = value.message;
  } else if (value.message && typeof value.message === "object" && !Array.isArray(value.message)) {
    const detail = (value.message as Record<string, unknown>).detail;
    if (Array.isArray(detail)) {
      const entries: { text: string; param?: string }[] = [];
      for (const item of detail) {
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.msg !== "string") continue;
        const loc: unknown = item.loc;
        const validLoc = Array.isArray(loc) && loc.every(part => typeof part === "string" || typeof part === "number");
        const parts = validLoc ? [...loc] : [];
        if (parts[0] === "body") parts.shift();
        const field = parts.join(".");
        entries.push({ text: field ? `${field}: ${item.msg}` : item.msg,
          param: validLoc && loc.length === 2 && loc[0] === "body" && typeof loc[1] === "string" ? loc[1] : undefined });
      }
      if (entries.length) {
        message = entries.map(entry => entry.text).join("; ");
        if (entries.length === 1) fieldParam = entries[0].param;
      }
    }
  }
  if (!message?.trim()) return body;
  return { error: { message, type: typeof value.type === "string" ? value.type : undefined,
    code: typeof value.code === "string" || (typeof value.code === "number" && Number.isFinite(value.code)) ? value.code : undefined,
    param: fieldParam ?? (typeof value.param === "string" ? value.param : undefined) } };
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
