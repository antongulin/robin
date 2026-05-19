import { StructuredReview } from "./review-parser";

const RETRY_SUMMARY_MAX_LENGTH = 40;

export function shouldRetryStructuredReview(
  findings: StructuredReview,
  usedJson: boolean
): boolean {
  const findingCount =
    findings.high.length +
    findings.medium.length +
    findings.low.length +
    findings.suggestions.length;

  if (findingCount > 0) return false;
  if (usedJson) return false;

  return findings.summary.trim().length <= RETRY_SUMMARY_MAX_LENGTH;
}
