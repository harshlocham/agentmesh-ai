export type LLMInputMessage = {
    role: "assistant" | "system" | "user";
    content: string;
};

export type LLMInput = string | LLMInputMessage[];

export interface LLMRequest {
    model: string;
    input: LLMInput;
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    metadata?: Record<string, unknown>;
}

export interface LLMUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
}

export interface LLMResponse {
    model: string;
    provider: string;
    output_text?: string;
    output?: unknown;
    usage?: LLMUsage;
    raw?: unknown;
    requestId?: string;
    finishReason?: string | null;
    responseFormat?: "responses" | "chat_completions" | "normalized";
    parseRepaired?: boolean;
}

export interface LLMProviderConfig {
    provider: "openai" | "openai-compatible" | "huggingface" | "amd-openai-compatible";
    apiKey: string;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    logRequests?: boolean;
    defaultHeaders?: Record<string, string>;
    providerProfile?: string;
    providerDisplayName?: string;
    transport?: "openai-compatible" | "inference-api";
    supportsResponsesApi?: boolean;
    supportsStructuredOutputs?: boolean;
    supportsToolCalling?: boolean;
    supportsStreaming?: boolean;
    supportsJsonMode?: boolean;
}

export interface LLMGenerateOptions {
    requestId?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    metadata?: Record<string, unknown>;
}

export class LLMError extends Error {
    readonly code: string;
    readonly provider?: string;
    readonly status?: number;
    readonly retryable: boolean;
    readonly category:
        | "retryable"
        | "non_retryable"
        | "timeout"
        | "rate_limit"
        | "auth"
        | "malformed_response"
        | "unsupported_capability";
    readonly details?: unknown;

    constructor(input: {
        message: string;
        code?: string;
        provider?: string;
        status?: number;
        retryable?: boolean;
        category?: LLMError["category"];
        details?: unknown;
        cause?: unknown;
    }) {
        super(input.message, input.cause ? { cause: input.cause as Error } : undefined);
        this.name = "LLMError";
        this.code = input.code ?? "LLM_ERROR";
        this.provider = input.provider;
        this.status = input.status;
        this.retryable = input.retryable ?? false;
        this.category = input.category ?? (input.retryable ? "retryable" : "non_retryable");
        this.details = input.details;
    }

    static fromUnknown(error: unknown, overrides: Partial<Pick<LLMError, "code" | "provider" | "status" | "retryable">> & {
        message?: string;
        details?: unknown;
    } = {}): LLMError {
        if (error instanceof LLMError) {
            return error;
        }

        if (error instanceof Error) {
            const status = overrides.status ?? (error as Error & { status?: number }).status;
            const code = overrides.code ?? (typeof (error as Error & { code?: string }).code === "string" ? (error as Error & { code?: string }).code : undefined);

            return new LLMError({
                message: overrides.message ?? error.message,
                code: code ?? "LLM_ERROR",
                provider: overrides.provider,
                status,
                retryable: overrides.retryable ?? (status === 429 || (typeof status === "number" && status >= 500)),
                category:
                    status === 401 || status === 403
                        ? "auth"
                        : status === 429
                            ? "rate_limit"
                            : status === 408
                                ? "timeout"
                                : (overrides.retryable ?? (status === 429 || (typeof status === "number" && status >= 500)))
                                    ? "retryable"
                                    : "non_retryable",
                details: overrides.details,
                cause: error,
            });
        }

        return new LLMError({
            message: overrides.message ?? String(error),
            code: overrides.code ?? "LLM_ERROR",
            provider: overrides.provider,
            status: overrides.status,
            retryable: overrides.retryable ?? false,
            category: overrides.retryable ? "retryable" : "non_retryable",
            details: overrides.details ?? error,
            cause: error,
        });
    }
}

export interface LLMHealthCheckResult {
    ok: boolean;
    provider: string;
    latencyMs: number;
    model?: string;
    error?: string;
}

export interface LLMProviderMetricSnapshot {
    provider: string;
    requestCount: number;
    successCount: number;
    timeoutCount: number;
    fallbackCount: number;
    malformedResponseCount: number;
    repairCount: number;
    totalLatencyMs: number;
    lastRequestAt?: string;
}

export interface LLMProviderStartupReport {
    provider: string;
    model?: string;
    ok: boolean;
    reachable: boolean;
    authPresent: boolean;
    modelConfigured: boolean;
    endpointShapeValid: boolean;
    responseFormat?: string;
    error?: string;
}