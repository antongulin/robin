import { OpenAI } from "openai";
import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS,
  DEFAULT_LLM_TIMEOUT_MS,
} from "./config";
import {
  computeRetryDelayMs,
  delayMs,
  getLlmCompletionAttemptCount,
  isOpenRouterRouterModel,
  isRetriableLlmError,
  openRouterStallError,
  resolveLlmTimeoutMs,
  shouldUseJsonResponseMode,
} from "./llm-retry";
import * as core from "@actions/core";

export interface ChatCompletionResult {
  content: string;
  model?: string;
}

export type LlmProgressHandler = (detail: string) => void | Promise<void>;

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private maxOutputTokens?: number;
  private maxAttempts: number;
  private routerModel: boolean;
  private onProgress?: LlmProgressHandler;

  constructor(
    baseUrl: string,
    apiKey: string,
    model: string,
    maxOutputTokens?: number,
    timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
    maxAttempts = DEFAULT_LLM_COMPLETION_ATTEMPTS,
    onProgress?: LlmProgressHandler
  ) {
    this.model = model;
    this.routerModel = isOpenRouterRouterModel(model);
    this.onProgress = onProgress;
    this.maxOutputTokens =
      maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? maxOutputTokens
        : undefined;
    this.maxAttempts = getLlmCompletionAttemptCount(maxAttempts, model);
    const effectiveTimeoutMs = resolveLlmTimeoutMs(model, timeoutMs);

    core.info(
      `Initializing LLM client: baseUrl=${baseUrl}, model=${model}, timeout=${effectiveTimeoutMs} ms, maxAttempts=${this.maxAttempts}`
    );

    // ponytail: chatCompletion owns retries; SDK maxRetries × 10-min timeout burned whole job budgets
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: apiKey || "ollama",
      maxRetries: 0,
      timeout: effectiveTimeoutMs,
    });

    if (this.routerModel) {
      core.info(
        `OpenRouter router model — ${DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS / 1000}s first-chunk stall detect, ${effectiveTimeoutMs / 1000}s stream cap, provider fallbacks.`
      );
    }
  }

  private retryContext() {
    return { model: this.model };
  }

  private async progress(detail: string): Promise<void> {
    if (this.onProgress) {
      await this.onProgress(detail);
    }
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
        core.info(`LLM attempt ${attempt}/${this.maxAttempts}: waiting for provider...`);
        await this.progress(
          `Waiting for provider (attempt ${attempt}/${this.maxAttempts})…`
        );
        const request = this.buildRequest(systemPrompt, userContent, useJson);
        const { content, model: resolvedModel } = this.routerModel
          ? await this.streamChatCompletion(request)
          : await this.blockingChatCompletion(request);

        if (content) {
          if (!this.routerModel) {
            this.logResolvedModel(resolvedModel || this.model);
          }
          return { content, model: resolvedModel };
        }

        lastFinishReason = "empty";
        core.warning(
          `LLM attempt ${attempt}/${this.maxAttempts}: empty content${useJson ? " (json mode)" : ""}`
        );
      } catch (error) {
        lastError = error;
        core.warning(`LLM attempt ${attempt}/${this.maxAttempts} failed: ${error}`);

        if (!isRetriableLlmError(error, this.retryContext()) || attempt === this.maxAttempts) {
          core.error(`LLM API error: ${error}`);
          throw new Error(`Failed to get response from LLM: ${error}`);
        }
      }

      if (attempt < this.maxAttempts) {
        const waitMs = computeRetryDelayMs(attempt, this.retryContext());
        const reason = lastError instanceof Error ? lastError.message : "empty response";
        core.info(`Retrying LLM request in ${waitMs} ms (attempt ${attempt + 1}/${this.maxAttempts})...`);
        await this.progress(
          `Attempt ${attempt} did not succeed (${reason}). Retrying in ${Math.round(waitMs / 1000)}s…`
        );
        await delayMs(waitMs);
      }
    }

    if (lastError && isRetriableLlmError(lastError, this.retryContext())) {
      core.error(`LLM API error after ${this.maxAttempts} attempts: ${lastError}`);
      throw new Error(
        `Failed to get response from LLM after ${this.maxAttempts} attempts: ${lastError}`
      );
    }

    throw new Error(
      `Empty response from LLM after ${this.maxAttempts} attempts (finish_reason=${lastFinishReason})`
    );
  }

  private async blockingChatCompletion(
    request: OpenAI.Chat.Completions.ChatCompletionCreateParams
  ): Promise<ChatCompletionResult> {
    const response = await this.client.chat.completions.create({
      ...request,
      stream: false,
    });
    return {
      content: this.extractMessageContent(response),
      model: response.model || this.model,
    };
  }

  /** Stream so the first SSE chunk (model id) proves OpenRouter routed; abort if none arrives. */
  private async streamChatCompletion(
    request: OpenAI.Chat.Completions.ChatCompletionCreateParams
  ): Promise<ChatCompletionResult> {
    const firstChunkMs = DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS;
    const controller = new AbortController();
    let gotFirstChunk = false;
    // ponytail: timer starts before create() so a hung TCP/connect also fails at firstChunkMs
    let stallTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      controller.abort();
    }, firstChunkMs);

    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };

    try {
      const stream = await this.client.chat.completions.create(
        { ...request, stream: true },
        { signal: controller.signal }
      );

      const parts: string[] = [];
      let resolvedModel = this.model;

      for await (const chunk of stream) {
        if (!gotFirstChunk) {
          gotFirstChunk = true;
          clearStallTimer();
          resolvedModel = chunk.model || resolvedModel;
          if (chunk.model && chunk.model !== this.model) {
            core.info(`LLM resolved model: ${chunk.model} (requested: ${this.model})`);
            await this.progress(`Routed to \`${chunk.model}\` — generating review…`);
          } else {
            core.info("OpenRouter stream started — provider accepted the request.");
            await this.progress("Provider accepted the request — generating review…");
          }
        }

        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          parts.push(delta);
        }
        if (chunk.model) {
          resolvedModel = chunk.model;
        }
      }

      return { content: parts.join(""), model: resolvedModel };
    } catch (error) {
      clearStallTimer();
      if (!gotFirstChunk) {
        throw openRouterStallError(firstChunkMs);
      }
      throw error;
    }
  }

  private buildRequest(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode: boolean
  ): OpenAI.Chat.Completions.ChatCompletionCreateParams {
    const request: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
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

    if (this.routerModel) {
      // OpenRouter extension: try other providers when the first free route 404s.
      (request as OpenAI.Chat.Completions.ChatCompletionCreateParams & {
        provider?: { allow_fallbacks: boolean };
      }).provider = { allow_fallbacks: true };
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
