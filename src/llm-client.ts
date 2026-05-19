import { OpenAI } from "openai";
import { DEFAULT_LLM_COMPLETION_ATTEMPTS, DEFAULT_LLM_TIMEOUT_MS } from "./config";
import {
  computeRetryDelayMs,
  delayMs,
  getLlmCompletionAttemptCount,
  isRetriableLlmError,
  shouldUseJsonResponseMode,
} from "./llm-retry";
import * as core from "@actions/core";

export interface ChatCompletionResult {
  content: string;
  model?: string;
}

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private maxOutputTokens?: number;
  private maxAttempts: number;

  constructor(
    baseUrl: string,
    apiKey: string,
    model: string,
    maxOutputTokens?: number,
    timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
    maxAttempts = DEFAULT_LLM_COMPLETION_ATTEMPTS
  ) {
    core.info(
      `Initializing LLM client: baseUrl=${baseUrl}, model=${model}, timeout=${timeoutMs} ms, maxAttempts=${maxAttempts}`
    );

    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || "ollama",
      maxRetries: 3,
      timeout: timeoutMs,
    });

    this.model = model;
    this.maxOutputTokens =
      maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? maxOutputTokens
        : undefined;
    this.maxAttempts = getLlmCompletionAttemptCount(maxAttempts);
  }

  async chatCompletion(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode = false
  ): Promise<ChatCompletionResult> {
    let lastFinishReason = "unknown";
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const useJson = shouldUseJsonResponseMode(attempt, jsonResponseMode);

      try {
        const response = await this.client.chat.completions.create(
          this.buildRequest(systemPrompt, userContent, useJson)
        );
        const content = this.extractMessageContent(response);
        const resolvedModel = response.model || this.model;

        if (content) {
          this.logResolvedModel(resolvedModel);
          return { content, model: resolvedModel };
        }

        lastFinishReason = response.choices?.[0]?.finish_reason || "unknown";
        core.warning(
          `LLM attempt ${attempt}/${this.maxAttempts}: empty content (finish_reason=${lastFinishReason}${useJson ? ", json mode" : ""})`
        );
      } catch (error) {
        lastError = error;
        core.warning(`LLM attempt ${attempt}/${this.maxAttempts} failed: ${error}`);

        if (!isRetriableLlmError(error) || attempt === this.maxAttempts) {
          core.error(`LLM API error: ${error}`);
          throw new Error(`Failed to get response from LLM: ${error}`);
        }
      }

      if (attempt < this.maxAttempts) {
        const waitMs = computeRetryDelayMs(attempt);
        core.info(`Retrying LLM request in ${waitMs} ms (attempt ${attempt + 1}/${this.maxAttempts})...`);
        await delayMs(waitMs);
      }
    }

    if (lastError && isRetriableLlmError(lastError)) {
      core.error(`LLM API error after ${this.maxAttempts} attempts: ${lastError}`);
      throw new Error(
        `Failed to get response from LLM after ${this.maxAttempts} attempts: ${lastError}`
      );
    }

    throw new Error(
      `Empty response from LLM after ${this.maxAttempts} attempts (finish_reason=${lastFinishReason})`
    );
  }

  private buildRequest(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode: boolean
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
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

    return request;
  }

  private logResolvedModel(resolvedModel: string): void {
    if (resolvedModel && resolvedModel !== this.model) {
      core.info(`LLM resolved model: ${resolvedModel} (requested: ${this.model})`);
    } else {
      core.info(`LLM response model: ${resolvedModel}`);
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
