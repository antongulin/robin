/** Heuristic for the installed SDK's complete, pretty-printed JSON request body. */
export const REQUEST_ESTIMATOR = "utf8-json-div3-v1";
export const DEFAULT_ESTIMATED_REQUEST_TOKEN_BUDGET = 256_000;
export type EstimatedRequestTokenBudget = number | "off";

/** Fixed diagnostics deliberately omit invalid input/config text. */
export function positiveSafeInteger(value: string | number, setting: string): number {
  const text = typeof value === "string" ? value.trim() : String(value);
  const parsed = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${setting}; use a positive safe integer.`);
  }
  return parsed;
}

export function parseEstimatedRequestTokenBudget(value: string | number): EstimatedRequestTokenBudget {
  if (typeof value === "string" && value.trim().toLowerCase() === "off") return "off";
  return positiveSafeInteger(value, "estimated-request-token-budget (or use off)");
}

export function resolveOutputTokenCap(
  explicit: number | undefined,
  budget: EstimatedRequestTokenBudget
): number | undefined {
  if (explicit !== undefined) return positiveSafeInteger(explicit, "max-output-tokens");
  return budget === "off" ? undefined : Math.max(1, Math.min(32_000, Math.floor(budget / 8)));
}

export interface RequestBudgetFacts {
  budget: number;
  estimatedInput: number;
  outputReserve: number;
  safetyHeadroom: number;
}

/** Local preflight rejection: never a physical provider attempt or compatibility error. */
export class EstimatedRequestBudgetError extends Error {
  constructor(readonly facts: RequestBudgetFacts) {
    super(
      `Estimated request budget exceeded (${REQUEST_ESTIMATOR}): budget ${facts.budget}, ` +
      `estimated input ${facts.estimatedInput}, output reserve ${facts.outputReserve}, safety headroom ${facts.safetyHeadroom}. ` +
      "No provider request was sent. Adjust estimated-request-token-budget or max-output-tokens for your endpoint, " +
      "reduce instructions/history or split the PR. Robin does not clip the diff. " +
      "Use estimated-request-token-budget: off to disable this estimate and its default output cap."
    );
    this.name = "EstimatedRequestBudgetError";
  }
}

/** No serialization is retained; estimates are separate from provider-reported usage. */
export function assertRequestFits(
  body: object,
  budget: EstimatedRequestTokenBudget,
  outputReserve: number | undefined
): void {
  if (budget === "off") return;
  positiveSafeInteger(budget, "estimated-request-token-budget");
  const output = positiveSafeInteger(outputReserve ?? 0, "max-output-tokens");
  // OpenAI SDK 4.104.0 core serializes JSON with two-space indentation.
  const bytes = Buffer.byteLength(JSON.stringify(body, null, 2), "utf8");
  const estimatedInput = Math.ceil(bytes / 3);
  const safetyHeadroom = Math.ceil(budget / 16);
  // Subtract reserves instead of summing potentially unsafe integers.
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(estimatedInput) ||
      output > budget - safetyHeadroom || estimatedInput > budget - safetyHeadroom - output) {
    throw new EstimatedRequestBudgetError({ budget, estimatedInput, outputReserve: output, safetyHeadroom });
  }
}
