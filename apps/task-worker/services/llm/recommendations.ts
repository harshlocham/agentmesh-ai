import type { LLMProviderConfig } from "./types.js";

export type LLMTaskProfile = "planner" | "reflection" | "decision" | "json" | "retry";

export type ProviderRecommendation = {
    provider: LLMProviderConfig["provider"];
    transport: LLMProviderConfig["transport"];
    reason: string;
    fallbackProvider?: LLMProviderConfig["provider"];
};

export function recommendProviderForTask(profile: LLMTaskProfile, config?: Partial<LLMProviderConfig>): ProviderRecommendation {
    const provider = config?.provider ?? "openai-compatible";

    if (profile === "planner") {
        return {
            provider,
            transport: config?.transport ?? "openai-compatible",
            reason: "Use the most instruction-following provider available for planning and step decomposition.",
            fallbackProvider: "huggingface",
        };
    }

    if (profile === "reflection") {
        return {
            provider,
            transport: config?.transport ?? "openai-compatible",
            reason: "Reflection is tolerant of slightly slower models; use a provider with stable JSON extraction.",
            fallbackProvider: "huggingface",
        };
    }

    if (profile === "json") {
        return {
            provider,
            transport: config?.transport ?? "openai-compatible",
            reason: "Prefer a provider with chat-completions fallback and parser repair for structured JSON.",
            fallbackProvider: "openai-compatible",
        };
    }

    if (profile === "retry") {
        return {
            provider: "huggingface",
            transport: "inference-api",
            reason: "Use a low-cost model for short retry attempts or lightweight repair passes.",
            fallbackProvider: "openai-compatible",
        };
    }

    return {
        provider,
        transport: config?.transport ?? "openai-compatible",
        reason: "Default to the configured provider while preserving the current orchestration path.",
        fallbackProvider: "huggingface",
    };
}