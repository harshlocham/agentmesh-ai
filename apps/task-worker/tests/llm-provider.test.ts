import assert from "node:assert/strict";
import test from "node:test";
import { createLLMProvider, recommendProviderForTaskProfile, validateProviderStartup } from "../services/llm/provider-factory.js";
import { getAllLLMProviderMetricsSnapshots, resetLLMProviderMetrics } from "../services/llm/metrics.js";
import { HuggingFaceProvider } from "../services/llm/providers/huggingface-provider.js";
import { OpenAIProvider } from "../services/llm/providers/openai-provider.js";
import { parseJsonResponse, parseJsonText } from "../services/llm/response-parser.js";
import { LLMError, type LLMProviderConfig } from "../services/llm/types.js";

type ProviderClient = {
    responses: { create: (payload: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> };
    chat: { completions: { create: (payload: unknown, options?: { signal?: AbortSignal }) => Promise<unknown> } };
    models: { list: () => Promise<unknown> };
};

function createClient(overrides: Partial<ProviderClient> = {}): ProviderClient {
    return {
        responses: {
            create: async () => ({
                id: "resp_default",
                output_text: "default",
                output: [{ type: "message", content: [{ type: "output_text", text: "default" }] }],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                status: "completed",
            }),
            ...overrides.responses,
        },
        chat: {
            completions: {
                create: async () => ({
                    id: "chat_default",
                    choices: [{ message: { content: "default" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                }),
                ...overrides.chat?.completions,
            },
        },
        models: {
            list: async () => ({ data: [] }),
            ...overrides.models,
        },
    };
}

function createProvider(config: Partial<LLMProviderConfig> = {}, client?: ProviderClient) {
    return new OpenAIProvider({
        provider: "openai-compatible",
        apiKey: "test-key",
        baseUrl: "http://mock.local/v1",
        timeoutMs: 5_000,
        logRequests: false,
        supportsJsonMode: true,
        supportsStructuredOutputs: true,
        supportsToolCalling: true,
        supportsStreaming: true,
        ...config,
    }, client as never);
}

test("response parser repairs fenced and trailing JSON", () => {
    const parsed = parseJsonText<{ ok: boolean }>("```json\n{\"ok\":true}\n``` trailing text");
    assert.deepEqual(parsed.value, { ok: true });
});

test("response parser handles chat-completions style payloads", () => {
    const response = {
        model: "gpt-4o-mini",
        provider: "openai-compatible",
        raw: {
            choices: [
                {
                    message: {
                        content: "{\"value\":42}",
                    },
                },
            ],
        },
    } as const;

    const parsed = parseJsonResponse<{ value: number }>(response);
    assert.deepEqual(parsed.value, { value: 42 });
});

test("openai provider normalizes responses api payloads", async () => {
    const provider = createProvider({}, createClient({
        responses: {
            create: async () => ({
                id: "resp_1",
                output_text: "hello world",
                output: [{ type: "message", content: [{ type: "output_text", text: "hello world" }] }],
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
                status: "completed",
            }),
        },
    }));

    const response = await provider.generate({ model: "gpt-4o-mini", input: "ping" });

    assert.equal(response.provider, "openai-compatible");
    assert.equal(response.output_text, "hello world");
    assert.equal(response.responseFormat, "responses");
    assert.equal(response.parseRepaired, false);
    assert.equal(response.usage?.totalTokens, 5);
});

test("openai provider falls back to chat completions when responses api is unsupported", async () => {
    const provider = createProvider({}, createClient({
        responses: {
            create: async () => {
                const error = new Error("Request failed with status code 404");
                (error as Error & { status?: number }).status = 404;
                throw error;
            },
        },
        chat: {
            completions: {
                create: async () => ({
                    id: "chat_1",
                    choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
                }),
            },
        },
    }));

    const response = await provider.generate({ model: "gpt-4o-mini", input: [{ role: "user", content: "return json" }] });

    assert.equal(response.output_text, "{\"ok\":true}");
    assert.equal(response.responseFormat, "chat_completions");
});

test("openai provider surfaces timeout errors as retryable llm errors", async () => {
    const provider = createProvider({ timeoutMs: 10 }, createClient({
        responses: {
            create: async (_payload, options) => {
                const signal = options?.signal;

                return await new Promise((_resolve, reject) => {
                    signal?.addEventListener("abort", () => {
                        reject(new Error("Request was aborted."));
                    });
                });
            },
        },
    }));

    await assert.rejects(
        () => provider.generate({ model: "gpt-4o-mini", input: "slow" }),
        (error: unknown) => error instanceof LLMError && error.code === "LLM_TIMEOUT" && error.retryable === true
    );
});

test("factory routes amd openai-compatible providers through the openai transport", () => {
    const provider = createLLMProvider({
        provider: "amd-openai-compatible",
        apiKey: "test-key",
        baseUrl: "http://amd.local/v1",
        model: "mixtral",
        logRequests: false,
    });

    assert.equal(provider instanceof OpenAIProvider, true);
    assert.equal(provider.supportsResponsesApi(), false);
});

test("hugging face inference api provider normalizes text output", async () => {
    resetLLMProviderMetrics();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify([{ generated_text: "hf response" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
    })) as typeof fetch;

    try {
        const provider = new HuggingFaceProvider({
            provider: "huggingface",
            apiKey: "hf-test-key",
            baseUrl: "https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.3",
            model: "mistralai/Mistral-7B-Instruct-v0.3",
            transport: "inference-api",
            logRequests: false,
            supportsJsonMode: false,
            supportsStructuredOutputs: false,
            supportsToolCalling: false,
            supportsStreaming: false,
        });

        const response = await provider.generate({ model: "mistralai/Mistral-7B-Instruct-v0.3", input: "hello" });

        assert.equal(response.provider, "huggingface");
        assert.equal(response.output_text, "hf response");
        assert.equal(response.responseFormat, "normalized");
        assert.ok(getAllLLMProviderMetricsSnapshots().some((snapshot) => snapshot.provider === "huggingface"));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("startup validation returns a lightweight report for missing config", async () => {
    const report = await validateProviderStartup({ provider: "huggingface", apiKey: "", model: "" });

    assert.equal(report.ok, false);
    assert.equal(report.authPresent, false);
    assert.equal(report.modelConfigured, false);
});

test("provider recommendation helper returns a lightweight fallback plan", () => {
    const recommendation = recommendProviderForTaskProfile("json");

    assert.equal(recommendation.provider, "openai-compatible");
    assert.equal(recommendation.fallbackProvider, "openai-compatible");
});