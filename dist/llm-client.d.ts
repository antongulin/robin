export interface ChatCompletionResult {
    content: string;
    model?: string;
}
export declare class LLMClient {
    private client;
    private model;
    private maxOutputTokens?;
    constructor(baseUrl: string, apiKey: string, model: string, maxOutputTokens?: number, timeoutMs?: number);
    chatCompletion(systemPrompt: string, userContent: string, jsonResponseMode?: boolean): Promise<ChatCompletionResult>;
    private extractMessageContent;
}
//# sourceMappingURL=llm-client.d.ts.map