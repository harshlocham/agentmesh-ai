import OpenAI from "openai";
import type { LLMGenerateOptions, LLMHealthCheckResult, LLMProviderConfig, LLMRequest, LLMResponse, LLMUsage } from "../types.js";
import { BaseLLMProvider } from "../base-provider.js";
import { LLMError } from "../types.js";

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

export class OpenAIProvider extends BaseLLMProvider {
    private readonly client: OpenAI;

    constructor(config: LLMProviderConfig) {
        if (!config.apiKey) {
            throw new LLMError({
                message: "LLM provider API key is missing",
                code: "LLM_CONFIG_ERROR",
                provider: config.provider,
                retryable: false,
            });
        }

        super(config);

        this.client = new OpenAI({
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

    async generate(request: LLMRequest, options?: LLMGenerateOptions): Promise<LLMResponse> {
        const requestId = options?.requestId ?? (request.metadata?.requestId as string | undefined) ?? `llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

        try {
            const response = await this.client.responses.create(
                {
                    model: request.model,
                    input: request.input as never,
                    temperature: request.temperature,
                    top_p: request.topP,
                    max_output_tokens: request.maxOutputTokens,
                },
                { signal } as never
            );

            const outputText = typeof response.output_text === "string" ? response.output_text : undefined;
            const usage = toUsage((response as { usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }).usage);

            const llmResponse: LLMResponse = {
                model: request.model,
                provider: this.config.provider,
                output_text: outputText,
                output: response.output,
                usage,
                raw: response,
                requestId: typeof response.id === "string" ? response.id : requestId,
                finishReason: typeof (response as { status?: string }).status === "string" ? (response as { status?: string }).status : null,
            };

            if (this.shouldLogRequests()) {
                console.info("llm:response", {
                    provider: this.config.provider,
                    model: request.model,
                    requestId: llmResponse.requestId,
                    hasOutputText: Boolean(llmResponse.output_text),
                    usage: llmResponse.usage,
                });
            }

            return llmResponse;
        } catch (error) {
            throw this.normalizeError(error, requestId, timeoutMs);
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

        if (asError?.name === "AbortError") {
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
            details: error,
            cause: error,
        });
    }
}