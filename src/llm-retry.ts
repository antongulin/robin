import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_RETRY_DELAY_MS,
  DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_RETRY_DELAY_MS,
  DEFAULT_LLM_ROUTER_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
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

/**
 * Returns the first sent optional parameter that a 400/422 response rejects, or
 * undefined. Structured `param` (OpenAI SDK errors) wins; otherwise the message must
 * name the parameter (quoted or bare) alongside a rejection cue. Examples this matches:
 *   "Unsupported value: 'temperature' does not support 0.1 with this model."
 *   "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."
 *   "temperature must be 1 for reasoning models"
 *   "`temperature` is deprecated for this model." (Anthropic, newer Claude models)
 * Dropping any of these is safe — the model falls back to its own defaults — so the
 * cue list is intentionally broad.
 */
export function findUnsupportedRequestParam(
  error: unknown,
  sentParams: readonly DroppableRequestParam[]
): DroppableRequestParam | undefined {
  if (!error || typeof error !== "object" || sentParams.length === 0) return undefined;
  const status = Number((error as { status?: unknown }).status);
  if (status !== 400 && status !== 422) return undefined;

  const structuredParam = (error as { param?: unknown }).param;
  if (typeof structuredParam === "string") {
    const match = sentParams.find((param) => structuredParam.toLowerCase() === param);
    if (match) return match;
  }

  const message = errorMessage(error);
  if (!PARAM_REJECTION_CUES.test(message)) return undefined;
  return sentParams.find((param) => new RegExp(`(?:^|[^\\w])${param}(?:$|[^\\w])`, "i").test(message));
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

/** The conversation no longer fits the model's context window (OpenAI, Anthropic, OpenRouter, vLLM phrasings). */
export function isContextLengthError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (status === 413) return true;
    if (Number.isFinite(status) && status !== 400 && status !== 422) return false;
  }
  return CONTEXT_LENGTH_PHRASES.test(errorMessage(error));
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

export async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function openRouterStallError(firstChunkMs: number): Error {
  return new Error(`OpenRouter stall: no first response within ${firstChunkMs} ms`);
}
