import { BaseLLMProvider } from "../base-provider.js";
import { LLMError, type LLMGenerateOptions, type LLMHealthCheckResult, type LLMProviderConfig, type LLMRequest, type LLMResponse } from "../types.js";
import { OpenAIProvider } from "./openai-provider.js";

function estimateUsage(text: string): { inputTokens: number; outputTokens: number; totalTokens: number } {
    const estimated = Math.max(1, Math.ceil(text.length / 4));
    return {
        inputTokens: estimated,
        outputTokens: estimated,
        totalTokens: estimated * 2,
    };
}

function normalizeModelResponse(payload: unknown): string {
    if (typeof payload === "string") return payload;
    if (Array.isArray(payload)) {
        for (const item of payload) {
            if (!item || typeof item !== "object") continue;
            const record = item as Record<string, unknown>;
            const generatedText = record.generated_text;
            if (typeof generatedText === "string" && generatedText.trim().length > 0) {
                return generatedText;
            }
            const content = record.content;
            if (typeof content === "string" && content.trim().length > 0) {
                return content;
            }
        }
    }

    if (payload && typeof payload === "object") {
        const record = payload as Record<string, unknown>;
        if (typeof record.generated_text === "string") return record.generated_text;
        if (typeof record.text === "string") return record.text;
        if (typeof record.content === "string") return record.content;
        if (Array.isArray(record.choices) && record.choices.length > 0) {
            const first = record.choices[0] as Record<string, unknown> | undefined;
            const message = first?.message as Record<string, unknown> | undefined;
            if (typeof message?.content === "string") return message.content;
        }
    }

    return "";
}

export class HuggingFaceProvider extends BaseLLMProvider {
    private readonly openAiCompatibleProvider?: OpenAIProvider;

    constructor(config: LLMProviderConfig) {
        if (!config.apiKey) {
            throw new LLMError({
                message: "Hugging Face API key is missing",
                code: "LLM_CONFIG_ERROR",
                provider: config.provider,
                retryable: false,
            });
        }

        super(config);

        if (config.transport === "openai-compatible") {
            this.openAiCompatibleProvider = new OpenAIProvider({
                ...config,
                provider: "huggingface",
                supportsResponsesApi: config.supportsResponsesApi ?? true,
            });
        }
    }

    override supportsResponsesApi(): boolean {
        return this.config.transport === "openai-compatible" ? (this.config.supportsResponsesApi ?? true) : false;
    }

    override supportsStructuredOutputs(): boolean {
        return this.config.transport === "openai-compatible"
            ? (this.config.supportsStructuredOutputs ?? true)
            : false;
    }

    override supportsToolCalling(): boolean {
        return this.config.transport === "openai-compatible"
            ? (this.config.supportsToolCalling ?? true)
            : false;
    }

    override supportsStreaming(): boolean {
        return this.config.supportsStreaming ?? this.config.transport === "openai-compatible";
    }

    override supportsJsonMode(): boolean {
        return this.config.transport === "openai-compatible"
            ? (this.config.supportsJsonMode ?? true)
            : false;
    }

    async generate(request: LLMRequest, options?: LLMGenerateOptions): Promise<LLMResponse> {
        const startedAt = Date.now();
        this.recordMetric({ provider: this.config.provider, event: "request" });

        if (this.openAiCompatibleProvider) {
            const response = await this.openAiCompatibleProvider.generate(request, options);
            if (!response.output_text) {
                this.recordMetric({ provider: this.config.provider, event: "malformed_response" });
            }
            return {
                ...response,
                provider: this.config.provider,
                responseFormat: response.responseFormat ?? "normalized",
            };
        }

        const requestId = options?.requestId ?? (request.metadata?.requestId as string | undefined) ?? `hf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const timeoutMs = this.resolveTimeoutMs(options);
        const abortController = new AbortController();
        const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
        const signal = options?.signal
            ? (AbortSignal.any?.([options.signal, abortController.signal]) ?? abortController.signal)
            : abortController.signal;

        const model = this.config.model ?? request.model;
        const prompt = typeof request.input === "string"
            ? request.input
            : request.input.map((message) => `${message.role}: ${message.content}`).join("\n");

        try {
            const endpoint = (this.config.baseUrl && !this.config.baseUrl.endsWith("/v1"))
                ? this.config.baseUrl.replace(/\/$/, "")
                : `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`;

            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.config.apiKey}`,
                    ...(this.config.defaultHeaders || {}),
                },
                body: JSON.stringify({
                    inputs: prompt,
                    parameters: {
                        max_new_tokens: request.maxOutputTokens ?? 512,
                        temperature: request.temperature ?? 0.2,
                        top_p: request.topP ?? 0.95,
                        return_full_text: false,
                    },
                }),
                signal,
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => "");
                throw new LLMError({
                    message: errorText || `Hugging Face request failed with status ${response.status}`,
                    code: `HTTP_${response.status}`,
                    provider: this.config.provider,
                    status: response.status,
                    retryable: response.status === 429 || response.status >= 500,
                    category:
                        response.status === 401 || response.status === 403
                            ? "auth"
                            : response.status === 429
                                ? "rate_limit"
                                : response.status >= 500
                                    ? "retryable"
                                    : "non_retryable",
                    details: errorText,
                });
            }

            const payload = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
            const outputText = normalizeModelResponse(payload);
            const usage = estimateUsage(outputText);

            const llmResponse: LLMResponse = {
                model,
                provider: this.config.provider,
                output_text: outputText || undefined,
                output: payload,
                usage,
                raw: payload,
                requestId,
                finishReason: outputText ? "stop" : null,
                responseFormat: "normalized",
                parseRepaired: false,
            };

            if (!llmResponse.output_text) {
                this.recordMetric({ provider: this.config.provider, event: "malformed_response" });
            }

            this.recordMetric({ provider: this.config.provider, event: "success", latencyMs: Date.now() - startedAt });
            return llmResponse;
        } catch (error) {
            const normalized = LLMError.fromUnknown(error, {
                provider: this.config.provider,
                retryable: true,
            });

            if (normalized.category === "timeout") {
                this.recordMetric({ provider: this.config.provider, event: "timeout" });
            }

            throw normalized;
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    async healthCheck(): Promise<LLMHealthCheckResult> {
        const startedAt = Date.now();

        try {
            if (this.openAiCompatibleProvider) {
                const health = await this.openAiCompatibleProvider.healthCheck();
                return { ...health, provider: this.config.provider };
            }

            const model = this.config.model;
            if (!model) {
                return { ok: false, provider: this.config.provider, latencyMs: Date.now() - startedAt, error: "HUGGINGFACE_MODEL not configured" };
            }

            const endpoint = (this.config.baseUrl && !this.config.baseUrl.endsWith("/v1"))
                ? this.config.baseUrl.replace(/\/$/, "")
                : `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`;

            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${this.config.apiKey}`,
                },
                body: JSON.stringify({ inputs: "health-check", parameters: { max_new_tokens: 1, temperature: 0 } }),
            });

            return {
                ok: response.ok,
                provider: this.config.provider,
                latencyMs: Date.now() - startedAt,
                model,
                error: response.ok ? undefined : `HTTP_${response.status}`,
            };
        } catch (error) {
            return {
                ok: false,
                provider: this.config.provider,
                latencyMs: Date.now() - startedAt,
                model: this.config.model,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}