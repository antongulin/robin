import { OpenAI } from "openai";
import { REVIEW_JSON_SCHEMA } from "./prompts/review-schema";
import {
  DEFAULT_LLM_COMPLETION_ATTEMPTS,
  DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_TIMEOUT_MS,
} from "./config";
import {
  computeRetryDelayMs,
  delayMs,
  DroppableRequestParam,
  errorMessage,
  findUnsupportedRequestParam,
  getLlmCompletionAttemptCount,
  isInvalidReasoningEffortError,
  isOpenRouterRouterModel,
  isContextLengthError,
  isRetriableLlmError,
  isToolsUnsupportedError,
  isUnsupportedReasoningEffortError,
  openRouterStallError,
  resolveLlmTimeoutMs,
  shouldUseJsonResponseMode,
} from "./llm-retry";
import {
  detectLlmProvider,
  isOpenAIReasoningModel,
  LlmProvider,
  normalizeLlmBaseUrl,
} from "./llm-provider";
import { ReasoningFallbackReason } from "./reasoning-fallback";
import * as core from "@actions/core";

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolDefinition = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatCompletionResult {
  content: string;
  model?: string;
  toolCalls?: ToolCall[];
}

export interface ToolChatOptions {
  /** "none" asks for a final text answer while keeping the tool definitions the history needs. */
  toolChoice?: "auto" | "none";
}

/** The provider or model cannot take `tools`; callers should fall back to a plain completion. */
export class ToolsUnsupportedError extends Error {
  constructor(cause: unknown) {
    super(`Model does not support tool calling: ${errorMessage(cause)}`);
    this.name = "ToolsUnsupportedError";
  }
}

interface CompletionOptions {
  jsonResponseMode: boolean;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
}

export type LlmProgressHandler = (detail: string) => void | Promise<void>;

type ReasoningRequest = {
  /** OpenRouter-style reasoning object (default shape). */
  reasoning?: { effort: string; exclude: boolean };
  /** OpenAI-native reasoning control, sent only to api.openai.com. */
  reasoning_effort?: string;
};

type ChatRequest = Omit<OpenAI.Chat.Completions.ChatCompletionCreateParams, "reasoning_effort"> &
  ReasoningRequest;

type TokenLimitParam = "max_tokens" | "max_completion_tokens";

export class LLMClient {
  private client: OpenAI;
  private model: string;
  private provider: LlmProvider;
  private maxOutputTokens?: number;
  private maxAttempts: number;
  private routerModel: boolean;
  private temperature: number;
  private onProgress?: LlmProgressHandler;
  private reasoningEffort?: string;
  private reasoningFallbackActive = false;
  private reasoningFallbackReason?: ReasoningFallbackReason;
  /** Request-shape compatibility state; adjusted once per rejected parameter and kept for the run. */
  private sendTemperature = true;
  /** JSON-mode shape: strict schema first, then plain JSON-object mode, then nothing. */
  private responseFormat: "json_schema" | "json_object" | "none" = "json_schema";
  private tokenLimitParam: TokenLimitParam | undefined = "max_tokens";
  private droppedParams: DroppableRequestParam[] = [];

  constructor(
    baseUrl: string,
    apiKey: string,
    model: string,
    maxOutputTokens?: number,
    timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
    maxAttempts = DEFAULT_LLM_COMPLETION_ATTEMPTS,
    temperature = DEFAULT_LLM_TEMPERATURE,
    onProgress?: LlmProgressHandler,
    reasoningEffort?: string
  ) {
    this.model = model;
    this.temperature = temperature;
    this.routerModel = isOpenRouterRouterModel(model);
    this.onProgress = onProgress;
    this.reasoningEffort = reasoningEffort?.trim() || undefined;
    this.maxOutputTokens =
      maxOutputTokens && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
        ? maxOutputTokens
        : undefined;
    this.maxAttempts = getLlmCompletionAttemptCount(maxAttempts, model);
    const effectiveTimeoutMs = resolveLlmTimeoutMs(model, timeoutMs);

    const normalizedBaseUrl = normalizeLlmBaseUrl(baseUrl);
    this.provider = detectLlmProvider(normalizedBaseUrl);
    if (normalizedBaseUrl !== baseUrl.trim()) {
      core.info(`Normalized LLM base URL: ${baseUrl} -> ${normalizedBaseUrl}`);
    }

    core.info(
      `Initializing LLM client: baseUrl=${normalizedBaseUrl}, provider=${this.provider}, model=${model}, timeout=${effectiveTimeoutMs} ms, maxAttempts=${this.maxAttempts}, temperature=${this.temperature}`
    );

    // ponytail: chatCompletion owns retries; SDK maxRetries × 10-min timeout burned whole job budgets
    this.client = new OpenAI({
      baseURL: normalizedBaseUrl,
      apiKey: apiKey || "ollama",
      maxRetries: 0,
      timeout: effectiveTimeoutMs,
    });

    if (this.routerModel) {
      core.info(
        `OpenRouter router model — ${DEFAULT_LLM_ROUTER_FIRST_CHUNK_MS / 1000}s first-chunk stall detect, ${effectiveTimeoutMs / 1000}s stream cap, provider fallbacks.`
      );
    }

    if (isOpenAIReasoningModel(model)) {
      // o-series / GPT-5 / codex reject sampling controls and the legacy token cap outright.
      this.sendTemperature = false;
      this.tokenLimitParam = "max_completion_tokens";
      core.info(
        `OpenAI reasoning model detected — omitting temperature and using max_completion_tokens.`
      );
    }

    if (this.provider === "anthropic") {
      if (this.reasoningEffort) {
        core.info(
          "Anthropic's OpenAI-compatible endpoint ignores reasoning-effort controls; reasoning-effort is not sent. Claude decides its own thinking depth."
        );
      }
    }
  }

  /** Optional parameters the current request shape includes, in fallback-check order. */
  private sentDroppableParams(request: ChatRequest): DroppableRequestParam[] {
    const sent: DroppableRequestParam[] = [];
    if (request.temperature !== undefined) sent.push("temperature");
    if (request.max_tokens !== undefined) sent.push("max_tokens");
    if (request.max_completion_tokens !== undefined) sent.push("max_completion_tokens");
    if (request.response_format !== undefined) sent.push("response_format");
    return sent;
  }

  /**
   * Adjust the request shape once for a parameter the provider rejected. Returns true when
   * the request should be rebuilt and re-sent. Each parameter can trigger at most one
   * adjustment per client so normal retries are not multiplied.
   */
  private applyParameterFallback(error: unknown, request: ChatRequest): boolean {
    const param = findUnsupportedRequestParam(error, this.sentDroppableParams(request));
    if (!param) return false;
    // Anthropic accepts only schema-constrained JSON, so there is no plain JSON mode to step down to.
    if (param === "response_format" && this.responseFormat === "json_schema" && this.provider !== "anthropic") {
      this.responseFormat = "json_object";
      core.warning(
        `Provider rejected the JSON schema response_format (${errorMessage(error)}). Retrying once with plain JSON-object mode and keeping that shape for the rest of this run.`
      );
      return true;
    }
    if (this.droppedParams.includes(param)) return false;
    this.droppedParams.push(param);

    let action: string;
    switch (param) {
      case "temperature":
        this.sendTemperature = false;
        action = "omitting temperature (the model uses its default)";
        break;
      case "max_tokens":
        this.tokenLimitParam = "max_completion_tokens";
        action = "sending max_completion_tokens instead of max_tokens";
        break;
      case "max_completion_tokens":
        this.tokenLimitParam = undefined;
        action = "omitting the output token cap";
        break;
      case "response_format":
        this.responseFormat = "none";
        action = "omitting response_format (the review parser falls back to markdown)";
        break;
    }

    core.warning(
      `Provider rejected the ${param} parameter (${errorMessage(error)}). Retrying once ${action} and keeping that shape for the rest of this run.`
    );
    return true;
  }

  private retryContext() {
    return { model: this.model };
  }

  getReasoningFallbackReason(): ReasoningFallbackReason | undefined {
    return this.reasoningFallbackReason;
  }

  private async progress(detail: string): Promise<void> {
    if (!this.onProgress) return;
    try {
      await this.onProgress(detail);
    } catch (error) {
      core.warning(`LLM progress update failed (non-fatal): ${error}`);
    }
  }

  async chatCompletion(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode = false
  ): Promise<ChatCompletionResult> {
    return this.complete(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      { jsonResponseMode }
    );
  }

  /**
   * One turn of a tool-calling conversation. Returns the assistant text and any tool calls.
   * Throws ToolsUnsupportedError (without retrying) when the provider rejects `tools`.
   */
  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ToolChatOptions = {}
  ): Promise<ChatCompletionResult> {
    return this.complete(messages, {
      jsonResponseMode: false,
      tools,
      toolChoice: options.toolChoice,
    });
  }

  private async complete(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<ChatCompletionResult> {
    let lastFinishReason = "unknown";
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const useJson = shouldUseJsonResponseMode(attempt, options.jsonResponseMode);

      try {
        core.info(`LLM attempt ${attempt}/${this.maxAttempts}: waiting for provider...`);
        await this.progress(
          `Waiting for provider (attempt ${attempt}/${this.maxAttempts})…`
        );
        const result = await this.performRequest(messages, { ...options, jsonResponseMode: useJson });

        if (result.content || result.toolCalls?.length) {
          if (!this.routerModel) {
            this.logResolvedModel(result.model || this.model);
          }
          return result;
        }

        lastFinishReason = "empty";
        core.warning(
          `LLM attempt ${attempt}/${this.maxAttempts}: empty content${useJson ? " (json mode)" : ""}`
        );
      } catch (error) {
        lastError = error;
        if (options.tools && isToolsUnsupportedError(error)) {
          throw new ToolsUnsupportedError(error);
        }
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

  /**
   * One completion request. If the provider rejects an optional part of the request —
   * the reasoning control (unsupported or invalid value) or a parameter such as
   * `temperature` / `max_tokens` that newer models refuse — warn, adjust the request
   * shape once, and re-send. Every adjustment is one-shot and sticks for the rest of
   * the run, so the loop is bounded and normal retry attempts are not multiplied.
   */
  private async performRequest(
    messages: ChatMessage[],
    options: CompletionOptions
  ): Promise<ChatCompletionResult> {
    for (;;) {
      const request = this.buildMessagesRequest(messages, options);
      try {
        return await this.dispatch(request);
      } catch (error) {
        if (await this.applyReasoningFallback(error)) continue;
        if (this.applyParameterFallback(error, request)) continue;
        throw error;
      }
    }
  }

  private async applyReasoningFallback(error: unknown): Promise<boolean> {
    if (this.reasoningFallbackActive || !this.reasoningEffort || this.provider === "anthropic") {
      return false;
    }

    const fallbackReason = isUnsupportedReasoningEffortError(error, this.reasoningEffort)
      ? "unsupported"
      : isInvalidReasoningEffortError(error, this.reasoningEffort)
        ? "invalid-value"
        : undefined;
    if (!fallbackReason) return false;

    this.reasoningFallbackActive = true;
    this.reasoningFallbackReason = fallbackReason;
    core.warning(
      `Provider rejected the configured reasoning effort as ${fallbackReason === "invalid-value" ? "invalid" : "unsupported"} (${errorMessage(error)}). ` +
        "Retrying once without the reasoning parameter and continuing this run without reasoning controls."
    );
    await this.progress(
      fallbackReason === "invalid-value"
        ? "Provider rejected the configured reasoning effort — retrying without it…"
        : "Provider rejected reasoning controls — retrying without them…"
    );
    return true;
  }

  private async dispatch(request: ChatRequest): Promise<ChatCompletionResult> {
    return this.routerModel
      ? await this.streamChatCompletion(request)
      : await this.blockingChatCompletion(request);
  }

  private async blockingChatCompletion(request: ChatRequest): Promise<ChatCompletionResult> {
    const response = await this.client.chat.completions.create({
      ...(request as OpenAI.Chat.Completions.ChatCompletionCreateParams),
      stream: false,
    });
    const toolCalls = this.extractToolCalls(response);
    return {
      content: this.extractMessageContent(response, toolCalls.length > 0),
      model: response.model || this.model,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  /** Stream so the first SSE chunk (model id) proves OpenRouter routed; abort if none arrives. */
  private async streamChatCompletion(request: ChatRequest): Promise<ChatCompletionResult> {
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
        { ...(request as OpenAI.Chat.Completions.ChatCompletionCreateParams), stream: true },
        { signal: controller.signal }
      );

      const parts: string[] = [];
      const toolCallParts = new Map<number, ToolCall>();
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

        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === "string" && delta.content) {
          parts.push(delta.content);
        }
        for (const toolDelta of delta?.tool_calls ?? []) {
          const index = toolDelta.index ?? 0;
          const current = toolCallParts.get(index) ?? { id: "", name: "", arguments: "" };
          if (toolDelta.id) current.id = toolDelta.id;
          if (toolDelta.function?.name) current.name += toolDelta.function.name;
          if (toolDelta.function?.arguments) current.arguments += toolDelta.function.arguments;
          toolCallParts.set(index, current);
        }
        if (chunk.model) {
          resolvedModel = chunk.model;
        }
      }

      const toolCalls = [...toolCallParts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }))
        .filter((call) => call.name);
      return {
        content: parts.join(""),
        model: resolvedModel,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      };
    } catch (error) {
      clearStallTimer();
      if (!gotFirstChunk) {
        if ((request.tools && isToolsUnsupportedError(error)) || isContextLengthError(error)) {
          throw error;
        }
        // A 400/422 mentioning a reasoning request key or rejecting a parameter we sent is a
        // definitive client response, not a stalled router. Surface it even when the stricter
        // fallback classifiers reject it, so the provider's real validation error is not
        // replaced by a stall. Other failures keep the stall retry path.
        const status = Number((error as { status?: unknown })?.status);
        const mentionsReasoningObject = /\breasoning(?:[_-][\w.-]*)?\b/i.test(
          errorMessage(error)
        );
        const sentEffort = request.reasoning?.effort ?? request.reasoning_effort;
        if (
          sentEffort !== undefined &&
          (isUnsupportedReasoningEffortError(error, sentEffort) ||
            isInvalidReasoningEffortError(error, sentEffort) ||
            ((status === 400 || status === 422) && mentionsReasoningObject))
        ) {
          throw error;
        }
        if (findUnsupportedRequestParam(error, this.sentDroppableParams(request))) {
          throw error;
        }
        throw openRouterStallError(firstChunkMs);
      }
      throw error;
    }
  }

  private buildRequest(
    systemPrompt: string,
    userContent: string,
    jsonResponseMode: boolean
  ): ChatRequest {
    return this.buildMessagesRequest(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      { jsonResponseMode }
    );
  }

  private buildMessagesRequest(messages: ChatMessage[], options: CompletionOptions): ChatRequest {
    const request: ChatRequest = {
      model: this.model,
      messages,
    };

    if (this.sendTemperature) {
      request.temperature = this.temperature;
    }

    if (this.maxOutputTokens && this.tokenLimitParam) {
      request[this.tokenLimitParam] = this.maxOutputTokens;
    }

    if (options.tools?.length) {
      request.tools = options.tools;
      if (options.toolChoice) {
        request.tool_choice = options.toolChoice;
      }
    } else if (options.jsonResponseMode && this.responseFormat !== "none") {
      // Many providers reject response_format combined with tools, so JSON mode is single-shot only.
      request.response_format =
        this.responseFormat === "json_schema"
          ? {
              type: "json_schema",
              json_schema: { name: "robin_review", strict: true, schema: REVIEW_JSON_SCHEMA },
            }
          : { type: "json_object" };
    }

    if (this.reasoningEffort && !this.reasoningFallbackActive) {
      if (this.provider === "openai") {
        // OpenAI-native control; the OpenRouter object is rejected as an unknown argument.
        request.reasoning_effort = this.reasoningEffort;
      } else if (this.provider !== "anthropic") {
        // OpenRouter-style shape, also understood by many OpenAI-compatible gateways.
        // Anthropic's compatibility layer ignores reasoning controls, so nothing is sent there.
        request.reasoning = {
          effort: this.reasoningEffort,
          exclude: true,
        };
      }
    }

    if (this.routerModel) {
      // OpenRouter extension: try other providers when the first free route 404s.
      (request as ChatRequest & {
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

  private extractToolCalls(response: OpenAI.Chat.Completions.ChatCompletion): ToolCall[] {
    const calls = response.choices?.[0]?.message?.tool_calls ?? [];
    return calls
      .filter((call) => call?.function?.name)
      .map((call, index) => ({
        id: call.id || `call_${index}`,
        name: call.function.name,
        arguments: call.function.arguments || "",
      }));
  }

  private extractMessageContent(
    response: OpenAI.Chat.Completions.ChatCompletion,
    hasToolCalls = false
  ): string {
    const choice = response.choices?.[0];
    if (!choice) {
      core.warning("LLM response has no choices array.");
      return "";
    }

    const content = choice.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }
    if (hasToolCalls) {
      return "";
    }

    core.warning(
      `LLM choice has no text content (finish_reason=${choice.finish_reason || "unknown"}).`
    );
    return "";
  }
}
