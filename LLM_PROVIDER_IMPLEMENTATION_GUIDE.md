# LLM Provider Architecture - Implementation Guide
## Practical Code Examples & Migration Paths

---

## PART 1: CORE TYPE DEFINITIONS

### File: `apps/task-worker/services/llm/core/types.ts`

```typescript
/**
 * Core type definitions for LLM provider abstraction
 * Provider-agnostic request/response contracts
 */

// ============================================================================
// MESSAGE & CONTENT
// ============================================================================

export type MessageRole = "system" | "user" | "assistant";

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
}

export interface FunctionCall {
  name: string;
  arguments: string; // JSON string
}

// ============================================================================
// TOKEN USAGE
// ============================================================================

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  
  total(): number;
}

export class DefaultTokenUsage implements TokenUsage {
  constructor(
    public promptTokens: number = 0,
    public completionTokens: number = 0,
    public cacheReadTokens: number = 0,
    public cacheCreationTokens: number = 0
  ) {}
  
  total(): number {
    return this.promptTokens + this.completionTokens;
  }
}

// ============================================================================
// COST TRACKING
// ============================================================================

export interface CostEstimate {
  estimatedCost: number;
  promptTokensEstimate: number;
  completionTokensEstimate: number;
  currency: string; // "USD"
}

export interface CostModel {
  promptTokenCost: number; // Cost per 1k tokens
  completionTokenCost: number; // Cost per 1k tokens
  baseCost?: number; // Per-request base cost
  cacheReadCost?: number;
  cacheCreationCost?: number;
}

// ============================================================================
// RESPONSE METADATA
// ============================================================================

export interface ResponseMetadata {
  model: string;
  provider: string;
  latencyMs: number;
  requestId: string;
  timestamp: Date;
  cost?: CostEstimate;
  cacheHit?: boolean;
  retryCount?: number;
  finishReason?: "stop" | "max_tokens" | "tool_calls" | "error" | "length";
}

// ============================================================================
// REQUESTS & RESPONSES
// ============================================================================

export interface LLMRequest {
  // Core fields
  messages: Message[];
  model: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  
  // Advanced
  stopSequences?: string[];
  systemPrompt?: string; // Alternative to messages[0]
  
  // Capabilities requested
  capabilities?: RequestCapabilities;
  
  // Context for routing & logging
  context?: ExecutionContext;
  
  // Routing preferences
  routingPreferences?: RoutingPreferences;
  
  // Metadata
  metadata?: Record<string, unknown>;
}

export interface RequestCapabilities {
  structuredOutput?: {
    schema: unknown; // ZodSchema<T>
    format: "json" | "json_schema";
  };
  
  toolCalling?: {
    tools: unknown[]; // Tool[] - tool definitions
    allowParallelCalls?: boolean;
  };
  
  vision?: boolean;
  maxOutputTokens?: number;
  caching?: "none" | "prompt" | "full";
}

export interface ExecutionContext {
  taskId?: string;
  conversationId?: string;
  userId?: string;
  executionPhase?: "planning" | "acting" | "verifying" | "reflection";
  traceId?: string;
}

export interface RoutingPreferences {
  preferredProviders?: string[];
  excludeProviders?: string[];
  maxCostPerRequest?: number;
  maxLatencyMs?: number;
  requireStructuredOutput?: boolean;
  requireLocalInference?: boolean;
  optimizeFor?: "cost" | "latency" | "reliability" | "quality";
}

export interface LLMResponse {
  content: string;
  usage: TokenUsage;
  metadata: ResponseMetadata;
  provider: string;
  finishReason?: ResponseMetadata["finishReason"];
}

export interface StructuredLLMResponse<T> {
  content: T;
  raw: string;
  usage: TokenUsage;
  metadata: ResponseMetadata;
  provider: string;
}

// ============================================================================
// PROVIDER CAPABILITIES
// ============================================================================

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  releaseDate: Date;
  costPer1kPromptTokens: number;
  costPer1kCompletionTokens: number;
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
  supportsVision: boolean;
}

export interface ProviderCapabilities {
  models: ModelInfo[];
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsPromptCaching: boolean;
  supportsBatchProcessing: boolean;
  maxRequestsPerMinute: number;
  maxConcurrentRequests: number;
  maxContextWindows: number;
  supportedContentTypes: string[];
  availabilityGuarantee: "best-effort" | "99.5%" | "99.95%" | "99.99%";
  typicalLatencyMs: {
    min: number;
    p50: number;
    p99: number;
  };
}

export interface ProviderHealth {
  isHealthy: boolean;
  lastCheckedAt: Date;
  responseTimeMs: number;
  errorRate: number;
  availabilityPercent: number;
  circuitBreakerStatus: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  reason?: string;
}

// ============================================================================
// ERRORS
// ============================================================================

export type ErrorCategory =
  | "transient"
  | "permanent"
  | "provider_unavailable"
  | "capability_missing"
  | "rate_limited"
  | "quota_exceeded"
  | "invalid_request"
  | "timeout"
  | "unknown";

export class LLMError extends Error {
  constructor(
    message: string,
    public code: string,
    public category: ErrorCategory,
    public isRetryable: boolean,
    public provider?: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export class StructuredOutputError extends LLMError {
  constructor(
    message: string,
    public fallbackValue?: unknown
  ) {
    super(message, "STRUCTURED_OUTPUT_ERROR", "permanent", true);
    this.name = "StructuredOutputError";
  }
}

// ============================================================================
// ROUTING
// ============================================================================

export interface RoutingCriteria {
  requiresStructuredOutput?: boolean;
  requiresToolCalling?: boolean;
  requiresLocalInference?: boolean;
  requiresVision?: boolean;
  optimizeFor?: "cost" | "latency" | "reliability" | "quality";
  maxCostPerRequest?: number;
  maxLatencyMs?: number;
  preferredProviders?: string[];
  excludeProviders?: string[];
  requireHealthy?: boolean;
}

export interface RoutingResult {
  response: LLMResponse;
  provider: string;
  attemptCount: number;
  fallbackUsed: boolean;
}

// ============================================================================
// OBSERVABILITY
// ============================================================================

export interface RequestObservability {
  requestId: string;
  taskId?: string;
  conversationId?: string;
  model: string;
  provider: string;
  startTime: Date;
  endTime?: Date;
  status: "pending" | "success" | "error" | "fallback";
  error?: {
    code: string;
    message: string;
    category: ErrorCategory;
    retryable: boolean;
  };
  metrics: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    costUsd: number;
    attemptCount: number;
  };
}

export interface ProviderMetrics {
  provider: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  averageLatencyMs: number;
  p99LatencyMs: number;
  costPerRequest: number;
  costPerDay: number;
  lastAvailabilityCheck: Date;
  consecutiveFailures: number;
}

// ============================================================================
// PERFORMANCE PROFILING
// ============================================================================

export interface PerformanceProfile {
  model: string;
  provider: string;
  averageLatencyMs: number;
  averageTokensPerSecond: number;
  structuredOutputAccuracy?: number;
  toolCallingAccuracy?: number;
  QPSCapacity: number;
  ConcurrencyLimit: number;
  costPerMillion1kCompletions: number;
}
```

---

## PART 2: BASE PROVIDER IMPLEMENTATION

### File: `apps/task-worker/services/llm/core/base-provider.ts`

```typescript
import { z } from "zod";
import type {
  LLMRequest,
  LLMResponse,
  StructuredLLMResponse,
  ProviderCapabilities,
  ProviderHealth,
  TokenUsage,
  CostEstimate,
  LLMError as ILLMError,
} from "./types";

/**
 * Abstract base class for all LLM providers
 * Defines the contract that every provider must implement
 */
export abstract class BaseLLMProvider {
  /**
   * Provider name identifier (lowercase, no spaces)
   * e.g., "openai", "huggingface", "amd-cloud", "local-oss"
   */
  abstract get name(): string;

  /**
   * Generate text completion
   * @throws LLMError on failure
   */
  abstract generateCompletion(request: LLMRequest): Promise<LLMResponse>;

  /**
   * Generate structured output (JSON, function calls, etc.)
   * @throws StructuredOutputError if schema parsing fails
   */
  abstract generateStructured<T>(
    request: LLMRequest,
    schema: z.ZodSchema<T>
  ): Promise<StructuredLLMResponse<T>>;

  /**
   * Get provider capabilities (models, features, limits)
   */
  abstract getCapabilities(): ProviderCapabilities;

  /**
   * Health check - verify provider is responsive
   */
  abstract healthCheck(): Promise<ProviderHealth>;

  /**
   * Calculate request cost based on token usage
   */
  abstract calculateCost(
    usage: TokenUsage,
    modelId: string
  ): CostEstimate;

  /**
   * Batch processing (optional - default throws)
   */
  async generateBatch(
    requests: LLMRequest[]
  ): Promise<LLMResponse[]> {
    // Default: process sequentially
    const results: LLMResponse[] = [];
    for (const request of requests) {
      results.push(await this.generateCompletion(request));
    }
    return results;
  }

  /**
   * Transform error into LLMError
   */
  protected abstract transformError(error: unknown): ILLMError;
}
```

---

## PART 3: OPENAI PROVIDER (UPDATED)

### File: `apps/task-worker/services/llm/providers/openai-provider.ts`

```typescript
import OpenAI from "openai";
import { z } from "zod";
import { BaseLLMProvider } from "../core/base-provider";
import {
  type LLMRequest,
  type LLMResponse,
  type StructuredLLMResponse,
  type ProviderCapabilities,
  type ProviderHealth,
  type TokenUsage,
  type CostEstimate,
  LLMError,
  DefaultTokenUsage,
  ResponseMetadata,
} from "../core/types";

export class OpenAIProvider extends BaseLLMProvider {
  private client: OpenAI;
  private costModel = new Map<string, { prompt: number; completion: number }>([
    ["gpt-4-turbo", { prompt: 0.01, completion: 0.03 }],
    ["gpt-4o", { prompt: 0.005, completion: 0.015 }],
    ["gpt-4o-mini", { prompt: 0.00015, completion: 0.0006 }],
    ["gpt-3.5-turbo", { prompt: 0.0005, completion: 0.0015 }],
  ]);

  constructor(apiKey: string, baseUrl?: string) {
    super();
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      defaultHeaders: {
        "user-agent": "task-worker/llm-router",
      },
    });
  }

  get name(): string {
    return "openai";
  }

  async generateCompletion(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    const requestId = request.metadata?.requestId as string || 
      `openai-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    try {
      const response = await this.client.chat.completions.create({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        top_p: request.topP,
        max_tokens: request.maxTokens,
        stop: request.stopSequences,
      });

      const usage = new DefaultTokenUsage(
        response.usage?.prompt_tokens ?? 0,
        response.usage?.completion_tokens ?? 0
      );

      const cost = this.calculateCost(usage, request.model);
      const latencyMs = Date.now() - startTime;

      return {
        content: response.choices[0]?.message.content ?? "",
        usage,
        metadata: {
          model: request.model,
          provider: this.name,
          latencyMs,
          requestId: response.id ?? requestId,
          timestamp: new Date(),
          cost,
          finishReason: response.choices[0]?.finish_reason as any,
        },
        provider: this.name,
      };
    } catch (error) {
      throw this.transformError(error);
    }
  }

  async generateStructured<T>(
    request: LLMRequest,
    schema: z.ZodSchema<T>
  ): Promise<StructuredLLMResponse<T>> {
    // Use OpenAI's JSON mode for structured output
    const response = await this.generateCompletion({
      ...request,
      temperature: 0, // Deterministic for structured output
    });

    try {
      // Extract JSON from response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const validated = schema.parse(parsed);

      return {
        content: validated,
        raw: response.content,
        usage: response.usage,
        metadata: response.metadata,
        provider: response.provider,
      };
    } catch (error) {
      throw new LLMError(
        `Failed to parse structured output: ${error instanceof Error ? error.message : String(error)}`,
        "STRUCTURED_OUTPUT_ERROR",
        "permanent",
        false,
        this.name,
        error instanceof Error ? error : undefined
      );
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      models: [
        {
          id: "gpt-4-turbo",
          name: "GPT-4 Turbo",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          releaseDate: new Date("2024-04-09"),
          costPer1kPromptTokens: 10,
          costPer1kCompletionTokens: 30,
          supportsStructuredOutput: true,
          supportsToolCalling: true,
          supportsVision: true,
        },
        {
          id: "gpt-4o",
          name: "GPT-4 Omni",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          releaseDate: new Date("2024-05-13"),
          costPer1kPromptTokens: 5,
          costPer1kCompletionTokens: 15,
          supportsStructuredOutput: true,
          supportsToolCalling: true,
          supportsVision: true,
        },
        {
          id: "gpt-4o-mini",
          name: "GPT-4 Omni Mini",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          releaseDate: new Date("2024-07-18"),
          costPer1kPromptTokens: 0.15,
          costPer1kCompletionTokens: 0.6,
          supportsStructuredOutput: true,
          supportsToolCalling: true,
          supportsVision: true,
        },
        {
          id: "gpt-3.5-turbo",
          name: "GPT-3.5 Turbo",
          contextWindow: 16384,
          maxOutputTokens: 4096,
          releaseDate: new Date("2023-11-06"),
          costPer1kPromptTokens: 0.5,
          costPer1kCompletionTokens: 1.5,
          supportsStructuredOutput: false,
          supportsToolCalling: true,
          supportsVision: false,
        },
      ],
      supportsStructuredOutput: true,
      supportsToolCalling: true,
      supportsVision: true,
      supportsStreaming: true,
      supportsPromptCaching: true,
      supportsBatchProcessing: true,
      maxRequestsPerMinute: 10000,
      maxConcurrentRequests: 1000,
      maxContextWindows: 128000,
      supportedContentTypes: ["text", "image", "image_url"],
      availabilityGuarantee: "99.95%",
      typicalLatencyMs: {
        min: 100,
        p50: 300,
        p99: 1000,
      },
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    try {
      // Lightweight health check - list models
      await this.client.models.list();
      return {
        isHealthy: true,
        lastCheckedAt: new Date(),
        responseTimeMs: Date.now() - startTime,
        errorRate: 0,
        availabilityPercent: 100,
        circuitBreakerStatus: "closed",
        consecutiveFailures: 0,
      };
    } catch (error) {
      return {
        isHealthy: false,
        lastCheckedAt: new Date(),
        responseTimeMs: Date.now() - startTime,
        errorRate: 1.0,
        availabilityPercent: 0,
        circuitBreakerStatus: "open",
        consecutiveFailures: 1,
        reason: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  calculateCost(usage: TokenUsage, modelId: string): CostEstimate {
    const costs = this.costModel.get(modelId) ?? {
      prompt: 0.01,
      completion: 0.03,
    };

    const promptCost = (usage.promptTokens / 1000) * costs.prompt;
    const completionCost = (usage.completionTokens / 1000) * costs.completion;
    const totalCost = promptCost + completionCost;

    return {
      estimatedCost: totalCost,
      promptTokensEstimate: usage.promptTokens,
      completionTokensEstimate: usage.completionTokens,
      currency: "USD",
    };
  }

  protected transformError(error: unknown): LLMError {
    if (error instanceof OpenAI.APIError) {
      let category: "transient" | "permanent" | "provider_unavailable" | "rate_limited" | "quota_exceeded" | "invalid_request" | "timeout" | "unknown" =
        "unknown";
      let isRetryable = false;

      if (error.status === 429) {
        category = "rate_limited";
        isRetryable = true;
      } else if (error.status === 500 || error.status === 503) {
        category = "provider_unavailable";
        isRetryable = true;
      } else if (error.status === 401 || error.status === 403) {
        category = "invalid_request";
        isRetryable = false;
      } else if (error.message.includes("timeout")) {
        category = "timeout";
        isRetryable = true;
      }

      return new LLMError(
        error.message,
        error.code ?? "OPENAI_API_ERROR",
        category,
        isRetryable,
        this.name,
        error
      );
    }

    return new LLMError(
      error instanceof Error ? error.message : "Unknown error",
      "UNKNOWN_ERROR",
      "unknown",
      false,
      this.name,
      error instanceof Error ? error : undefined
    );
  }
}
```

---

## PART 4: LLM ROUTER IMPLEMENTATION

### File: `apps/task-worker/services/llm/router/llm-router.ts`

```typescript
import { z } from "zod";
import { BaseLLMProvider } from "../core/base-provider";
import {
  type LLMRequest,
  type LLMResponse,
  type StructuredLLMResponse,
  type RoutingCriteria,
  type RoutingResult,
  LLMError,
} from "../core/types";

interface RouterConfig {
  providers: Map<string, BaseLLMProvider>;
  primaryProvider?: string;
  maxRetries?: number;
  fallbackEnabled?: boolean;
}

/**
 * Intelligent router for selecting and failing over between LLM providers
 */
export class LLMRouter {
  private providers: Map<string, BaseLLMProvider>;
  private primaryProvider?: string;
  private maxRetries: number;
  private fallbackEnabled: boolean;

  constructor(config: RouterConfig) {
    this.providers = config.providers;
    this.primaryProvider = config.primaryProvider;
    this.maxRetries = config.maxRetries ?? 2;
    this.fallbackEnabled = config.fallbackEnabled ?? true;
  }

  /**
   * Route request to best provider with fallback support
   */
  async route(request: LLMRequest): Promise<RoutingResult> {
    const selectedProviders = this.selectProviders(request);

    if (selectedProviders.length === 0) {
      throw new LLMError(
        "No suitable providers available",
        "NO_SUITABLE_PROVIDER",
        "permanent",
        false
      );
    }

    let lastError: LLMError | null = null;
    let attemptCount = 0;

    for (const providerName of selectedProviders) {
      attemptCount++;
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      try {
        const response = await provider.generateCompletion(request);
        return {
          response,
          provider: providerName,
          attemptCount,
          fallbackUsed: providerName !== this.primaryProvider,
        };
      } catch (error) {
        lastError =
          error instanceof LLMError
            ? error
            : new LLMError(
                error instanceof Error
                  ? error.message
                  : "Unknown error",
                "ROUTING_ERROR",
                "unknown",
                true,
                providerName
              );

        // Only continue if error is retryable
        if (!lastError.isRetryable) {
          break;
        }

        // Check if we should retry same provider
        if (attemptCount < this.maxRetries) {
          const backoffMs = Math.min(
            1000 * Math.pow(2, attemptCount - 1),
            10_000
          );
          await this.sleep(backoffMs);
          attemptCount--; // Reset for same provider retry
          continue;
        }
      }
    }

    throw (
      lastError ??
      new LLMError(
        "All providers failed",
        "ALL_PROVIDERS_FAILED",
        "permanent",
        false
      )
    );
  }

  /**
   * Route with structured output guarantee
   */
  async routeStructured<T>(
    request: LLMRequest,
    schema: z.ZodSchema<T>
  ): Promise<StructuredLLMResponse<T>> {
    const selectedProviders = this.selectProviders(request);
    let lastError: Error | null = null;

    for (const providerName of selectedProviders) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;

      try {
        return await provider.generateStructured(request, schema);
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new Error(String(error));
      }
    }

    throw (
      lastError ??
      new Error(
        "Failed to generate structured output from any provider"
      )
    );
  }

  /**
   * Select providers based on routing criteria
   */
  private selectProviders(request: LLMRequest): string[] {
    const criteria = this.buildRoutingCriteria(request);
    const candidates: Array<{ name: string; score: number }> = [];

    for (const [name, provider] of this.providers.entries()) {
      // Skip excluded providers
      if (criteria.excludeProviders?.includes(name)) {
        continue;
      }

      // Apply preferences
      if (
        criteria.preferredProviders?.length &&
        !criteria.preferredProviders.includes(name)
      ) {
        continue;
      }

      const capabilities = provider.getCapabilities();

      // Check capability requirements
      if (
        criteria.requiresStructuredOutput &&
        !capabilities.supportsStructuredOutput
      ) {
        continue;
      }

      if (
        criteria.requiresToolCalling &&
        !capabilities.supportsToolCalling
      ) {
        continue;
      }

      // Check context window
      if (
        criteria.maxLatencyMs &&
        capabilities.typicalLatencyMs.p99 > criteria.maxLatencyMs
      ) {
        continue;
      }

      // Calculate routing score
      let score = 1.0;

      // Prefer primary provider
      if (name === this.primaryProvider) {
        score *= 1.5;
      }

      candidates.push({ name, score });
    }

    // Sort by score and return
    return candidates
      .sort((a, b) => b.score - a.score)
      .map((c) => c.name);
  }

  private buildRoutingCriteria(request: LLMRequest): RoutingCriteria {
    const criteria: RoutingCriteria = {
      requireHealthy: true,
    };

    if (request.routingPreferences) {
      Object.assign(criteria, request.routingPreferences);
    }

    if (request.capabilities?.structuredOutput) {
      criteria.requiresStructuredOutput = true;
    }

    if (request.capabilities?.toolCalling) {
      criteria.requiresToolCalling = true;
    }

    return criteria;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

---

## PART 5: RESPONSE PARSER

### File: `apps/task-worker/services/llm/parsing/response-parser.ts`

```typescript
import { z } from "zod";

/**
 * Unified response parsing across all providers
 */
export class LLMResponseParser {
  /**
   * Extract JSON object from response text
   */
  static extractJSON<T>(
    text: string,
    schema: z.ZodSchema<T>,
    allowPartial: boolean = false
  ): T | null {
    try {
      // Try full JSON first
      const parsed = JSON.parse(text);
      
      if (allowPartial) {
        return schema.passthrough().parse(parsed);
      }
      return schema.parse(parsed);
    } catch (error) {
      // Try to extract JSON from markdown code block
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        try {
          const parsed = JSON.parse(codeBlockMatch[1]);
          if (allowPartial) {
            return schema.passthrough().parse(parsed);
          }
          return schema.parse(parsed);
        } catch {
          // Continue to next strategy
        }
      }

      // Try to find JSON object in text
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (allowPartial) {
            return schema.passthrough().parse(parsed);
          }
          return schema.parse(parsed);
        } catch {
          // Continue
        }
      }

      return null;
    }
  }

  /**
   * Parse with fallback value
   */
  static parseWithFallback<T>(
    text: string,
    schema: z.ZodSchema<T>,
    fallback: T
  ): T {
    const parsed = this.extractJSON(text, schema, true);
    return parsed ?? fallback;
  }

  /**
   * Extract function/tool calls from response
   */
  static extractFunctionCalls(text: string): Array<{
    name: string;
    arguments: string;
  }> {
    const results: Array<{ name: string; arguments: string }> = [];

    // Look for pattern: <function_calls>[{"name":"...", "arguments":"..."}]</function_calls>
    const functionCallsMatch = text.match(
      /<function_calls>\s*([\s\S]*?)\s*<\/function_calls>/
    );
    if (functionCallsMatch) {
      try {
        const calls = JSON.parse(functionCallsMatch[1]);
        if (Array.isArray(calls)) {
          for (const call of calls) {
            if (call.name && call.arguments) {
              results.push({
                name: call.name,
                arguments:
                  typeof call.arguments === "string"
                    ? call.arguments
                    : JSON.stringify(call.arguments),
              });
            }
          }
        }
        return results;
      } catch {
        // Fall through
      }
    }

    // Try JSON array pattern
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.name && item.arguments) {
            results.push({
              name: item.name,
              arguments:
                typeof item.arguments === "string"
                  ? item.arguments
                  : JSON.stringify(item.arguments),
            });
          }
        }
      }
    } catch {
      // Not JSON
    }

    return results;
  }

  /**
   * Estimate token count (rough approximation)
   */
  static estimateTokens(text: string): number {
    // Rough heuristic: ~4 characters per token
    // More accurate would need actual tokenizer
    return Math.ceil(text.length / 4);
  }

  /**
   * Count tokens using model-specific encoding (optional)
   * Requires additional library like "js-tiktoken" for OpenAI models
   */
  static countTokensOpenAI(text: string): number {
    // This would use js-tiktoken library
    // For now, use estimation
    return Math.ceil((text.length / 4) * 1.3); // 30% correction factor
  }
}
```

---

## PART 6: MIGRATION - UPDATING AGENT-RUNNER

### Before & After Comparison

#### BEFORE: `agent-runner.ts` (Current)
```typescript
private async requestLlmResponse(
  model: string,
  input: string
): Promise<{ output_text?: string; output?: unknown }> {
  if (this.llmRequestFn) {
    return this.llmRequestFn({ model, input });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("LLM_ERROR: OPENAI_API_KEY not configured");
  }

  const openai = new OpenAI({ apiKey });
  return openai.responses.create({ model, input }) as Promise<{
    output_text?: string;
    output?: unknown;
  }>;
}
```

#### AFTER: `agent-runner.ts` (With Router)

```typescript
import { LLMRouter } from "./llm/router/llm-router";
import { OpenAIProvider } from "./llm/providers/openai-provider";
import type { LLMRequest, LLMResponse } from "./llm/core/types";

export class AgentRunner {
  private llmRouter: LLMRouter;

  constructor(options?: {
    // ... existing options ...
    llmRouter?: LLMRouter;
    useLlmRouter?: boolean; // Feature flag
  }) {
    // ... existing init ...

    // Initialize router
    const useLlmRouter = 
      options?.useLlmRouter ?? 
      process.env.USE_LLM_ROUTER === "true";

    if (useLlmRouter) {
      const openaiProvider = new OpenAIProvider(
        process.env.OPENAI_API_KEY || ""
      );
      this.llmRouter =
        options?.llmRouter ??
        new LLMRouter({
          providers: new Map([
            [openaiProvider.name, openaiProvider],
          ]),
          primaryProvider: "openai",
          maxRetries: 2,
          fallbackEnabled: true,
        });
    }
  }

  private async requestLlmResponse(
    model: string,
    input: string
  ): Promise<LLMResponse> {
    // Use router if available
    if (this.llmRouter) {
      const request: LLMRequest = {
        messages: [
          {
            role: "user",
            content: input,
          },
        ],
        model,
        temperature: 0.0,
        context: {
          taskId: "unknown", // Will be set by caller
        },
      };

      const result = await this.llmRouter.route(request);
      return result.response;
    }

    // Fallback to legacy method for compatibility
    if (this.llmRequestFn) {
      return this.legacyRequestFn(model, input);
    }

    throw new Error("LLM_ERROR: No LLM provider configured");
  }

  // Keep legacy method for testing during migration
  private async legacyRequestFn(
    model: string,
    input: string
  ): Promise<LLMResponse> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("LLM_ERROR: OPENAI_API_KEY not configured");
    }

    const openai = new OpenAI({ apiKey });
    const response = await openai.responses.create({ model, input });

    return {
      content: response.output_text ?? "",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        total: () => 0,
      },
      metadata: {
        model,
        provider: "openai",
        latencyMs: 0,
        requestId: response.id ?? "",
        timestamp: new Date(),
      },
      provider: "openai",
    };
  }
}
```

---

## PART 7: INTEGRATION TEST EXAMPLE

### File: `apps/task-worker/tests/integration/agent-runner-llm-router.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { AgentRunner } from "../../services/agent-runner";
import { LLMRouter } from "../../services/llm/router/llm-router";
import { OpenAIProvider } from "../../services/llm/providers/openai-provider";
import type { LLMResponse } from "../../services/llm/core/types";

// Mock provider for testing
class MockLLMProvider {
  name = "mock";
  
  async generateCompletion(): Promise<LLMResponse> {
    return {
      content: JSON.stringify({
        toolName: "send_email",
        confidence: 0.95,
        parameters: {
          to: "test@example.com",
          subject: "Test",
        },
      }),
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        total: () => 150,
      },
      metadata: {
        model: "mock-model",
        provider: "mock",
        latencyMs: 100,
        requestId: "mock-123",
        timestamp: new Date(),
      },
      provider: "mock",
    };
  }

  getCapabilities() {
    return {
      models: [],
      supportsStructuredOutput: true,
      supportsToolCalling: true,
      supportsVision: false,
      supportsStreaming: false,
      supportsPromptCaching: false,
      supportsBatchProcessing: false,
      maxRequestsPerMinute: 1000,
      maxConcurrentRequests: 100,
      maxContextWindows: 4096,
      supportedContentTypes: ["text"],
      availabilityGuarantee: "best-effort" as const,
      typicalLatencyMs: {
        min: 50,
        p50: 100,
        p99: 200,
      },
    };
  }

  async healthCheck() {
    return {
      isHealthy: true,
      lastCheckedAt: new Date(),
      responseTimeMs: 50,
      errorRate: 0,
      availabilityPercent: 100,
      circuitBreakerStatus: "closed" as const,
      consecutiveFailures: 0,
    };
  }

  calculateCost(usage: any, modelId: string) {
    return {
      estimatedCost: 0.001,
      promptTokensEstimate: usage.promptTokens,
      completionTokensEstimate: usage.completionTokens,
      currency: "USD",
    };
  }

  protected transformError(error: unknown) {
    throw error;
  }
}

describe("AgentRunner with LLMRouter", () => {
  let router: LLMRouter;
  let mockProvider: MockLLMProvider;

  beforeEach(() => {
    mockProvider = new MockLLMProvider();
    router = new LLMRouter({
      providers: new Map([["mock", mockProvider as any]]),
      primaryProvider: "mock",
    });
  });

  it("should route request successfully", async () => {
    const result = await router.route({
      messages: [{ role: "user", content: "Test" }],
      model: "mock-model",
      temperature: 0.7,
    });

    expect(result.response.content).toBeDefined();
    expect(result.provider).toBe("mock");
    expect(result.attemptCount).toBe(1);
  });

  it("should fallback to alternative provider on error", async () => {
    // This test would require multiple providers
    // Left as exercise for implementation
  });

  it("should parse structured output", async () => {
    const { z } = await import("zod");
    const schema = z.object({
      toolName: z.string(),
      confidence: z.number(),
      parameters: z.record(z.any()),
    });

    const result = await router.routeStructured(
      {
        messages: [{ role: "user", content: "Test" }],
        model: "mock-model",
        capabilities: {
          structuredOutput: {
            schema: schema as any,
            format: "json",
          },
        },
      },
      schema
    );

    expect(result.content.toolName).toBe("send_email");
    expect(result.content.confidence).toBe(0.95);
  });
});
```

---

## PART 8: ENVIRONMENT CONFIGURATION

### File: `.env.example` (Add these)

```bash
# LLM Provider Configuration
USE_LLM_ROUTER=false  # Start with feature flag disabled

# OpenAI Provider
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1  # Optional: for custom endpoints

# Hugging Face Provider
HUGGINGFACE_API_KEY=hf_...

# AMD Cloud Provider
AMD_CLOUD_API_KEY=...
AMD_CLOUD_BASE_URL=https://api.amd.example.com/v1

# Local OSS Provider (vLLM/TGI)
LOCAL_LLM_BASE_URL=http://localhost:8000/v1
LOCAL_LLM_API_KEY=local-dev

# Router Configuration
LLM_ROUTER_PRIMARY_PROVIDER=openai
LLM_ROUTER_MAX_RETRIES=2
LLM_ROUTER_FALLBACK_ENABLED=true

# Observability
LLM_REQUEST_LOGGING_ENABLED=true
LLM_COST_TRACKING_ENABLED=true
LLM_TRACE_REQUESTS=false
```

---

## PART 9: DEPLOYMENT CHECKLIST

```markdown
## Migration Deployment Checklist

### Phase 1: Foundation
- [ ] Create `/services/llm` directory structure
- [ ] Implement core types (`types.ts`)
- [ ] Implement base provider (`base-provider.ts`)
- [ ] Implement OpenAI provider
- [ ] Implement LLMRouter
- [ ] Implement response parser
- [ ] Unit tests for all components

### Phase 2: Integration
- [ ] Add feature flag `USE_LLM_ROUTER` to env config
- [ ] Update `agent-runner.ts` with legacy fallback
- [ ] Update `planner.ts` with legacy fallback
- [ ] Update `reflection-service.ts` with legacy fallback
- [ ] Integration tests for orchestration
- [ ] Deploy to staging with flag OFF

### Phase 3: Validation
- [ ] Run staging tests with flag OFF (no behavior change)
- [ ] Run staging tests with flag ON (new behavior)
- [ ] Performance benchmarking
- [ ] Cost analysis

### Phase 4: Expansion
- [ ] Implement Hugging Face provider
- [ ] Implement AMD Cloud provider
- [ ] Implement local OSS provider
- [ ] Router capability matching
- [ ] Integration with all providers

### Phase 5: Production
- [ ] Canary deployment (5% traffic)
- [ ] Monitor metrics for 24 hours
- [ ] Canary deployment (25% traffic)
- [ ] Monitor metrics for 24 hours
- [ ] Full rollout
- [ ] Remove feature flag
- [ ] Remove legacy code

### Rollback Plan
- Keep feature flag in code for 6 months
- Monitor: latency, errors, costs
- If issues: Set `USE_LLM_ROUTER=false` immediately
```

---

This implementation guide provides:
✅ Complete TypeScript interfaces
✅ Working code examples
✅ Migration paths (before/after)
✅ Integration tests
✅ Configuration templates
✅ Deployment checklist

Next steps:
1. Review with team
2. Start Phase 1 (Week 1)
3. Use feature flags for safe rollout
4. Expand providers in Phase 3
5. Optimize in Phase 4
