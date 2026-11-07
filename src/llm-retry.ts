import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_RATE_LIMIT_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_RATE_LIMIT_RETRY_DELAYS_MS,
  DEFAULT_LLM_RETRY_DELAY_MS,
  DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_RETRY_DELAY_MS,
  DEFAULT_LLM_ROUTER_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  MAX_LLM_RATE_LIMIT_RETRY_DELAY_MS,
  MIN_LLM_RATE_LIMIT_RETRY_DELAY_MS,
} from "./config";

export interface LlmRetryContext {
  model?: string;
}

/** OpenRouter routers (e.g. openrouter/free) pick models dynamically — no secret updates needed. */
export function resolveLlmTimeoutMs(model: string | undefined, timeoutMs: number): number {
  if (timeoutMs !== DEFAULT_LLM_TIMEOUT_MS) return timeoutMs;
  return isOpenRouterRouterModel(model) ? DEFAULT_LLM_ROUTER_TIMEOUT_MS : timeoutMs;
}

export function isOpenRouterRouterModel(model: string | undefined): boolean {
  if (!model) return false;
  const normalized = model.trim().toLowerCase();
  return (
    normalized === "openrouter/free" ||
    normalized === "openrouter/auto" ||
    normalized.startsWith("openrouter/") && normalized.endsWith("/free")
  );
}

export function isOpenRouterProviderError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("provider returned error");
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

/**
 * Explicit parameter rejections that name the extra parameter. These win over the value
 * bail-outs so an explicit rejection is not masked by an incidental value word later in
 * the message (for example a provider that echoes the configured value while rejecting
 * the parameter itself).
 */
const EXPLICIT_UNSUPPORTED_PARAMETER_PHRASES: RegExp[] = [
  // The parameter noun must follow the adjective directly: "Unsupported value for parameter
  // reasoning" is a value complaint, while "Unsupported parameter: reasoning" is not. The gap
  // can cross a colon that introduces the field name, but not a comma or clause-ending
  // punctuation, so an unrelated parameter named before a separate "reasoning" clause
  // does not match.
  /\b(?:unsupported|unknown|unrecognized|unrecognised)\s+(?:parameter|argument|field|property|option|input|feature)\b[^.;!?,]{0,40}\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b/i,
  /\b(?:does|do|did)\s+not\s+support\b[^.;!?]{0,30}\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b/i,
  // The parameter itself is the subject: a value echo later in the message is incidental.
  /\b(?:reasoning|effort|exclude)(?:[\w.-]*)\s+(?:is|are|was|were)\s+(?:not\s+supported|unsupported)\b/i,
  /\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b\s+(?:is|are|was|were)\s+not\s+one\s+of\s+(?:the\s+)?(?:supported|allowed|known|recognized|recognised)\s+(?:parameters?|arguments?|fields?|properties|options?|inputs?|features?)\b/i,
  /\b(?:reasoning(?:[_-]?(?:effort|exclude))?|reasoning\s+(?:controls?|parameters?|fields?)|effort|exclude)\b\s+(?:(?:is|are|was|were|has\s+been|have\s+been)\s+)?(?:rejected|refused)\b/i,
];

/** Provider phrases meaning the extra parameter itself is unknown, not that its value is bad. */
const UNSUPPORTED_PARAMETER_PHRASES: RegExp[] = [
  /(?:unsupported|unknown|unrecognized|unrecognised|unexpected)(?:\s+\w+){0,2}\s+(?:parameter|argument|field|property|option|input|feature)\b[^.;!?,]{0,30}\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b/i,
  /\bunknown\s+name\b/i,
  /\bcannot\s+(?:bind|find)\s+(?:the\s+)?(?:field|property|parameter)\b/i,
  /(?:parameter|argument|field|property|option|input|feature)\b[^.!?]{0,40}\b(?:unsupported|unknown|unrecognized|unrecognised|unexpected)\b/i,
  /\b(?:reasoning|effort|exclude)(?:[\w.-]*)(?:\s+\w+){0,3}\s+(?:is|are|was|were)\s+(?:not\s+supported|unsupported)\b/i,
  /\b(?:reasoning|effort|exclude)(?:[\w.-]*)(?:\s+\w+){0,3}\s+(?:(?:is|are|was|were)\s+)?not\s+supported\s+(?:by|for|with|in|on)\b/i,
  /\b(?:parameter|argument|field|property|option|feature)\b[^.!?]{0,30}\b(?:is|are|was|were)\s+not\s+(?:allowed|permitted|recognized|recognised)\b/i,
  /\bextra\s+(?:inputs?|fields?|properties|arguments?|parameters?)\b/i,
];

/** Schema/shape complaints about the reasoning field itself, not about its configured value. */
const SHAPE_MISMATCH_PHRASES: RegExp[] = [
  /\binput should be (?:a|an)\s+(?:valid\s+)?(?:string|object|boolean|number|array)\b/i,
];

/** Malformed-value signals: these must keep failing rather than mask a configuration typo. */
const INVALID_VALUE_PHRASES: RegExp[] = [
  /\binvalid\s+(?:value|type|format)\b/i,
  /\b(?:must|should|needs?\s+to)\s+be\s+(?:one\s+of|between|greater|less|at\s+most|at\s+least|a|an)\b/i,
  /\b(?:expected|not)\s+one\s+of\b/i,
  /\bout\s+of\s+range\b/i,
  /\b(?:valid|allowed)\s+values?\s+(?:are|is)\b/i,
  /\bnot\s+a\s+valid\b/i,
];

/**
 * True only for a client validation response (400/422) that reports the reasoning
 * configuration itself as unknown, unsupported, or of the wrong shape — the cases where
 * dropping the reasoning parameter and retrying is safe. Explicit parameter rejections and
 * a structured `param` naming the reasoning field win over the value bail-outs; invalid
 * effort values, missing values, and generic validation errors must surface normally.
 */
export function isUnsupportedReasoningEffortError(error: unknown, sentEffort?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown }).status);
  if (status !== 400 && status !== 422) return false;
  const message = errorMessage(error);

  if (EXPLICIT_UNSUPPORTED_PARAMETER_PHRASES.some((pattern) => pattern.test(message))) {
    return true;
  }

  const mentionsReasoning = /\b(?:reasoning|effort|exclude)/i.test(message);
  if (mentionsReasoning && sentEffort && mentionsEffortValue(message, sentEffort)) return false;
  if (mentionsReasoning && SHAPE_MISMATCH_PHRASES.some((pattern) => pattern.test(message))) {
    return true;
  }
  // Value complaints must win over a structured param: a param-only invalid-value message
  // may not mention the key at all.
  if (INVALID_VALUE_PHRASES.some((pattern) => pattern.test(message))) {
    return false;
  }
  if (structuredReasoningParam(error)) return true;
  if (!mentionsReasoning) return false;
  return UNSUPPORTED_PARAMETER_PHRASES.some((pattern) => pattern.test(message));
}

/**
 * True only when a 400/422 response clearly rejects the configured reasoning-effort
 * value. These errors are safe to recover from by omitting the optional reasoning object,
 * while unrelated validation failures must still surface normally.
 */
export function isInvalidReasoningEffortError(error: unknown, sentEffort?: string): boolean {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown }).status);
  if (status !== 400 && status !== 422) return false;
  if (isUnsupportedReasoningEffortError(error, sentEffort)) return false;

  const message = errorMessage(error);
  const mentionsReasoning = /\b(?:reasoning|effort|exclude)(?:[_-][\w.-]*)?\b/i.test(message);
  if (!mentionsReasoning && !structuredReasoningParam(error)) return false;

  if (INVALID_VALUE_PHRASES.some((pattern) => pattern.test(message))) return true;

  // Some providers describe a model-specific value rejection as "not supported" and
  // echo the submitted value instead of listing the accepted values.
  return Boolean(
    sentEffort &&
      mentionsEffortValue(message, sentEffort) &&
      /\b(?:invalid|unsupported|not\s+(?:supported|allowed|recognized|recognised))\b/i.test(message)
  );
}

/** Word-boundary match so short values like `low` or `max` cannot hit `follow` or `maximum`. */
function mentionsEffortValue(message: string, effort: string): boolean {
  const escaped = effort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\W)${escaped}(?:$|\\W)`, "i").test(message);
}

/** OpenAI-compatible SDK errors may name the offending parameter structurally. */
function structuredReasoningParam(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const param = (error as { param?: unknown }).param;
  return typeof param === "string" && /\b(?:reasoning|effort|exclude)/i.test(param);
}

/** Optional request parameters Robin can drop or rename without changing what is reviewed. */
export type DroppableRequestParam =
  | "temperature"
  | "max_tokens"
  | "max_completion_tokens"
  | "response_format";

/** Rejection cues seen from OpenAI-compatible servers when a request key is not accepted. */
const PARAM_REJECTION_CUES =
  /\b(?:unsupported|not\s+supported|no\s+longer\s+supported|deprecated|does\s+not\s+support|do\s+not\s+support|not\s+allowed|not\s+permitted|unknown|unrecognized|unrecognised|unexpected|invalid|extra\s+(?:inputs?|fields?)|only\s+(?:the\s+)?default|only\s+\S+\s+is\s+allowed|must\s+be|should\s+be|instead)\b/i;

/** The two token-cap spellings whose *value* validation must not be mistaken for an unsupported field. */
const TOKEN_LIMIT_PARAMS = new Set<DroppableRequestParam>([
  "max_tokens",
  "max_completion_tokens",
]);

/**
 * Structured codes that name the token-limit *field* as unknown/unsupported. Deliberately narrow:
 * a bare `unsupported` substring would also match the value code `unsupported_value`, which must be
 * handled as a bad value. The token-limit field must be named as unknown/unsupported explicitly.
 */
const UNSUPPORTED_FIELD_CODE =
  /(?:unsupported|unknown|unrecognized|unrecognised)[_-](?:parameter|argument|field|property|option|input|feature)/i;

/**
 * Structured codes that clearly report a bad *value* for a named field. These are explicit value
 * validation signals and take priority over any message wording (a message can say "is not
 * supported" while the code names a value problem like `unsupported_value` or `invalid_value`).
 */
const INVALID_VALUE_CODE =
  /(?:integer_below_min_value|integer_above_max_value|invalid_value|invalid_type|unsupported_value|out_of_range|less_than_minimum|greater_than_maximum)/i;

/** Message-only phrasings that name the token-limit *field* as unknown/unsupported. */
const UNSUPPORTED_TOKEN_LIMIT_FIELD_PHRASE =
  /\b(?:unsupported|unknown|unrecognized|unrecognised|unexpected)\s+(?:parameter|argument|field|property|option|input|feature)\b[^.;!?,]{0,40}\b(?:max_tokens|max_completion_tokens)\b|\b(?:max_tokens|max_completion_tokens)\b[^.]{0,40}\bis\s+not\s+(?:supported|allowed|permitted|recognized|recognised)\b|\b(?:does|do|did)\s+not\s+support\b[^.]{0,40}\b(?:max_tokens|max_completion_tokens)\b|\b(?:max_tokens|max_completion_tokens)\b[^.]{0,20}\b(?:is\s+|are\s+)?(?:unsupported|unknown|unrecognized|unrecognised)\b/i;

/**
 * True only when a 400/422 response names a sent token-limit parameter but the complaint is about
 * its value (below the provider minimum, outside a range, non-integer, …), not about the field
 * being unknown. Swapping the field or dropping the cap would hide a real configuration error and
 * silently run the review uncapped, so these must surface. Scoped to the token-limit params so
 * temperature/response_format value recovery (Kimi's "temperature must be 1", schema step-downs)
 * keeps working.
 *
 * Priority: an explicit structured *value* code wins first, then a structured code that names the
 * field itself as unknown/unsupported (so a provider's "Invalid parameter: max_tokens is not
 * supported …" still routes to the rename/omit path), then the message-only field phrasings, then
 * the generic message value heuristics.
 */
function isInvalidTokenLimitValueError(
  error: unknown,
  param: DroppableRequestParam,
  message: string
): boolean {
  if (!TOKEN_LIMIT_PARAMS.has(param)) return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && INVALID_VALUE_CODE.test(code)) return true;
  if (typeof code === "string" && UNSUPPORTED_FIELD_CODE.test(code)) return false;
  if (UNSUPPORTED_TOKEN_LIMIT_FIELD_PHRASE.test(message)) return false;

  return new RegExp(
    String.raw`\b(?:invalid|invalid_value)\b[^.]{0,60}${param}\b` +
      String.raw`|${param}\b[^.]{0,60}\b(?:must|should|expected|needs?)\b[^.]{0,40}\b(?:be\s+)?(?:greater|less|at\s+most|at\s+least|between|>=|<=|positive|[0-9])` +
      String.raw`|\b(?:expected|requires?|minimum|maximum)\b[^.]{0,30}\b(?:a\s+)?(?:value\s+)?(?:>=|<=|greater|less|at\s+least|at\s+most|between|[0-9])\b[^.]{0,40}${param}\b`,
    "i"
  ).test(message);
}

/**
 * Returns the first sent optional parameter that a 400/422 response rejects, or
 * undefined. Structured `param` (OpenAI SDK errors) wins; otherwise the message must
 * name the parameter (quoted or bare) alongside a rejection cue. Examples this matches:
 *   "Unsupported value: 'temperature' does not support 0.1 with this model."
 *   "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
 *   "temperature must be 1 for reasoning models"
 *   "`temperature` is deprecated for this model." (Anthropic, newer Claude models)
 * Dropping any of these is safe — the model falls back to its own defaults — so the
 * cue list is intentionally broad. Token-limit value complaints are the exception: they
 * are returned as undefined so the caller surfaces the provider's validation error.
 */
export function findUnsupportedRequestParam(
  error: unknown,
  sentParams: readonly DroppableRequestParam[]
): DroppableRequestParam | undefined {
  if (!error || typeof error !== "object" || sentParams.length === 0) return undefined;
  const status = Number((error as { status?: unknown }).status);
  if (status !== 400 && status !== 422) return undefined;

  const message = errorMessage(error);
  const structuredParam = (error as { param?: unknown }).param;
  if (typeof structuredParam === "string") {
    const match = sentParams.find((param) => structuredParam.toLowerCase() === param);
    if (match) {
      return isInvalidTokenLimitValueError(error, match, message) ? undefined : match;
    }
  }

  // OpenCode wraps this validation error in a generic invalid_request_error message, so it misses
  // the general rejection cues above. Keep this exception specific to a sent response_format type.
  if (
    sentParams.includes("response_format") &&
    /\bresponse_format\b\s*["'`]?\s*type\s+(?:is\s+)?unavailable\b/i.test(message)
  ) {
    return "response_format";
  }

  if (!PARAM_REJECTION_CUES.test(message)) return undefined;
  const named = sentParams.find((param) =>
    new RegExp(`(?:^|[^\\w])${param}(?:$|[^\\w])`, "i").test(message)
  );
  if (!named) return undefined;
  return isInvalidTokenLimitValueError(error, named, message) ? undefined : named;
}

const TOOL_NOUN = String.raw`(?:tools?|tool[\s_-]?(?:use|calling|calls|choice)|function[\s_-]?calling)`;

/** Provider phrasings for "this model/route cannot take tools" (OpenRouter, Ollama, vLLM, generic). */
const TOOLS_UNSUPPORTED_PHRASES: RegExp[] = [
  /\bno\s+endpoints?\s+found\s+that\s+supports?\b[^.]{0,40}\btool/i,
  new RegExp(String.raw`\b(?:does|do|did)\s+not\s+support\s+${TOOL_NOUN}\b`, "i"),
  new RegExp(
    String.raw`\b${TOOL_NOUN}\b[^.;!?]{0,40}\b(?:not\s+supported|unsupported|not\s+enabled|not\s+available)\b`,
    "i"
  ),
  /\b(?:unsupported|unknown|unrecognized|unrecognised|unexpected|extra)\s+(?:parameters?|arguments?|fields?|propert(?:y|ies)|inputs?)\b[^.;!?,]{0,40}\b(?:tools|tool_choice)\b/i,
  /\btool[\s_-]?choice\b[^.]{0,40}\brequires\b/i,
  /--enable-auto-tool-choice/i,
];

/**
 * True when the provider rejects the request because the model or route cannot use tools.
 * OpenRouter reports this as a 404 ("No endpoints found that support tool use"), which the
 * router retry logic would otherwise treat as a transient routing miss.
 */
export function isToolsUnsupportedError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isFinite(status) && ![400, 404, 405, 422, 501].includes(status)) return false;
    const param = (error as { param?: unknown }).param;
    if (typeof param === "string" && /^(?:tools|tool_choice)$/i.test(param)) return true;
  }
  const message = errorMessage(error);
  return TOOLS_UNSUPPORTED_PHRASES.some((pattern) => pattern.test(message));
}

const CONTEXT_LENGTH_PHRASES =
  /\b(?:context[_\s-]?length(?:[_\s-]?exceeded)?|context[_\s-]window|maximum\s+context|prompt\s+is\s+too\s+long|input\s+is\s+too\s+long|too\s+many\s+(?:input\s+)?tokens|reduce\s+the\s+length\s+of\s+the\s+(?:messages|prompt|input)|exceeds?\s+(?:the\s+)?(?:model'?s?\s+)?(?:maximum|max)\s+(?:context|input|prompt|token)|request\s+entity\s+too\s+large|payload\s+too\s+large)/i;

/** Bounded cause-chain walk: wrappers keep the native provider error in `cause`. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The conversation no longer fits the model's context window (OpenAI, Anthropic, OpenRouter,
 * vLLM phrasings). Examines the error and its bounded, cycle-safe cause chain, because the
 * client wraps provider errors in LLMRequestError without copying their native status.
 *
 * A native 413 is context/payload pressure. A 400/422 must name a known context signal.
 * Auth, rate-limit, output-length and unrelated validation failures never become context
 * pressure, even when an outer wrapper message echoes part of the native text.
 */
export function isContextLengthError(error: unknown): boolean {
  if (!error) return false;
  const seen = new Set<unknown>();
  let current: unknown = error;
  let sawContextSignal = false;
  let sawNativeStatus = false;
  let sawNativeContext = false;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current === "string") {
      sawContextSignal ||= CONTEXT_LENGTH_PHRASES.test(current);
      break;
    }
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    if ("status" in current) {
      const status = Number((current as { status?: unknown }).status);
      if (Number.isFinite(status) && status !== 400 && status !== 413 && status !== 422) return false;
      if (Number.isFinite(status)) {
        sawNativeStatus = true;
        sawNativeContext ||= status === 413 || CONTEXT_LENGTH_PHRASES.test(errorMessage(current));
      }
    }
    if (CONTEXT_LENGTH_PHRASES.test(errorMessage(current))) sawContextSignal = true;
    current = (current as { cause?: unknown }).cause;
  }
  return sawNativeStatus ? sawNativeContext : sawContextSignal;
}

/** The caller aborted this logical request. Cancellation is terminal, never a provider failure. */
export class LlmRequestCancelledError extends Error {
  constructor() {
    super("LLM request cancelled before completion.");
    this.name = "LlmRequestCancelledError";
  }
}

/**
 * The agent's own deadline expired. Terminal like cancellation so callers do not start an
 * unrelated fallback after total time is gone, but the message keeps the real cause visible.
 */
export class AgentDeadlineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentDeadlineError";
  }
}

/** SDK user aborts and transport abort errors are cancellations, not retryable provider errors. */
export function isCancellationError(error: unknown): boolean {
  if (error instanceof LlmRequestCancelledError || error instanceof AgentDeadlineError) return true;
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "APIUserAbortError" || name === "AbortError" || name === "AgentDeadlineError";
}

/** Throws the typed local cancellation before any further physical work when already aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LlmRequestCancelledError();
}

export function isRetriableLlmError(error: unknown, context: LlmRetryContext = {}): boolean {
  if (!error) return false;

  const routerModel = isOpenRouterRouterModel(context.model);

  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: number }).status);
    if (status === 429 || (Number.isFinite(status) && status >= 500)) {
      return true;
    }
    if (status === 404 && routerModel) {
      return true;
    }
    if (Number.isFinite(status) && status >= 400 && status < 500) {
      return false;
    }
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (routerModel && (message.includes("404") || isOpenRouterProviderError(error))) {
    return true;
  }

  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("network") ||
    message.includes("socket hang up") ||
    message.includes("rate limit") ||
    message.includes("overloaded") ||
    message.includes("empty response from llm") ||
    message.includes("openrouter stall")
  );
}

/**
 * A native provider 429 means capacity pressure, not a malformed request, so the client gives
 * it a longer bounded schedule. The client wraps provider failures in `LLMRequestError` and keeps
 * the native error in `cause`, so a bounded, cycle-safe cause walk recognizes both shapes; the
 * outer status alone is not enough. Message-only wording such as "rate limit" stays on the
 * ordinary retry path so non-429 failures keep today's attempt count and delays.
 */
export function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error === "string") return false;
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    if (Number((current as { status?: unknown }).status) === 429) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Reads a `Retry-After` header (SDK `Headers` or a plain object) from the error or its causes. */
function retryAfterHeaderValue(error: object): string | undefined {
  const headers = (error as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value = (get as (name: string) => unknown).call(headers, "retry-after");
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== "retry-after") continue;
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Seconds or an HTTP-date, clamped to the supported window; invalid hints are ignored. */
function parseRetryAfterValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(
    MAX_LLM_RATE_LIMIT_RETRY_DELAY_MS,
    Math.max(MIN_LLM_RATE_LIMIT_RETRY_DELAY_MS, Math.round(ms))
  );
}

/**
 * The provider's `Retry-After` delay in milliseconds, clamped to [1 s, 60 s], or undefined when
 * the response carries no usable hint. A bounded cause walk covers wrapped provider errors.
 */
export function parseRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error === "string") return undefined;
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!current || typeof current !== "object" || seen.has(current)) return undefined;
    seen.add(current);
    const parsed = parseRetryAfterValue(retryAfterHeaderValue(current));
    if (parsed !== undefined) return parsed;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function shouldUseJsonResponseMode(
  attempt: number,
  jsonResponseMode: boolean
): boolean {
  return jsonResponseMode && attempt === 1;
}

export function computeRetryDelayMs(
  attempt: number,
  context: LlmRetryContext = {},
  baseDelayMs = isOpenRouterRouterModel(context.model)
    ? DEFAULT_LLM_ROUTER_RETRY_DELAY_MS
    : DEFAULT_LLM_RETRY_DELAY_MS
): number {
  return baseDelayMs * attempt;
}

export function getLlmCompletionAttemptCount(
  maxAttempts = DEFAULT_LLM_COMPLETION_ATTEMPTS,
  model?: string
): number {
  const resolved =
    maxAttempts === DEFAULT_LLM_COMPLETION_ATTEMPTS && isOpenRouterRouterModel(model)
      ? DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS
      : maxAttempts;
  return Math.max(1, Math.floor(resolved));
}

/**
 * Attempts available for native 429s. The default attempt count is a cap Robin owns, so a 429
 * gets the longer rate-limit schedule (six total attempts). A non-default caller value is an
 * explicit configuration and is kept exactly; no action input or repo-config key exposes it
 * today, so this only constrains programmatic callers and tests.
 */
export function getLlmRateLimitAttemptCount(
  maxAttempts = DEFAULT_LLM_COMPLETION_ATTEMPTS,
  model?: string
): number {
  const resolved = getLlmCompletionAttemptCount(maxAttempts, model);
  return maxAttempts === DEFAULT_LLM_COMPLETION_ATTEMPTS
    ? Math.max(resolved, DEFAULT_LLM_RATE_LIMIT_COMPLETION_ATTEMPTS)
    : resolved;
}

/**
 * The wait before the next attempt after a failed `attempt` (1-based). The schedule is
 * 5/10/20/40 s and then 60 s. A usable provider `Retry-After` inside [1 s, 60 s] can only
 * lengthen that wait: the result is the larger of the scheduled delay and the clamped hint,
 * still capped at 60 s. No jitter: the announced waits match the documented schedule and
 * tests, and each job's retry burst stays independent and bounded.
 */
export function computeRateLimitRetryDelayMs(
  attempt: number,
  retryAfterDelayMs?: number
): number {
  const schedule = DEFAULT_LLM_RATE_LIMIT_RETRY_DELAYS_MS;
  const index = Math.min(Math.max(Math.floor(attempt), 1), schedule.length) - 1;
  const scheduled = schedule[index];
  if (retryAfterDelayMs === undefined || !Number.isFinite(retryAfterDelayMs)) return scheduled;
  const hint = Math.min(
    MAX_LLM_RATE_LIMIT_RETRY_DELAY_MS,
    Math.max(MIN_LLM_RATE_LIMIT_RETRY_DELAY_MS, Math.round(retryAfterDelayMs))
  );
  return Math.min(MAX_LLM_RATE_LIMIT_RETRY_DELAY_MS, Math.max(scheduled, hint));
}

export async function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  const abortSignal = signal;
  throwIfAborted(abortSignal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function cleanup() {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", onAbort);
    }
    function finish() {
      cleanup();
      resolve();
    }
    function onAbort() {
      cleanup();
      reject(new LlmRequestCancelledError());
    }
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A router stall keeps its own message, and an optional `cause` carries the native provider
 * error so the bounded cause-walking classifiers can still see a 429 status or a
 * `Retry-After` header. The wrapping does not change how non-429 failures are classified.
 */
export function openRouterStallError(firstChunkMs: number, cause?: unknown): Error {
  const message = `OpenRouter stall: no first response within ${firstChunkMs} ms`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}
