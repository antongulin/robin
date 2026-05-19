"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LLMClient = void 0;
const openai_1 = require("openai");
const config_1 = require("./config");
const core = __importStar(require("@actions/core"));
class LLMClient {
    client;
    model;
    maxOutputTokens;
    constructor(baseUrl, apiKey, model, maxOutputTokens, timeoutMs = config_1.DEFAULT_LLM_TIMEOUT_MS) {
        core.info(`Initializing LLM client: baseUrl=${baseUrl}, model=${model}, timeout=${timeoutMs} ms`);
        this.client = new openai_1.OpenAI({
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
    async chatCompletion(systemPrompt, userContent, jsonResponseMode = false) {
        try {
            const request = {
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
            }
            else {
                core.info(`LLM response model: ${resolvedModel}`);
            }
            if (!content) {
                const finishReason = response.choices?.[0]?.finish_reason || "unknown";
                throw new Error(`Empty response from LLM (finish_reason=${finishReason})`);
            }
            return { content, model: resolvedModel };
        }
        catch (error) {
            core.error(`LLM API error: ${error}`);
            throw new Error(`Failed to get response from LLM: ${error}`);
        }
    }
    extractMessageContent(response) {
        const choice = response.choices?.[0];
        if (!choice) {
            core.warning("LLM response has no choices array.");
            return "";
        }
        const content = choice.message?.content;
        if (typeof content === "string" && content.trim()) {
            return content;
        }
        core.warning(`LLM choice has no text content (finish_reason=${choice.finish_reason || "unknown"}).`);
        return "";
    }
}
exports.LLMClient = LLMClient;
//# sourceMappingURL=llm-client.js.map