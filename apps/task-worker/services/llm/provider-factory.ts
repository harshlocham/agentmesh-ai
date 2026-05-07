import { BaseLLMProvider } from "./base-provider.js";
import { OpenAIProvider } from "./providers/openai-provider.js";
import { LLMError, type LLMProviderConfig } from "./types.js";

function parseTimeoutMs(value: string | undefined, fallback: number): number {
    const parsed = value ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildConfig(): LLMProviderConfig {
    const provider = (process.env.LLM_PROVIDER || process.env.TASK_LLM_PROVIDER || "openai").toLowerCase();
    const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "";
    const baseUrl = process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL;
    const timeoutMs = parseTimeoutMs(process.env.LLM_REQUEST_TIMEOUT_MS, 30_000);
    const logRequests = process.env.LLM_LOG_REQUESTS !== "false";
    const model = process.env.TASK_AGENT_MODEL || process.env.LLM_MODEL || "gpt-4o-mini";

    return {
        provider: provider === "openai-compatible" ? "openai-compatible" : "openai",
        apiKey,
        baseUrl,
        timeoutMs,
        logRequests,
        model,
        supportsStructuredOutputs: process.env.LLM_SUPPORTS_STRUCTURED_OUTPUTS !== "false",
        supportsToolCalling: process.env.LLM_SUPPORTS_TOOL_CALLING !== "false",
        supportsStreaming: process.env.LLM_SUPPORTS_STREAMING !== "false",
        supportsJsonMode: process.env.LLM_SUPPORTS_JSON_MODE !== "false",
    };
}

export function createLLMProvider(config: Partial<LLMProviderConfig> = {}): BaseLLMProvider {
    const resolved = {
        ...buildConfig(),
        ...config,
    } satisfies LLMProviderConfig;

    switch (resolved.provider) {
        case "openai":
        case "openai-compatible":
            return new OpenAIProvider(resolved);
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