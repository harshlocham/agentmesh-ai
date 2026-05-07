import type { LLMGenerateOptions, LLMHealthCheckResult, LLMProviderConfig, LLMRequest, LLMResponse } from "./types.js";

export abstract class BaseLLMProvider {
    protected readonly config: LLMProviderConfig;

    constructor(config: LLMProviderConfig) {
        this.config = config;
    }

    abstract generate(request: LLMRequest, options?: LLMGenerateOptions): Promise<LLMResponse>;
    abstract healthCheck(): Promise<LLMHealthCheckResult>;
    abstract supportsStructuredOutputs(): boolean;
    abstract supportsToolCalling(): boolean;

    protected getDefaultTimeoutMs(): number {
        return this.config.timeoutMs ?? 30_000;
    }

    protected resolveTimeoutMs(options?: LLMGenerateOptions): number {
        return options?.timeoutMs ?? this.config.timeoutMs ?? 30_000;
    }

    protected shouldLogRequests(): boolean {
        return this.config.logRequests ?? process.env.LLM_LOG_REQUESTS !== "false";
    }
}