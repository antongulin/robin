import { StructuredReview } from "./review-parser";

export function shouldRetryStructuredReview(findings: StructuredReview): boolean {
  return (
    findings.high.length +
      findings.medium.length +
      findings.low.length +
      findings.suggestions.length ===
    0
  );
}
