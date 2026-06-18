import * as core from "@actions/core";

export interface ReviewFinding {
  severity: "high" | "medium" | "low" | "suggestion";
  category: string;
  confidence?: "high" | "medium" | "low";
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

export class ReviewParser {
  static parse(rawText: string): StructuredReview {
    return this.parseDetailed(rawText).findings;
  }

  static parseDetailed(rawText: string): ParsedReview {
    const review: StructuredReview = {
      summary: "",
      high: [],
      medium: [],
      low: [],
      suggestions: [],
      rawResponse: rawText,
    };

    try {
      const jsonReview = this.parseJsonReview(rawText);
      if (jsonReview) {
        core.info(
          `Parsed JSON review: ${jsonReview.high.length} high, ${jsonReview.medium.length} medium, ${jsonReview.low.length} low, ${jsonReview.suggestions.length} suggestions`
        );
        return { findings: jsonReview, usedJson: true };
      }

      const markdownReview = this.parseMarkdownReview(rawText, review);
      review.summary = markdownReview.summary;
      review.high = markdownReview.high;
      review.medium = markdownReview.medium;
      review.low = markdownReview.low;
      review.suggestions = markdownReview.suggestions;

      core.info(`Parsed: ${review.high.length} high, ${review.medium.length} medium, ${review.low.length} low, ${review.suggestions.length} suggestions`);
    } catch (error) {
      core.warning(`Failed to parse structured review: ${error}. Treating entire response as raw summary.`);
      review.summary = rawText;
    }

    return { findings: review, usedJson: false };
  }

  private static parseJsonReview(rawText: string): StructuredReview | null {
    const jsonText = this.extractJsonObject(rawText);
    if (!jsonText) return null;

    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;

      return {
        summary: this.asString(parsed.summary),
        high: this.normalizeFindings(parsed.high ?? parsed.critical, "high"),
        medium: this.normalizeFindings(parsed.medium ?? parsed.important, "medium"),
        low: this.normalizeFindings(parsed.low, "low"),
        suggestions: this.normalizeFindings(parsed.suggestions, "suggestion"),
        rawResponse: rawText,
      };
    } catch {
      return null;
    }
  }

  private static extractJsonObject(rawText: string): string | null {
    const fencedJson = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedJson) return fencedJson[1].trim();

    const start = rawText.indexOf("{");
    const end = rawText.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;

    return rawText.slice(start, end + 1).trim();
  }

  private static normalizeFindings(value: unknown, severity: ReviewFinding["severity"]): ReviewFinding[] {
    if (!Array.isArray(value)) return [];

    return value
      .map((item) => this.normalizeFinding(item, severity))
      .filter((item): item is ReviewFinding => item !== null);
  }

  private static normalizeFinding(value: unknown, severity: ReviewFinding["severity"]): ReviewFinding | null {
    if (!value || typeof value !== "object") return null;

    const item = value as Record<string, unknown>;
    const description = this.asString(item.description).trim();
    if (!description) return null;

    const line = this.asNumber(item.line);
    const file = this.asString(item.file).trim() || undefined;

    return {
      severity,
      category: this.asString(item.category),
      confidence: this.asConfidence(item.confidence),
      file,
      line,
      description,
      recommendation: this.asString(item.recommendation),
      codeSnippet: this.asString(item.codeSnippet) || undefined,
    };
  }

  private static asString(value: unknown): string {
    return typeof value === "string" ? value : "";
  }

  private static asConfidence(value: unknown): ReviewFinding["confidence"] {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return normalized === "high" || normalized === "medium" || normalized === "low"
      ? normalized
      : undefined;
  }

  private static asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return parseInt(value, 10);
    return undefined;
  }

  private static parseMarkdownReview(rawText: string, review: StructuredReview): StructuredReview {
    const summaryMatch = rawText.match(/#{2,3}\s*Summary[\s\S]*?(?=(?:#{2,3}\s*(?:High|Medium|Low|Critical|Important|Suggestion)|$))/i);
    if (summaryMatch) {
      review.summary = summaryMatch[0].replace(/#{2,3}\s*Summary\s*/i, "").trim();
    }

    const highSection = this.extractSection(rawText, "High|Critical");
    const mediumSection = this.extractSection(rawText, "Medium|Important");
    const lowSection = this.extractSection(rawText, "Low");
    const suggestionSection = this.extractSection(rawText, "Suggestion");

    review.high = this.parseFindings(highSection, "high");
    review.medium = this.parseFindings(mediumSection, "medium");
    review.low = this.parseFindings(lowSection, "low");
    review.suggestions = this.parseFindings(suggestionSection, "suggestion");

    return review;
  }

  private static extractSection(text: string, sectionName: string): string {
    const regex = new RegExp(
      `#{2,3}\\s*(?:${sectionName})[^\\n]*(?::|\\s*\\(.*?\\))?\\s*\\n([\\s\\S]*?)(?=(?:#{2,3}\\s*(?:High|Medium|Low|Critical|Important|Suggestion|Summary)|$))`,
      "i"
    );
    const match = text.match(regex);
    return match ? match[1].trim() : "";
  }

  private static parseFindings(section: string, severity: ReviewFinding["severity"]): ReviewFinding[] {
    if (!section) return [];

    const lines = section.split("\n");
    const findings: ReviewFinding[] = [];
    let currentFinding: Partial<ReviewFinding> | null = null;
    let descriptionLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const itemText = trimmed.replace(/^[-*•·]\s+/, "").replace(/^\d+\.\s+/, "");
      if (/^(none|n\/a|no issues?)\.?$/i.test(itemText)) continue;

      const isNewItem = /^[-*•·]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed);

      if (isNewItem) {
        if (currentFinding) {
          currentFinding.description = descriptionLines.join("\n").trim();
          if (currentFinding.description) {
            findings.push(currentFinding as ReviewFinding);
          }
        }

        const fileLine = this.extractFileAndLine(trimmed);
        currentFinding = {
          severity,
          category: "",
          description: "",
          recommendation: "",
          file: fileLine.file,
          line: fileLine.line,
        };

        // Use cleaned text (without file:line prefix) as first description line
        descriptionLines = [fileLine.cleanedText];
      } else if (trimmed.startsWith("  ") || trimmed.startsWith("\t")) {
        if (this.looksLikeCode(trimmed)) {
          if (currentFinding) {
            currentFinding.codeSnippet = (currentFinding.codeSnippet || "") + trimmed + "\n";
          }
        } else {
          descriptionLines.push(trimmed);
        }
      } else {
        descriptionLines.push(trimmed);
      }
    }

    if (currentFinding) {
      currentFinding.description = descriptionLines.join("\n").trim();
      if (currentFinding.description) {
        findings.push(currentFinding as ReviewFinding);
      }
    }

    return findings;
  }

  private static looksLikeCode(text: string): boolean {
    const codeIndicators = [
      /^\s*(def|class|function|const|let|var|import|export|if|for|while|return)/,
      /^\s*[/].*[/]/,
      /^\s*[`"']/,
      /^\s*[{\[(]/,
    ];
    return codeIndicators.some((pattern) => pattern.test(text));
  }

  private static extractFileAndLine(text: string): { file?: string; line?: number; cleanedText: string } {
    // Match pattern like `src/auth.ts:42 — description` or `src/auth.ts:42 - description`
    const itemText = text.replace(/^[-*•·]\s+/, "").replace(/^\d+\.\s+/, "");
    const fullPattern = /^[`']?([^`\s]+\.(?:[a-zA-Z0-9]+))[`']?\s*:\s*(\d+)\s*(?:--|[\-\u2013\u2014])\s*(.+)$/i;
    const match = itemText.match(fullPattern);

    if (match) {
      return {
        file: match[1],
        line: parseInt(match[2], 10),
        cleanedText: match[3].trim(),
      };
    }

    // Fallback: try to find file and line anywhere in the text
    const filePattern = /[`']?([^`\s]+\.(?:[a-zA-Z0-9]+))[`']?/i;
    const linePattern = /:(\d+)/i;

    const fileMatch = itemText.match(filePattern);
    const lineMatch = itemText.match(linePattern);

    return {
      file: fileMatch ? fileMatch[1] : undefined,
      line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
      cleanedText: itemText,
    };
  }
}
