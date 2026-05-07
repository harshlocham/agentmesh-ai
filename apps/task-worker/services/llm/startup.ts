import type { BaseLLMProvider } from "./base-provider.js";
import type { LLMProviderStartupReport } from "./types.js";

export async function validateLLMProviderStartup(provider: BaseLLMProvider, input: {
    provider: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
}): Promise<LLMProviderStartupReport> {
    const authPresent = Boolean(input.apiKey);
    const modelConfigured = Boolean(input.model);

    if (!authPresent || !modelConfigured) {
        return {
            provider: input.provider,
            model: input.model,
            ok: false,
            reachable: false,
            authPresent,
            modelConfigured,
            endpointShapeValid: Boolean(input.baseUrl || input.provider === "openai"),
            error: !authPresent ? "API key missing" : "Model not configured",
        };
    }

    try {
        const health = await provider.healthCheck();
        return {
            provider: input.provider,
            model: input.model,
            ok: health.ok && authPresent && modelConfigured,
            reachable: health.ok,
            authPresent,
            modelConfigured,
            endpointShapeValid: Boolean(input.baseUrl || input.provider === "openai"),
            responseFormat: health.ok ? "validated" : undefined,
            error: health.error,
        };
    } catch (error) {
        return {
            provider: input.provider,
            model: input.model,
            ok: false,
            reachable: false,
            authPresent,
            modelConfigured,
            endpointShapeValid: Boolean(input.baseUrl || input.provider === "openai"),
            error: error instanceof Error ? error.message : String(error),
        };
    }
}