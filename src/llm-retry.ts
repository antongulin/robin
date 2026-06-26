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
