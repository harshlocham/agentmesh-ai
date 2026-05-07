import OpenAI from "openai";
import type { LLMGenerateOptions, LLMHealthCheckResult, LLMProviderConfig, LLMRequest, LLMResponse, LLMUsage } from "../types.js";
import { BaseLLMProvider } from "../base-provider.js";
import { LLMError } from "../types.js";
import { extractResponseText } from "../response-parser.js";

function createTimeoutError(provider: string, timeoutMs: number, requestId?: string) {
    return new LLMError({
        message: `LLM request timed out after ${timeoutMs}ms`,
        code: "LLM_TIMEOUT",
        provider,
        retryable: true,
        details: { requestId, timeoutMs },
    });
}

function toUsage(payload: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined): LLMUsage | undefined {
    if (!payload) {
        return undefined;
    }

    return {
        inputTokens: payload.input_tokens,
        outputTokens: payload.output_tokens,
        totalTokens: payload.total_tokens,
    };
}

function toChatMessages(input: LLMRequest["input"]): Array<{ role: "assistant" | "system" | "user"; content: string }> {
    if (typeof input === "string") {
        return [{ role: "user", content: input }];
    }

    return input;
}

export class OpenAIProvider extends BaseLLMProvider {
    private readonly client: Pick<OpenAI, "responses" | "chat" | "models">;

    constructor(config: LLMProviderConfig, client?: Pick<OpenAI, "responses" | "chat" | "models">) {
        if (!config.apiKey) {
            throw new LLMError({
                message: "LLM provider API key is missing",
                code: "LLM_CONFIG_ERROR",
                provider: config.provider,
                retryable: false,
            });
        }

        super(config);

        this.client = client ?? new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
            defaultHeaders: config.defaultHeaders,
        });
    }

    override supportsStructuredOutputs(): boolean {
        return this.config.supportsStructuredOutputs ?? true;
    }

    override supportsToolCalling(): boolean {
        return this.config.supportsToolCalling ?? true;
    }

    override supportsStreaming(): boolean {
        return this.config.supportsStreaming ?? true;
    }

    override supportsResponsesApi(): boolean {
        return this.config.supportsResponsesApi ?? true;
    }

    override supportsJsonMode(): boolean {
        return this.config.supportsJsonMode ?? true;
    }

    private normalizeResponse(response: unknown, request: LLMRequest, requestId: string, responseFormat: NonNullable<LLMResponse["responseFormat"]>): LLMResponse {
        const rawResponse = response as Record<string, unknown>;
        const normalizedSource: LLMResponse = {
            model: request.model,
            provider: this.config.provider,
            output_text: typeof rawResponse.output_text === "string" ? rawResponse.output_text : undefined,
            output: rawResponse.output ?? rawResponse.choices ?? response,
            raw: response,
            requestId,
            responseFormat,
        };

        const extracted = extractResponseText(normalizedSource);
        const usage = toUsage((rawResponse.usage as { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined) ?? undefined);

        return {
            model: request.model,
            provider: this.config.provider,
            output_text: extracted.text || undefined,
            output: rawResponse.output ?? rawResponse.choices ?? response,
            usage,
            raw: response,
            requestId: typeof rawResponse.id === "string" ? rawResponse.id : requestId,
            finishReason: typeof rawResponse.finish_reason === "string"
                ? rawResponse.finish_reason
                : typeof rawResponse.status === "string"
                    ? rawResponse.status
                    : null,
            responseFormat: extracted.responseFormat,
            parseRepaired: extracted.parseRepaired,
        };
    }

    async generate(request: LLMRequest, options?: LLMGenerateOptions): Promise<LLMResponse> {
        const requestId = options?.requestId ?? (request.metadata?.requestId as string | undefined) ?? `llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const startedAt = Date.now();
        const timeoutMs = this.resolveTimeoutMs(options);
        const abortController = new AbortController();
        const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
        const signal = options?.signal
            ? (AbortSignal.any?.([options.signal, abortController.signal]) ?? abortController.signal)
            : abortController.signal;

        if (this.shouldLogRequests()) {
            console.info("llm:request", {
                provider: this.config.provider,
                model: request.model,
                requestId,
                timeoutMs,
                inputType: Array.isArray(request.input) ? "messages" : "text",
            });
        }

        this.recordMetric({ provider: this.config.provider, event: "request" });

        try {
            let responseFormat: NonNullable<LLMResponse["responseFormat"]> = "responses";
            let response: unknown;

            if (this.supportsResponsesApi()) {
                try {
                    response = await this.client.responses.create(
                        {
                            model: request.model,
                            input: request.input as never,
                            temperature: request.temperature,
                            top_p: request.topP,
                            max_output_tokens: request.maxOutputTokens,
                        },
                        { signal } as never
                    );
                } catch (error) {
                    const retryableFallback = error instanceof Error && (/404|405|unsupported|not found/i.test(error.message));
                    if (!retryableFallback) {
                        throw error;
                    }

                    responseFormat = "chat_completions";
                    this.recordMetric({ provider: this.config.provider, event: "fallback" });
                    response = await this.client.chat.completions.create(
                        {
                            model: request.model,
                            messages: toChatMessages(request.input),
                            temperature: request.temperature,
                            top_p: request.topP,
                            max_tokens: request.maxOutputTokens,
                        },
                        { signal } as never
                    );
                }
            } else {
                responseFormat = "chat_completions";
                this.recordMetric({ provider: this.config.provider, event: "fallback" });
                response = await this.client.chat.completions.create(
                    {
                        model: request.model,
                        messages: toChatMessages(request.input),
                        temperature: request.temperature,
                        top_p: request.topP,
                        max_tokens: request.maxOutputTokens,
                    },
                    { signal } as never
                );
            }

            const llmResponse = this.normalizeResponse(response, request, requestId, responseFormat);

            if (!llmResponse.output_text && llmResponse.responseFormat !== "chat_completions") {
                const chatResponse = await this.client.chat.completions.create(
                    {
                        model: request.model,
                        messages: toChatMessages(request.input),
                        temperature: request.temperature,
                        top_p: request.topP,
                        max_tokens: request.maxOutputTokens,
                    },
                    { signal } as never
                );

                const chatNormalized = this.normalizeResponse(chatResponse, request, requestId, "chat_completions");
                if (chatNormalized.output_text) {
                    this.recordMetric({ provider: this.config.provider, event: "fallback" });
                    return chatNormalized;
                }
            }

            if (this.shouldLogRequests()) {
                console.info("llm:response", {
                    provider: this.config.provider,
                    model: request.model,
                    requestId: llmResponse.requestId,
                    responseFormat: llmResponse.responseFormat,
                    hasOutputText: Boolean(llmResponse.output_text),
                    parseRepaired: llmResponse.parseRepaired ?? false,
                    usage: llmResponse.usage,
                });
            }

            if (!llmResponse.output_text) {
                this.recordMetric({ provider: this.config.provider, event: "malformed_response" });
            }

            this.recordMetric({ provider: this.config.provider, event: "success", latencyMs: Date.now() - startedAt });

            return llmResponse;
        } catch (error) {
            const normalized = this.normalizeError(error, requestId, timeoutMs);

            if (normalized.category === "timeout") {
                this.recordMetric({ provider: this.config.provider, event: "timeout" });
            }

            if (this.shouldLogRequests()) {
                console.info("llm:error", {
                    provider: this.config.provider,
                    model: request.model,
                    requestId,
                    timeoutMs,
                    code: normalized.code,
                    category: normalized.category,
                    retryable: normalized.retryable,
                    message: normalized.message,
                });
            }

            throw normalized;
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    async healthCheck(): Promise<LLMHealthCheckResult> {
        const startedAt = Date.now();

        try {
            await this.client.models.list();

            return {
                ok: true,
                provider: this.config.provider,
                latencyMs: Date.now() - startedAt,
                model: this.config.model,
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

    private normalizeError(error: unknown, requestId: string, timeoutMs: number): LLMError {
        if (error instanceof LLMError) {
            return error;
        }

        const asError = error as {
            status?: number;
            code?: string;
            message?: string;
            name?: string;
        };

        if (asError?.name === "AbortError" || /abort|timed out/i.test(asError?.message ?? "")) {
            return createTimeoutError(this.config.provider, timeoutMs, requestId);
        }

        const status = typeof asError?.status === "number" ? asError.status : undefined;
        const retryable = status === 429 || (typeof status === "number" && status >= 500) || asError?.name === "APIConnectionError";

        return new LLMError({
            message: asError?.message ?? "LLM request failed",
            code: asError?.code ?? (typeof status === "number" ? `HTTP_${status}` : "LLM_REQUEST_FAILED"),
            provider: this.config.provider,
            status,
            retryable,
            category:
                status === 401 || status === 403
                    ? "auth"
                    : status === 429
                        ? "rate_limit"
                        : /unsupported|capability/i.test(asError?.message ?? "")
                            ? "unsupported_capability"
                            : /json|parse|malformed/i.test(asError?.message ?? "")
                                ? "malformed_response"
                                : retryable
                                    ? "retryable"
                                    : "non_retryable",
            details: error,
            cause: error,
        });
    }
}