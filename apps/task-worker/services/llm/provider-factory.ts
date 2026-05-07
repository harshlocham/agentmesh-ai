import { BaseLLMProvider } from "./base-provider.js";
import { HuggingFaceProvider } from "./providers/huggingface-provider.js";
import { OpenAIProvider } from "./providers/openai-provider.js";
import { LLMError, type LLMProviderConfig, type LLMProviderStartupReport } from "./types.js";
import { recommendProviderForTask, type LLMTaskProfile, type ProviderRecommendation } from "./recommendations.js";
import { validateLLMProviderStartup } from "./startup.js";

function parseTimeoutMs(value: string | undefined, fallback: number): number {
    const parsed = value ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    return value === "true" || value === "1";
}

function providerLogName(provider: LLMProviderConfig["provider"]): string {
    return provider;
}

function buildConfig(): LLMProviderConfig {
    const provider = (process.env.LLM_PROVIDER || process.env.TASK_LLM_PROVIDER || "openai").toLowerCase();
    const apiKey = process.env.OPENAI_API_KEY || process.env.HUGGINGFACE_API_KEY || process.env.AMD_API_KEY || process.env.LLM_API_KEY || "";
    const baseUrl = process.env.OPENAI_BASE_URL || process.env.HUGGINGFACE_BASE_URL || process.env.AMD_BASE_URL || process.env.LLM_BASE_URL;
    const timeoutMs = parseTimeoutMs(process.env.LLM_REQUEST_TIMEOUT_MS, 30_000);
    const logRequests = process.env.LLM_LOG_REQUESTS !== "false";
    const model = process.env.TASK_AGENT_MODEL || process.env.LLM_MODEL || process.env.HUGGINGFACE_MODEL || "gpt-4o-mini";
    const providerName = provider === "openai-compatible"
        ? "openai-compatible"
        : provider === "huggingface"
            ? "huggingface"
            : provider === "amd-openai-compatible"
                ? "amd-openai-compatible"
                : "openai";

    const supportsResponsesApi = parseBool(process.env.LLM_SUPPORTS_RESPONSES_API, providerName !== "amd-openai-compatible" && providerName !== "huggingface");
    const transport = providerName === "huggingface"
        ? (parseBool(process.env.HUGGINGFACE_OPENAI_COMPATIBLE, Boolean(baseUrl?.endsWith("/v1"))) ? "openai-compatible" : "inference-api")
        : "openai-compatible";

    return {
        provider: providerName,
        apiKey,
        baseUrl,
        timeoutMs,
        logRequests,
        model,
        providerProfile: process.env.LLM_PROVIDER_PROFILE || providerName,
        providerDisplayName: providerLogName(providerName),
        transport,
        supportsResponsesApi,
        supportsStructuredOutputs: process.env.LLM_SUPPORTS_STRUCTURED_OUTPUTS !== "false",
        supportsToolCalling: parseBool(process.env.LLM_SUPPORTS_TOOL_CALLING, providerName !== "huggingface"),
        supportsStreaming: parseBool(process.env.LLM_SUPPORTS_STREAMING, true),
        supportsJsonMode: parseBool(process.env.LLM_SUPPORTS_JSON_MODE, providerName !== "huggingface"),
    };
}

function applyProviderDefaults(config: LLMProviderConfig, overrides: Partial<LLMProviderConfig>): LLMProviderConfig {
    if (config.provider === "huggingface") {
        return {
            ...config,
            transport: overrides.transport ?? config.transport ?? (config.baseUrl?.endsWith("/v1") ? "openai-compatible" : "inference-api"),
            supportsResponsesApi: overrides.supportsResponsesApi ?? false,
            supportsStructuredOutputs: overrides.supportsStructuredOutputs ?? false,
            supportsToolCalling: overrides.supportsToolCalling ?? false,
            supportsJsonMode: overrides.supportsJsonMode ?? false,
        };
    }

    if (config.provider === "amd-openai-compatible") {
        return {
            ...config,
            supportsResponsesApi: overrides.supportsResponsesApi ?? false,
            supportsJsonMode: overrides.supportsJsonMode ?? false,
        };
    }

    return config;
}

export function createLLMProvider(config: Partial<LLMProviderConfig> = {}): BaseLLMProvider {
    const resolved = applyProviderDefaults({
        ...buildConfig(),
        ...config,
    } as LLMProviderConfig, config);

    switch (resolved.provider) {
        case "openai":
        case "openai-compatible":
        case "amd-openai-compatible":
            return new OpenAIProvider(resolved);
        case "huggingface":
            return new HuggingFaceProvider(resolved);
        default:
            throw new LLMError({
                message: `Unsupported LLM provider: ${resolved.provider}`,
                code: "LLM_PROVIDER_NOT_SUPPORTED",
                provider: resolved.provider,
                retryable: false,
            });
    }
}

export function createDefaultLLMProvider(): BaseLLMProvider {
    return createLLMProvider();
}

export function recommendProviderForTaskProfile(profile: LLMTaskProfile, config?: Partial<LLMProviderConfig>): ProviderRecommendation {
    return recommendProviderForTask(profile, config);
}

export async function validateProviderStartup(config: Partial<LLMProviderConfig> = {}): Promise<LLMProviderStartupReport> {
    const resolved = applyProviderDefaults({ ...buildConfig(), ...config } as LLMProviderConfig, config);

    let provider: BaseLLMProvider;

    try {
        provider = createLLMProvider(config);
    } catch (error) {
        return {
            provider: resolved.provider,
            model: resolved.model,
            ok: false,
            reachable: false,
            authPresent: Boolean(resolved.apiKey),
            modelConfigured: Boolean(resolved.model),
            endpointShapeValid: Boolean(resolved.baseUrl || resolved.provider === "openai"),
            error: error instanceof Error ? error.message : String(error),
        };
    }

    return validateLLMProviderStartup(provider, {
        provider: resolved.provider,
        model: resolved.model,
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
    });
}