export declare function isRetriableLlmError(error: unknown): boolean;
export declare function shouldUseJsonResponseMode(attempt: number, jsonResponseMode: boolean): boolean;
export declare function computeRetryDelayMs(attempt: number, baseDelayMs?: number): number;
export declare function getLlmCompletionAttemptCount(maxAttempts?: number): number;
export declare function delayMs(ms: number): Promise<void>;
//# sourceMappingURL=llm-retry.d.ts.map