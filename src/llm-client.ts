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

      let response = await this.client.chat.completions.create(request);
      let content = this.extractMessageContent(response);
      let resolvedModel = response.model || this.model;

      if (!content) {
        core.warning("LLM returned empty content; retrying once without response_format.");
        const retryRequest = { ...request };
        delete retryRequest.response_format;
        response = await this.client.chat.completions.create(retryRequest);
        content = this.extractMessageContent(response);
        resolvedModel = response.model || this.model;
      }

      if (resolvedModel && resolvedModel !== this.model) {
        core.info(`LLM resolved model: ${resolvedModel} (requested: ${this.model})`);
      } else {
        core.info(`LLM response model: ${resolvedModel}`);
      }

      if (!content) {
        const finishReason = response.choices?.[0]?.finish_reason || "unknown";
        throw new Error(`Empty response from LLM (finish_reason=${finishReason})`);
      }

      return { content, model: resolvedModel };
    } catch (error) {
      core.error(`LLM API error: ${error}`);
      throw new Error(`Failed to get response from LLM: ${error}`);
    }
  }

  private extractMessageContent(response: OpenAI.Chat.Completions.ChatCompletion): string {
    const choice = response.choices?.[0];
    if (!choice) {
      core.warning("LLM response has no choices array.");
      return "";
    }

    const content = choice.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }

    core.warning(
      `LLM choice has no text content (finish_reason=${choice.finish_reason || "unknown"}).`
    );
    return "";
  }
}
