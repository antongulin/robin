export const DEFAULT_LLM_TIMEOUT_MS = 600000; // 10 minutes
export const DEFAULT_LLM_ROUTER_TIMEOUT_MS = 120000; // 2 minutes — openrouter/free happy path is ~60-90s
export const DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS = 45000; // no SSE = stacked router; fail fast and retry
export const DEFAULT_LLM_COMPLETION_ATTEMPTS = 3;
export const DEFAULT_LLM_ROUTER_COMPLETION_ATTEMPTS = 5;
export const DEFAULT_LLM_RETRY_DELAY_MS = 2000;
export const DEFAULT_LLM_ROUTER_RETRY_DELAY_MS = 3000;
export const DEFAULT_LLM_TEMPERATURE = 0.1; // near-deterministic reviews
/** OpenAI-compatible upper bound; some models (e.g. Kimi) only accept 1. */
export const MAX_LLM_TEMPERATURE = 2;

export function parseLLMTimeout(input: string): { value: number; valid: boolean } {
  if (!input) return { value: DEFAULT_LLM_TIMEOUT_MS, valid: true };
  const parsed = Number(input);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { value: parsed, valid: true };
  }
  return { value: DEFAULT_LLM_TIMEOUT_MS, valid: false };
}

export function parseLLMTemperature(input: string): { value: number; valid: boolean } {
  const trimmed = input.trim();
  if (!trimmed) return { value: DEFAULT_LLM_TEMPERATURE, valid: true };
  const parsed = Number(trimmed);
  // 0 is a legitimate value, so range-check instead of truthiness.
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_LLM_TEMPERATURE) {
    return { value: parsed, valid: true };
  }
  return { value: DEFAULT_LLM_TEMPERATURE, valid: false };
}
