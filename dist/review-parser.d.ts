export interface ReviewFinding {
    severity: "high" | "medium" | "low" | "suggestion";
    category: string;
    file?: string;
    line?: number;
    description: string;
    recommendation: string;
    codeSnippet?: string;
}
export interface StructuredReview {
    summary: string;
    high: ReviewFinding[];
    medium: ReviewFinding[];
    low: ReviewFinding[];
    suggestions: ReviewFinding[];
    rawResponse: string;
}
export interface ParsedReview {
    findings: StructuredReview;
    usedJson: boolean;
}
export declare class ReviewParser {
    static parse(rawText: string): StructuredReview;
    static parseDetailed(rawText: string): ParsedReview;
    private static parseJsonReview;
    private static extractJsonObject;
    private static normalizeFindings;
    private static normalizeFinding;
    private static asString;
    private static asNumber;
    private static parseMarkdownReview;
    private static extractSection;
    private static parseFindings;
    private static looksLikeCode;
    private static extractFileAndLine;
}
//# sourceMappingURL=review-parser.d.ts.map