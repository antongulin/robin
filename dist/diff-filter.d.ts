export declare const DEFAULT_SKIP_PATH_PATTERNS: string[];
export declare function matchPathPattern(pattern: string, filePath: string): boolean;
export declare function shouldSkipPath(filePath: string, patterns: string[]): boolean;
export declare function splitDiffIntoFiles(diff: string): Array<{
    path: string;
    content: string;
}>;
export declare function filterDiff(diff: string, extraSkipPatterns?: string[]): {
    filtered: string;
    removedFiles: string[];
};
//# sourceMappingURL=diff-filter.d.ts.map