import { OpenAI } from "openai";
import { DEFAULT_LLM_TIMEOUT_MS } from "./config";
import * as core from "@actions/core";

export interface ChatCompletionResult {
  content: string;
  model?: string;
}

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private maxOutputTokens?: number;

  constructor(baseUrl: string, apiKey: string, model: string, maxOutputTokens?: number, timeoutMs = DEFAULT_LLM_TIMEOUT_MS) {
    core.info(`Initializing LLM client: baseUrl=${baseUrl}, model=${model}, timeout=${timeoutMs} ms`);
    
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || "ollama",
      maxRetries: 3,
      timeout: timeoutMs,
    });

    this.model = model;
    this.maxOutputTokens = maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
      ? maxOutputTokens
      : undefined;
  }

  async chatCompletion(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode = false
  ): Promise<ChatCompletionResult> {
    try {
      const request: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0.1,
      };

      if (this.maxOutputTokens) {
        request.max_tokens = this.maxOutputTokens;
      }

      if (jsonResponseMode) {
        request.response_format = { type: "json_object" };
      }

      const response = await this.client.chat.completions.create(request);

      const content = response.choices[0]?.message?.content || "";
      const resolvedModel = response.model || this.model;

      if (resolvedModel && resolvedModel !== this.model) {
        core.info(`LLM resolved model: ${resolvedModel} (requested: ${this.model})`);
      } else {
        core.info(`LLM response model: ${resolvedModel}`);
      }
      
      if (!content) {
        throw new Error("Empty response from LLM");
      }

      return { content, model: resolvedModel };
    } catch (error) {
      core.error(`LLM API error: ${error}`);
      throw new Error(`Failed to get response from LLM: ${error}`);
    }
  }
}
