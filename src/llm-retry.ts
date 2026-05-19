import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_RETRY_DELAY_MS,
} from "./config";

export function isRetriableLlmError(error: unknown): boolean {
  if (!error) return false;

  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: number }).status);
    if (status === 429 || (Number.isFinite(status) && status >= 500)) {
      return true;
    }
    if (Number.isFinite(status) && status >= 400 && status < 500) {
      return false;
    }
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("network") ||
    message.includes("socket hang up") ||
    message.includes("rate limit") ||
    message.includes("overloaded") ||
    message.includes("empty response from llm")
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
  baseDelayMs = DEFAULT_LLM_RETRY_DELAY_MS
): number {
  return baseDelayMs * attempt;
}

export function getLlmCompletionAttemptCount(
  maxAttempts = DEFAULT_LLM_COMPLETION_ATTEMPTS
): number {
  return Math.max(1, Math.floor(maxAttempts));
}

export async function delayMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
