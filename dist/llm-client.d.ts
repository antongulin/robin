export interface ChatCompletionResult {
    content: string;
    model?: string;
}
export declare class LLMClient {
    private client;
    private model;
    private maxOutputTokens?;
    private maxAttempts;
    constructor(baseUrl: string, apiKey: string, model: string, maxOutputTokens?: number, timeoutMs?: number, maxAttempts?: number);
    chatCompletion(systemPrompt: string, userContent: string, jsonResponseMode?: boolean): Promise<ChatCompletionResult>;
    private buildRequest;
    private logResolvedModel;
    private extractMessageContent;
}
//# sourceMappingURL=llm-client.d.ts.map