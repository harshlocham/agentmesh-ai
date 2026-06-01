# LLM Provider Abstraction Architecture
## Production-Grade, Provider-Agnostic Runtime for Autonomous Agents

**Document Version**: 1.0  
**Target**: AMD Developer Hackathon  
**Focus**: Enterprise-grade reliability, provider flexibility, scalability  

---

## TABLE OF CONTENTS

1. [Executive Summary & Current State Analysis](#executive-summary--current-state-analysis)
2. [Core Architecture Design](#core-architecture-design)
3. [System Components](#system-components)
4. [TypeScript Interfaces & Types](#typescript-interfaces--types)
5. [Folder Structure & Organization](#folder-structure--organization)
6. [Migration Strategy](#migration-strategy)
7. [Breaking Changes & Risk Analysis](#breaking-changes--risk-analysis)
8. [Provider Implementations](#provider-implementations)
9. [Routing & Orchestration](#routing--orchestration)
10. [Observability & Monitoring](#observability--monitoring)
11. [OSS Model Recommendations](#oss-model-recommendations)
12. [Implementation Best Practices](#implementation-best-practices)
13. [Top 10 Mistakes to Avoid](#top-10-mistakes-to-avoid)

---

## EXECUTIVE SUMMARY & CURRENT STATE ANALYSIS

### Current Architecture Critiques

Your task-worker runtime currently has:

#### ✅ **Strengths**
- Clean dependency injection pattern for `llmRequestFn`
- Modular service layer (planner, reflection, agent-runner)
- Persistent execution loops with memory & leasing
- Retry management and state machine enforcement
- Tool registry abstraction for execution

#### ❌ **Weaknesses - Why This Matters**

1. **Hardcoded OpenAI Coupling**
   - `agent-runner.ts:341`: Direct `new OpenAI({ apiKey })`
   - `planner.ts:267-285`: Raw fetch to `https://api.openai.com/v1`
   - `reflection-service.ts:36-67`: Duplicate OpenAI integration
   - **Risk**: Cannot swap providers without code changes; vendor lock-in

2. **Inconsistent LLM Integration Points**
   - 3 separate places calling LLM (planner, agent-runner, reflection)
   - Each has its own error handling, retry logic, response parsing
   - No shared request/response contracts
   - **Risk**: Bugs duplicated across all 3; hard to maintain consistency

3. **Lack of Provider Abstraction**
   - No capability detection (which model supports structured outputs?)
   - No fallback between providers
   - No cost tracking or routing optimization
   - **Risk**: Cannot leverage cheaper/faster models; no graceful degradation

4. **Rigid Request/Response Shape**
   ```typescript
   // Current: OpenAI-specific
   { model: string; input: string } → { output_text?: string; output?: unknown }
   ```
   - Doesn't reflect real LLM capabilities
   - No structured output schema support
   - No token counting/cost awareness
   - **Risk**: Cannot use Hugging Face, vLLM, or local models

5. **No Observability Layer**
   - Basic console.log statements
   - No structured logging, tracing, cost tracking
   - Cannot debug provider-specific issues
   - **Risk**: Hard to optimize, diagnose, or predict failures

6. **Missing Health Checks & Fallbacks**
   - No provider availability detection
   - No automatic fallback when provider fails
   - No circuit breaker pattern
   - **Risk**: Single-provider failure = task-worker dies

---

## CORE ARCHITECTURE DESIGN

### High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         AgentRunner                              │
│                    (Orchestration Logic)                         │
└──────────────┬──────────────────────────────────────────────────┘
               │
               ├──→ uses
               │
       ┌───────▼────────────────────────────────────────────┐
       │         LLMRouter (Provider Selection)              │
       │  ┌────────────────────────────────────────────┐    │
       │  │ - Model capability matching                │    │
       │  │ - Cost-aware routing                        │    │
       │  │ - Health check enforcement                │    │
       │  │ - Fallback orchestration                   │    │
       │  └────────────────────────────────────────────┘    │
       └──────────────┬─────────────────────────────────────┘
                      │
        ┌─────────────┼─────────────┬──────────────┐
        │             │             │              │
        ▼             ▼             ▼              ▼
    ┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
    │ OpenAI │  │Hugging   │  │ AMD      │  │ vLLM/    │
    │Provider│  │ Face     │  │ Cloud    │  │ TGI/OSS  │
    │        │  │ Provider │  │ Provider │  │ Provider │
    └────────┘  └──────────┘  └──────────┘  └──────────┘
        │             │             │              │
        └─────────────┴─────────────┴──────────────┘
                      │
                      ▼
       ┌──────────────────────────────────┐
       │    LLMResponseParser             │
       │  - Structured output extraction  │
       │  - Error recovery                │
       │  - Token counting               │
       │  - Cost calculation             │
       └──────────────────────────────────┘
                      │
                      ▼
       ┌──────────────────────────────────┐
       │  ModelCapabilityRegistry         │
       │  - Capabilities matrix           │
       │  - Performance profiles          │
       │  - Cost models                   │
       └──────────────────────────────────┘
```

### Three-Tier Architecture

#### **Tier 1: Provider Abstraction**
```
BaseLLMProvider (abstract)
    ├── OpenAIProvider
    ├── HuggingFaceProvider
    ├── AMDCloudProvider
    └── LocalOSSProvider (vLLM/TGI)
```

#### **Tier 2: Request/Response Contracts**
```
LLMRequest (provider-agnostic)
  ├── messages: Message[]
  ├── model: string
  ├── capabilities: RequestCapabilities
  └── context: ExecutionContext

LLMResponse (structured)
  ├── content: string | StructuredOutput
  ├── usage: TokenUsage
  ├── metadata: ResponseMetadata
  └── provider: string
```

#### **Tier 3: Orchestration**
```
LLMRouter
  ├── ModelCapabilityRegistry
  ├── ProviderHealthManager
  ├── CostOptimizer
  └── FallbackOrchestrator
```

---

## SYSTEM COMPONENTS

### 1. **BaseLLMProvider** (Abstract Base)

Core interface every provider implements:

```typescript
abstract class BaseLLMProvider {
  // Identify provider
  abstract get name(): string;
  
  // Core request handling
  abstract generateCompletion(request: LLMRequest): Promise<LLMResponse>;
  
  // Structured output (JSON, function calls)
  abstract generateStructured<T>(
    request: LLMRequest,
    schema: ZodSchema<T>
  ): Promise<StructuredLLMResponse<T>>;
  
  // Batch processing
  batchGenerateCompletion?(requests: LLMRequest[]): Promise<LLMResponse[]>;
  
  // Provider-specific capabilities
  abstract getCapabilities(): ProviderCapabilities;
  
  // Health checking
  abstract healthCheck(): Promise<ProviderHealth>;
  
  // Cost calculation
  calculateCost(usage: TokenUsage, modelId: string): CostEstimate;
}
```

### 2. **LLMRouter** (Intelligent Provider Selection)

Routes requests to optimal providers based on:
- Model capabilities (structured output, tool calling, etc.)
- Cost optimization
- Provider health
- Availability
- Latency SLAs

```typescript
class LLMRouter {
  constructor(
    providers: BaseLLMProvider[],
    registry: ModelCapabilityRegistry,
    healthManager: ProviderHealthManager,
    costOptimizer: CostOptimizer
  );
  
  // Select best provider for request
  selectProvider(criteria: RoutingCriteria): BaseLLMProvider;
  
  // Route with automatic fallback
  route(request: LLMRequest): Promise<{ 
    response: LLMResponse;
    provider: string;
    attemptCount: number;
  }>;
  
  // Route with structured output
  routeStructured<T>(
    request: LLMRequest,
    schema: ZodSchema<T>
  ): Promise<StructuredLLMResponse<T>>;
}
```

### 3. **LLMResponseParser** (Unified Response Handling)

Handles response parsing across all providers:

```typescript
class LLMResponseParser {
  // Extract structured data from response
  parseStructuredOutput<T>(
    response: string,
    schema: ZodSchema<T>,
    providerHint?: string
  ): T;
  
  // Handle function/tool calls
  parseFunctionCalls(response: string): FunctionCall[];
  
  // Count tokens provider-agnostically
  countTokens(content: string, model: string): number;
  
  // Extract error information
  extractErrorInfo(error: unknown): ErrorInfo;
  
  // Retry-safe parsing with fallbacks
  parseWithFallback<T>(
    response: string,
    schema: ZodSchema<T>,
    fallback: T
  ): T;
}
```

### 4. **ModelCapabilityRegistry** (Capability Matrix)

Maintains knowledge of model capabilities:

```typescript
class ModelCapabilityRegistry {
  // Define capabilities per model
  registerModel(config: ModelConfig): void;
  
  // Query capabilities
  getCapabilities(modelId: string): ModelCapabilities;
  
  // Find models with capability
  findModelsWithCapability(capability: Capability): ModelConfig[];
  
  // Performance profile
  getPerformanceProfile(modelId: string): PerformanceProfile;
  
  // Cost model
  getCostModel(modelId: string): CostModel;
}
```

### 5. **PromptManager** (Multi-Provider Prompt Optimization)

Adapts prompts for different provider models:

```typescript
class PromptManager {
  // Provider-specific prompt engineering
  optimizePrompt(
    prompt: string,
    provider: string,
    model: string
  ): string;
  
  // Template-based prompt building
  buildPrompt(template: PromptTemplate, context: Record<string, unknown>): string;
  
  // Token budget enforcement
  truncateToTokenBudget(
    content: string,
    budget: number,
    model: string
  ): string;
  
  // JSON mode suggestions
  suggestJsonInstructions(provider: string, model: string): string;
}
```

### 6. **ProviderHealthManager** (Availability & Reliability)

Monitors provider health:

```typescript
class ProviderHealthManager {
  async checkHealth(provider: BaseLLMProvider): Promise<ProviderHealth>;
  
  // Circuit breaker
  isHealthy(provider: BaseLLMProvider): boolean;
  
  // Gradual recovery
  recordFailure(provider: BaseLLMProvider, error: Error): void;
  recordSuccess(provider: BaseLLMProvider): void;
  
  // Get healthy alternatives
  getHealthyAlternatives(excludeProvider?: BaseLLMProvider): BaseLLMProvider[];
}
```

---

## TYPESCRIPT INTERFACES & TYPES

```typescript
// ============================================================================
// REQUEST/RESPONSE CONTRACTS
// ============================================================================

/** Message format (provider-agnostic) */
interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
}

/** Structured output capability request */
interface RequestCapabilities {
  /** Support for structured JSON output */
  structuredOutput?: {
    schema: ZodSchema<unknown>;
    format: "json" | "json_schema";
  };
  
  /** Function/tool calling capability */
  toolCalling?: {
    tools: Tool[];
    allowParallelCalls?: boolean;
  };
  
  /** Vision capability */
  vision?: boolean;
  
  /** Maximum output tokens */
  maxOutputTokens?: number;
  
  /** Caching strategy */
  caching?: "none" | "prompt" | "full";
}

/** Core LLM request (provider-agnostic) */
interface LLMRequest {
  // Standard fields
  messages: Message[];
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  
  // Capability requests
  capabilities?: RequestCapabilities;
  
  // Execution context
  context?: {
    taskId: string;
    conversationId: string;
    userId?: string;
    executionPhase?: "planning" | "acting" | "verifying";
  };
  
  // Routing preferences
  routingPreferences?: {
    preferredProviders?: string[];
    maxCostPerRequest?: number;
    maxLatencyMs?: number;
    requireStructuredOutput?: boolean;
    requireLocalInference?: boolean;
  };
  
  // Metadata
  metadata?: Record<string, unknown>;
}

/** Token usage tracking */
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  total(): number;
}

/** Structured response */
interface StructuredLLMResponse<T> {
  content: T;
  raw: string;
  usage: TokenUsage;
  metadata: ResponseMetadata;
  provider: string;
}

/** Standard response */
interface LLMResponse {
  content: string;
  usage: TokenUsage;
  metadata: ResponseMetadata;
  provider: string;
  finishReason?: "stop" | "max_tokens" | "tool_calls" | "error";
}

/** Response metadata */
interface ResponseMetadata {
  model: string;
  provider: string;
  latencyMs: number;
  requestId: string;
  timestamp: Date;
  cost?: CostEstimate;
  cacheHit?: boolean;
  retryCount?: number;
}

// ============================================================================
// PROVIDER CAPABILITIES
// ============================================================================

/** What a provider can do */
interface ProviderCapabilities {
  /** Supported models */
  models: ModelInfo[];
  
  /** Feature support */
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsPromptCaching: boolean;
  supportsBatchProcessing: boolean;
  
  /** Provider characteristics */
  maxRequestsPerMinute: number;
  maxConcurrentRequests: number;
  maxContextWindows: number;
  supportedContentTypes: string[];
  
  /** Reliability */
  availabilityGuarantee: "best-effort" | "99.5%" | "99.95%" | "99.99%";
  typicalLatencyMs: {
    min: number;
    p50: number;
    p99: number;
  };
}

interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  releaseDate: Date;
  costPer1kPromptTokens: number;
  costPer1kCompletionTokens: number;
  supportsStructuredOutput: boolean;
  supportsToolCalling: boolean;
}

interface ProviderHealth {
  isHealthy: boolean;
  lastCheckedAt: Date;
  responseTimeMs: number;
  errorRate: number;
  availabilityPercent: number;
  circuitBreakerStatus: "closed" | "open" | "half-open";
  reason?: string;
}

// ============================================================================
// ROUTING & OPTIMIZATION
// ============================================================================

interface RoutingCriteria {
  // Request characteristics
  requiresStructuredOutput?: boolean;
  requiresToolCalling?: boolean;
  requiresLocalInference?: boolean;
  
  // Optimization preferences
  optimizeFor?: "cost" | "latency" | "reliability" | "quality";
  maxCostPerRequest?: number;
  maxLatencyMs?: number;
  
  // Availability constraints
  preferredProviders?: string[];
  excludeProviders?: string[];
  requireHealthy?: boolean;
}

interface CostEstimate {
  estimatedCost: number;
  promptTokensEstimate: number;
  completionTokensEstimate: number;
  currency: string;
}

interface CostModel {
  promptTokenCost: number;
  completionTokenCost: number;
  baseCost?: number;
  cacheReadCost?: number;
  cacheCreationCost?: number;
}

// ============================================================================
// MONITORING & OBSERVABILITY
// ============================================================================

interface RequestObservability {
  requestId: string;
  taskId?: string;
  conversationId?: string;
  model: string;
  provider: string;
  startTime: Date;
  endTime?: Date;
  status: "pending" | "success" | "error";
  error?: {
    type: string;
    message: string;
    retryable: boolean;
  };
  metrics: {
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    costUsd: number;
  };
}

interface ProviderMetrics {
  provider: string;
  totalRequests: number;
  successRate: number;
  averageLatencyMs: number;
  costPerRequest: number;
  lastAvailabilityCheck: Date;
  consecutiveFailures: number;
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

interface ErrorInfo {
  code: string;
  message: string;
  isRetryable: boolean;
  suggestedWaitMs?: number;
  provider?: string;
  originalError?: Error;
}

class LLMError extends Error {
  constructor(
    message: string,
    public code: string,
    public isRetryable: boolean,
    public provider?: string,
    public originalError?: Error
  ) {
    super(message);
  }
}

class StructuredOutputError extends LLMError {
  constructor(message: string, public fallbackValue?: unknown) {
    super(message, "STRUCTURED_OUTPUT_ERROR", true);
  }
}

// ============================================================================
// PERFORMANCE & PROFILING
// ============================================================================

interface PerformanceProfile {
  model: string;
  provider: string;
  
  // Typical performance
  averageLatencyMs: number;
  averageTokensPerSecond: number;
  
  // Quality metrics
  structuredOutputAccuracy?: number;
  toolCallingAccuracy?: number;
  
  // Scalability
  QPSCapacity: number;
  ConcurrencyLimit: number;
}
```

---

## FOLDER STRUCTURE & ORGANIZATION

```
apps/task-worker/
├── services/
│   ├── llm/                                    # NEW: LLM abstraction layer
│   │   ├── core/
│   │   │   ├── base-provider.ts               # Abstract base class
│   │   │   ├── llm-request.ts                 # Request contracts
│   │   │   ├── llm-response.ts                # Response contracts
│   │   │   └── types.ts                       # All interfaces
│   │   │
│   │   ├── providers/
│   │   │   ├── openai-provider.ts             # OpenAI implementation
│   │   │   ├── huggingface-provider.ts        # Hugging Face implementation
│   │   │   ├── amd-cloud-provider.ts          # AMD Cloud implementation
│   │   │   ├── local-oss-provider.ts          # Local/vLLM/TGI support
│   │   │   └── index.ts                       # Provider exports
│   │   │
│   │   ├── router/
│   │   │   ├── llm-router.ts                  # Provider selection logic
│   │   │   ├── routing-criteria.ts            # Routing decision factors
│   │   │   └── fallback-orchestrator.ts       # Fallback handling
│   │   │
│   │   ├── parsing/
│   │   │   ├── response-parser.ts             # Unified response parsing
│   │   │   ├── structured-output-parser.ts    # JSON/schema parsing
│   │   │   ├── function-call-parser.ts        # Tool calling extraction
│   │   │   └── error-recovery.ts              # Error extraction & recovery
│   │   │
│   │   ├── registry/
│   │   │   ├── model-capability-registry.ts   # Capability matrix
│   │   │   ├── model-configs.ts               # Model definitions
│   │   │   └── performance-profiles.ts        # Performance data
│   │   │
│   │   ├── management/
│   │   │   ├── health-manager.ts              # Provider health checks
│   │   │   ├── cost-optimizer.ts              # Cost-aware routing
│   │   │   └── rate-limiter.ts                # Rate limiting & queuing
│   │   │
│   │   ├── prompt/
│   │   │   ├── prompt-manager.ts              # Provider-specific optimization
│   │   │   ├── prompt-templates.ts            # Template definitions
│   │   │   └── token-counter.ts               # Token counting
│   │   │
│   │   ├── observability/
│   │   │   ├── request-logger.ts              # Structured logging
│   │   │   ├── metrics-collector.ts           # Metrics collection
│   │   │   └── tracing.ts                     # Distributed tracing
│   │   │
│   │   ├── config/
│   │   │   ├── providers.config.ts            # Provider initialization
│   │   │   └── defaults.ts                    # Default configurations
│   │   │
│   │   └── index.ts                           # Main exports
│   │
│   ├── agent-runner.ts                        # UPDATED: Use LLMRouter
│   ├── planner.ts                             # UPDATED: Use LLMRouter
│   ├── reflection-service.ts                  # UPDATED: Use LLMRouter
│   ├── ... (other services unchanged)
│   │
│   └── tools/
│       └── ... (unchanged)
│
├── tests/
│   ├── unit/
│   │   ├── llm-providers.test.ts
│   │   ├── llm-router.test.ts
│   │   ├── response-parser.test.ts
│   │   └── ...
│   │
│   ├── integration/
│   │   ├── agent-runner-with-llm-router.test.ts
│   │   ├── planner-with-providers.test.ts
│   │   └── ...
│   │
│   └── mocks/
│       ├── mock-providers.ts
│       └── mock-responses.ts
```

---

## MIGRATION STRATEGY

### Phase 1: Foundation (Weeks 1-2)
- [ ] Create LLM abstraction layer (core types, base provider)
- [ ] Implement OpenAI provider (should be almost identical to current code)
- [ ] Create LLMRouter with single-provider fallback
- [ ] Create response parser with JSON extraction
- [ ] **Risk**: Minimal - running under existing code

### Phase 2: Gradual Adoption (Weeks 3-4)
- [ ] Update `agent-runner.ts` to use LLMRouter
  - Keep `llmRequestFn` for testing
  - Add feature flag: `USE_LLM_ROUTER=false` (default)
  - Route through new system when flag enabled
- [ ] Update `planner.ts` to use LLMRouter
- [ ] Update `reflection-service.ts` to use LLMRouter
- [ ] **Risk**: Feature flags allow rollback if issues

### Phase 3: Provider Support (Weeks 5-6)
- [ ] Implement Hugging Face provider
- [ ] Implement AMD Cloud provider
- [ ] Implement local OSS provider (vLLM/TGI)
- [ ] Add health checks & fallback orchestration
- [ ] **Risk**: New providers tested independently

### Phase 4: Optimization (Weeks 7-8)
- [ ] Add cost-aware routing
- [ ] Add prompt optimization
- [ ] Add comprehensive observability
- [ ] Performance tuning & benchmarking
- [ ] **Risk**: Optimization bugs caught in staging

### Phase 5: Production (Weeks 9-10)
- [ ] Remove feature flags
- [ ] Migrate to new system entirely
- [ ] Monitor metrics, adjust with real data
- [ ] **Risk**: Gradual rollout with canary deployments

---

## BREAKING CHANGES & RISK ANALYSIS

### ✅ NO Orchestration Changes Required
```typescript
// AgentRunner's core loop STAYS THE SAME
// Just different LLM calling mechanism
```

### ⚠️ BREAKING: Response Shape Changes

**Before:**
```typescript
{ output_text?: string; output?: unknown }
```

**After:**
```typescript
{
  content: string;
  usage: TokenUsage;
  metadata: ResponseMetadata;
  provider: string;
  finishReason?: "stop" | "max_tokens" | "error";
}
```

**Migration:**
```typescript
// Adapter layer for backward compat in Phase 2
function adaptNewResponseToOld(response: LLMResponse): { output_text?: string } {
  return { output_text: response.content };
}
```

### ⚠️ BREAKING: Error Handling Changes

**Before:**
```typescript
try {
  const response = await this.requestLlmResponse(model, input);
} catch (err) {
  console.error("LLM_ERROR:", err.message);
}
```

**After:**
```typescript
try {
  const response = await this.router.route(request);
} catch (err) {
  if (err instanceof LLMError && err.isRetryable) {
    // Handle with retry logic
  } else {
    // Permanent failure - escalate
  }
}
```

### ⚠️ BREAKING: Provider Health Assumptions

**Current**: Assumes OpenAI is always available  
**New**: Must handle provider failures gracefully

```typescript
// New requirement: every LLM call must have fallback plan
auto result = await router.route(request);
// If primary provider fails, router auto-selects alternative
```

### ✅ NON-BREAKING: Dependency Injection Preserved

```typescript
// Still works exactly the same
constructor(options?: {
  llmRequestFn?: LlmRequestFn;  // ← Still supported for testing
  // ... other options
}) {
  if (options?.llmRequestFn) {
    // Use custom function for testing
  } else {
    // Use LLMRouter in production
  }
}
```

---

## PROVIDER IMPLEMENTATIONS

### OpenAI Provider

```typescript
import OpenAI from "openai";
import { BaseLLMProvider } from "../core/base-provider";

export class OpenAIProvider extends BaseLLMProvider {
  private client: OpenAI;
  
  constructor(apiKey: string, baseUrl?: string) {
    super();
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      defaultHeaders: {
        "user-agent": "task-worker/llm-provider",
      },
    });
  }
  
  get name(): string {
    return "openai";
  }
  
  async generateCompletion(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    
    try {
      const response = await this.client.chat.completions.create({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        top_p: request.topP,
        max_tokens: request.maxTokens,
      });
      
      return {
        content: response.choices[0]?.message.content ?? "",
        usage: {
          promptTokens: response.usage?.prompt_tokens ?? 0,
          completionTokens: response.usage?.completion_tokens ?? 0,
          total: () => (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0),
        },
        metadata: {
          model: request.model,
          provider: this.name,
          latencyMs: Date.now() - startTime,
          requestId: response.id ?? "",
          timestamp: new Date(),
          finishReason: response.choices[0]?.finish_reason as any,
        },
        provider: this.name,
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }
  
  async generateStructured<T>(
    request: LLMRequest,
    schema: ZodSchema<T>
  ): Promise<StructuredLLMResponse<T>> {
    // Use OpenAI's JSON mode
    const response = await this.generateCompletion({
      ...request,
      messages: [
        ...request.messages,
        {
          role: "user",
          content: `Respond with valid JSON matching this schema: ${JSON.stringify(schema._def)}`,
        },
      ],
    });
    
    const parsed = JSON.parse(response.content);
    const validated = schema.parse(parsed);
    
    return {
      content: validated,
      raw: response.content,
      usage: response.usage,
      metadata: response.metadata,
      provider: response.provider,
    };
  }
  
  getCapabilities(): ProviderCapabilities {
    return {
      models: [
        {
          id: "gpt-4",
          name: "GPT-4",
          contextWindow: 8192,
          maxOutputTokens: 4096,
          releaseDate: new Date("2023-03-14"),
          costPer1kPromptTokens: 0.03,
          costPer1kCompletionTokens: 0.06,
          supportsStructuredOutput: false,
          supportsToolCalling: true,
        },
        {
          id: "gpt-4o",
          name: "GPT-4 Omni",
          contextWindow: 128000,
          maxOutputTokens: 4096,
          releaseDate: new Date("2024-05-13"),
          costPer1kPromptTokens: 0.005,
          costPer1kCompletionTokens: 0.015,
          supportsStructuredOutput: true,
          supportsToolCalling: true,
        },
        // ... more models
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
      supportedContentTypes: ["text", "image"],
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
      // Lightweight health check
      await this.client.models.list();
      return {
        isHealthy: true,
        lastCheckedAt: new Date(),
        responseTimeMs: Date.now() - startTime,
        errorRate: 0,
        availabilityPercent: 100,
        circuitBreakerStatus: "closed",
      };
    } catch (error) {
      return {
        isHealthy: false,
        lastCheckedAt: new Date(),
        responseTimeMs: Date.now() - startTime,
        errorRate: 1.0,
        availabilityPercent: 0,
        circuitBreakerStatus: "open",
        reason: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
  
  private handleError(error: unknown): LLMError {
    if (error instanceof OpenAI.APIError) {
      return new LLMError(
        error.message,
        error.code ?? "OPENAI_ERROR",
        // Retry if rate limit, server error, or timeout
        error.status === 429 || error.status === 500 || error.status === 503,
        this.name,
        error
      );
    }
    
    return new LLMError(
      error instanceof Error ? error.message : "Unknown error",
      "UNKNOWN_ERROR",
      false,
      this.name,
      error instanceof Error ? error : undefined
    );
  }
}
```

### Hugging Face Provider

```typescript
import { HfInference } from "@huggingface/inference";

export class HuggingFaceProvider extends BaseLLMProvider {
  private client: HfInference;
  
  constructor(apiKey: string) {
    super();
    this.client = new HfInference(apiKey);
  }
  
  get name(): string {
    return "huggingface";
  }
  
  async generateCompletion(request: LLMRequest): Promise<LLMResponse> {
    const startTime = Date.now();
    
    // Convert chat messages to prompt
    const prompt = this.messagesToPrompt(request.messages);
    
    try {
      const response = await this.client.textGeneration({
        model: request.model,
        inputs: prompt,
        parameters: {
          max_new_tokens: request.maxTokens ?? 512,
          temperature: request.temperature ?? 0.7,
          top_p: request.topP,
        },
      });
      
      return {
        content: response.generated_text,
        usage: {
          promptTokens: this.estimateTokens(prompt),
          completionTokens: this.estimateTokens(response.generated_text),
          total: () => this.estimateTokens(prompt) + this.estimateTokens(response.generated_text),
        },
        metadata: {
          model: request.model,
          provider: this.name,
          latencyMs: Date.now() - startTime,
          requestId: Math.random().toString(36).slice(2),
          timestamp: new Date(),
        },
        provider: this.name,
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }
  
  async generateStructured<T>(
    request: LLMRequest,
    schema: ZodSchema<T>
  ): Promise<StructuredLLMResponse<T>> {
    // Hugging Face doesn't have native structured output
    // Use prompt engineering with retry logic
    const response = await this.generateCompletion({
      ...request,
      messages: [
        ...request.messages,
        {
          role: "user",
          content: `Return a valid JSON object matching this schema: ${JSON.stringify(schema._def)}. Return ONLY the JSON, no other text.`,
        },
      ],
    });
    
    // Retry loop for JSON extraction
    let retries = 3;
    while (retries > 0) {
      try {
        const parsed = JSON.parse(response.content);
        const validated = schema.parse(parsed);
        return {
          content: validated,
          raw: response.content,
          usage: response.usage,
          metadata: response.metadata,
          provider: response.provider,
        };
      } catch (error) {
        retries--;
        if (retries === 0) {
          throw new StructuredOutputError(
            "Failed to parse structured output from Hugging Face",
            null
          );
        }
      }
    }
    
    throw new StructuredOutputError("Structured output parsing failed");
  }
  
  getCapabilities(): ProviderCapabilities {
    return {
      models: [
        {
          id: "mistral-7b",
          name: "Mistral 7B",
          contextWindow: 32000,
          maxOutputTokens: 4096,
          releaseDate: new Date("2023-09-27"),
          costPer1kPromptTokens: 0.0001,
          costPer1kCompletionTokens: 0.0001,
          supportsStructuredOutput: false, // Requires workaround
          supportsToolCalling: false,
        },
        {
          id: "meta-llama/Llama-2-70b-chat-hf",
          name: "Llama 2 70B Chat",
          contextWindow: 4096,
          maxOutputTokens: 2048,
          releaseDate: new Date("2023-07-18"),
          costPer1kPromptTokens: 0.0006,
          costPer1kCompletionTokens: 0.0006,
          supportsStructuredOutput: false,
          supportsToolCalling: false,
        },
      ],
      supportsStructuredOutput: false,
      supportsToolCalling: false,
      supportsVision: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      supportsBatchProcessing: false,
      maxRequestsPerMinute: 100,
      maxConcurrentRequests: 10,
      maxContextWindows: 32000,
      supportedContentTypes: ["text"],
      availabilityGuarantee: "best-effort",
      typicalLatencyMs: {
        min: 500,
        p50: 2000,
        p99: 5000,
      },
    };
  }
  
  private messagesToPrompt(messages: Message[]): string {
    return messages
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join("\n");
  }
  
  private estimateTokens(text: string): number {
    // Simple heuristic: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}
```

### AMD Cloud Provider (Template)

```typescript
export class AMDCloudProvider extends BaseLLMProvider {
  private apiKey: string;
  private baseUrl: string;
  
  constructor(apiKey: string, baseUrl: string) {
    super();
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  
  get name(): string {
    return "amd-cloud";
  }
  
  async generateCompletion(request: LLMRequest): Promise<LLMResponse> {
    // Implement AMD Cloud-specific API calls
    // Note: Adapt based on actual AMD Cloud API documentation
    
    const startTime = Date.now();
    
    try {
      const response = await fetch(`${this.baseUrl}/v1/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          temperature: request.temperature ?? 0.7,
          max_tokens: request.maxTokens,
        }),
      });
      
      if (!response.ok) {
        throw new Error(`AMD Cloud API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      return {
        content: data.choices[0]?.message.content ?? "",
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          total: () => (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
        },
        metadata: {
          model: request.model,
          provider: this.name,
          latencyMs: Date.now() - startTime,
          requestId: data.id ?? "",
          timestamp: new Date(),
        },
        provider: this.name,
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }
  
  getCapabilities(): ProviderCapabilities {
    // Customize based on AMD Cloud offerings
    return {
      models: [
        {
          id: "amd-llama2-70b",
          name: "AMD-Optimized Llama 2 70B",
          contextWindow: 4096,
          maxOutputTokens: 2048,
          releaseDate: new Date("2024-01-01"),
          costPer1kPromptTokens: 0.00005,
          costPer1kCompletionTokens: 0.00005,
          supportsStructuredOutput: false,
          supportsToolCalling: false,
        },
      ],
      supportsStructuredOutput: false,
      supportsToolCalling: false,
      supportsVision: false,
      supportsStreaming: true,
      supportsPromptCaching: false,
      supportsBatchProcessing: true,
      maxRequestsPerMinute: 1000,
      maxConcurrentRequests: 100,
      maxContextWindows: 4096,
      supportedContentTypes: ["text"],
      availabilityGuarantee: "99.9%",
      typicalLatencyMs: {
        min: 100,
        p50: 400,
        p99: 2000,
      },
    };
  }
}
```

---

## ROUTING & ORCHESTRATION

### LLMRouter Implementation Strategy

```typescript
export class LLMRouter {
  constructor(
    private providers: Map<string, BaseLLMProvider> = new Map(),
    private registry: ModelCapabilityRegistry,
    private healthManager: ProviderHealthManager,
    private costOptimizer: CostOptimizer,
    private logger: RequestLogger
  ) {}
  
  /**
   * Intelligently route request to best provider
   */
  async route(request: LLMRequest): Promise<{
    response: LLMResponse;
    provider: string;
    attemptCount: number;
  }> {
    const routingCriteria = this.buildRoutingCriteria(request);
    const selectedProviders = this.selectProviders(routingCriteria);
    
    if (selectedProviders.length === 0) {
      throw new LLMError(
        "No suitable providers available for this request",
        "NO_SUITABLE_PROVIDER",
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
        const startTime = Date.now();
        const response = await provider.generateCompletion(request);
        
        this.logger.logSuccess({
          provider: providerName,
          model: request.model,
          latencyMs: Date.now() - startTime,
          tokens: response.usage.total(),
        });
        
        return {
          response,
          provider: providerName,
          attemptCount,
        };
      } catch (error) {
        lastError = error instanceof LLMError
          ? error
          : new LLMError(
              error instanceof Error ? error.message : "Unknown error",
              "ROUTING_ERROR",
              true,
              providerName,
              error instanceof Error ? error : undefined
            );
        
        this.logger.logFailure({
          provider: providerName,
          model: request.model,
          error: lastError.message,
          isRetryable: lastError.isRetryable,
        });
        
        // Only continue if error is retryable and we have more providers
        if (!lastError.isRetryable || selectedProviders.indexOf(providerName) === selectedProviders.length - 1) {
          break;
        }
      }
    }
    
    throw lastError ?? new LLMError(
      "All providers failed",
      "ALL_PROVIDERS_FAILED",
      false
    );
  }
  
  /**
   * Route with structured output guarantee
   */
  async routeStructured<T>(
    request: LLMRequest,
    schema: ZodSchema<T>
  ): Promise<StructuredLLMResponse<T>> {
    // Filter providers that support structured output
    const criteria = this.buildRoutingCriteria(request);
    criteria.requiresStructuredOutput = true;
    
    const selectedProviders = this.selectProviders(criteria);
    
    if (selectedProviders.length === 0) {
      throw new LLMError(
        "No providers support structured output for this request",
        "NO_STRUCTURED_OUTPUT_SUPPORT",
        false
      );
    }
    
    let lastError: Error | null = null;
    
    for (const providerName of selectedProviders) {
      const provider = this.providers.get(providerName);
      if (!provider) continue;
      
      try {
        return await provider.generateStructured(request, schema);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    
    throw new StructuredOutputError(
      `Failed to generate structured output after trying ${selectedProviders.length} providers`,
      null
    );
  }
  
  /**
   * Select providers based on routing criteria
   */
  private selectProviders(criteria: RoutingCriteria): string[] {
    const candidates: Array<{ name: string; score: number }> = [];
    
    for (const [name, provider] of this.providers.entries()) {
      // Skip unhealthy providers unless required
      if (criteria.requireHealthy && !this.healthManager.isHealthy(provider)) {
        continue;
      }
      
      // Check exclusions
      if (criteria.excludeProviders?.includes(name)) {
        continue;
      }
      
      // Check preferences
      if (criteria.preferredProviders?.length && 
          !criteria.preferredProviders.includes(name)) {
        continue;
      }
      
      const capabilities = provider.getCapabilities();
      
      // Check capability requirements
      if (criteria.requiresStructuredOutput && 
          !capabilities.supportsStructuredOutput) {
        continue;
      }
      
      if (criteria.requiresToolCalling && 
          !capabilities.supportsToolCalling) {
        continue;
      }
      
      // Calculate routing score
      let score = 1.0;
      
      // Cost optimization
      if (criteria.optimizeFor === "cost") {
        // Score inversely to cost
        const estimatedCost = this.costOptimizer.estimateCost(provider, criteria);
        score *= 1 / (1 + estimatedCost);
      }
      
      // Latency optimization
      if (criteria.optimizeFor === "latency") {
        score *= 1 / (1 + capabilities.typicalLatencyMs.p50);
      }
      
      // Reliability optimization
      if (criteria.optimizeFor === "reliability") {
        const health = this.healthManager.getHealth(name);
        score *= health.availabilityPercent / 100;
      }
      
      candidates.push({ name, score });
    }
    
    // Sort by score (highest first) and return provider names
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
}
```

---

## OBSERVABILITY & MONITORING

### Key Metrics to Track

```typescript
interface MetricsCollector {
  // Per-provider metrics
  recordRequest(provider: string, request: LLMRequest): void;
  recordSuccess(provider: string, response: LLMResponse, latencyMs: number): void;
  recordFailure(provider: string, error: LLMError): void;
  
  // Aggregated metrics
  getProviderMetrics(provider: string): ProviderMetrics;
  getAllMetrics(): Map<string, ProviderMetrics>;
  
  // Cost tracking
  recordCost(provider: string, costUsd: number, model: string): void;
  getDailyCost(provider?: string): number;
}

// Example metrics to export:
// - Provider availability (%)
// - Average latency (ms)
// - Error rates (%)
// - Cost per request (USD)
// - Token efficiency (tokens/second)
// - Success rate by model
// - Fallback frequency
```

### Tracing Strategy

```typescript
interface RequestTrace {
  requestId: string;
  startTime: Date;
  endTime?: Date;
  
  // Routing
  routingAttempts: Array<{
    provider: string;
    reason?: string;
    latencyMs?: number;
    error?: string;
  }>;
  
  // Selected provider
  selectedProvider: string;
  selectedModel: string;
  
  // Execution
  finalStatus: "success" | "error" | "fallback";
  finalLatencyMs: number;
  
  // Cost
  estimatedCost: number;
  actualCost: number;
  
  // Context
  taskId?: string;
  conversationId?: string;
  phase?: string;
}
```

---

## OSS MODEL RECOMMENDATIONS

### For Planning Tasks

**Best Option: Mistral 7B or Llama 2 13B**

```
Why:
- Good instruction following
- Reasonable context window (32K for Mistral)
- Cost-effective ($0.0001 per 1k tokens on HF)
- Deployment: Hugging Face Inference, vLLM, TGI

Prompt engineering tip:
- Use system prompts with explicit JSON structure
- Break planning into numbered steps
- Provide examples of output format

Model: mistralai/Mistral-7B-v0.1
Latency: ~1-2s per completion
Cost: ~$0.00001 per completion
```

### For Tool Calling / Function Routing

**Best Option: Llama 2 70B (via HF) or Mistral Instruct**

```
Why:
- Better at following tool schemas
- Instruction tuning works well for routing
- Can be guided with prompts to output function calls

Prompt engineering tip:
- Use token budget: <1000 tokens for decision
- Provide tool descriptions in structured format
- Use chain-of-thought reasoning: "Let methink about which tool..."

Model: meta-llama/Llama-2-70b-chat-hf
Latency: ~2-4s per decision
Cost: ~$0.00006 per decision
```

### For Structured JSON Generation

**Challenge**: Open-source models don't have native JSON mode like GPT-4

**Solution Stack**:

1. **Primary**: Use prompt engineering + validation
```typescript
// Instruction that works well:
`Return ONLY a valid JSON object with keys: {goal, steps, reasoning}.
No markdown, no explanation, just JSON.`
```

2. **Fallback**: Use Outlines library (OSS)
```
pip install outlines
- Constrains sampling to valid JSON
- Can enforce schema at token level
- ~10-20% slower but guarantees valid JSON
```

3. **Best Practice**: Temperature=0 + retry logic
```typescript
// Set temp to 0 for deterministic output
// Retry up to 3x with slight prompt variations
// Fall back to fallback plan if all retries fail
```

### For Autonomous Reasoning / Reflection

**Best Option: Llama 2 70B or Mistral Large (via vLLM)**

```
Why:
- Can handle complex reasoning tasks
- Good at identifying what worked/failed
- Generalizes well across domains

Prompt engineering tip:
- Provide execution history as context
- Ask explicit failure analysis questions
- Use few-shot examples of good reflections

Cost: ~$0.0006 per reflection (acceptable for post-execution)
```

### Lightweight Retries (When Speed Matters)

**Best Option: Distilled models**

```
philschmid/distilbert-onnx
tiny-random-gpt2 (for local testing)
microsoft/phi-2 (3B parameter, very fast)

When to use:
- Quick validation passes
- Token-level decisions (not full completions)
```

### Production Recommended Stack

```
┌──────────────────────────────────────────────────────────────┐
│ RECOMMENDED OSS MODEL STACK FOR AUTONOMOUS AGENTS              │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│ Planning:           Mistral 7B Instruct (HF or vLLM)          │
│ Tool Routing:       Llama 2 70B Chat (HF or vLLM)             │
│ JSON Generation:    Mistral 7B + Outlines (local vLLM)        │
│ Reflection:         Llama 2 70B (post-execution, high latency) │
│ Fast Validations:   Phi-2 or TinyLlama (local, <100ms)        │
│                                                                │
│ Deployment Options:                                           │
│ - Hugging Face Inference (easy, ~$5-50/day per model)        │
│ - LocalLLM (vLLM on GPU, free but requires hardware)         │
│ - AMD Cloud (when available, likely competitive on price)     │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

### JSON Schema Enforcement for OSS Models

```typescript
import Outlines from "outlines";

// Use Outlines to guarantee JSON output structure
const schemaStr = `{
  "type": "object",
  "properties": {
    "toolName": { "type": "string" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "parameters": { "type": "object" }
  },
  "required": ["toolName", "confidence", "parameters"]
}`;

const generator = Outlines.generate.json(model, schemaStr);
const result = await generator(prompt);
// result is GUARANTEED valid JSON matching schema
```

---

## IMPLEMENTATION BEST PRACTICES

### 1. **Request ID Propagation**
```typescript
// Every request gets unique ID for tracing
const requestId = crypto.randomUUID();
const request: LLMRequest = {
  // ... other fields
  context: {
    taskId: task.id,
    conversationId: task.conversationId,
  },
  metadata: {
    requestId,
    timestamp: new Date(),
  },
};

// Track through all layers
logger.log(`[${requestId}] Routing to provider`);
```

### 2. **Graceful Degradation**
```typescript
// Always have fallback plan
const response = await router.route(request);

// If structured output fails, use fallback
const parsed = await parser.parseWithFallback(
  response.content,
  schema,
  FALLBACK_PLAN  // ← Always defined
);
```

### 3. **Cost Awareness**
```typescript
// Track costs per request
async route(request: LLMRequest): Promise<LLMResponse> {
  const response = await provider.generateCompletion(request);
  
  const cost = this.costOptimizer.calculateCost(
    response.usage,
    response.metadata.model
  );
  
  response.metadata.cost = cost;
  this.costOptimizer.recordCost(
    response.provider,
    cost.estimatedCost,
    response.metadata.model
  );
  
  // Alert on unexpected costs
  if (cost.estimatedCost > MAX_COST_PER_REQUEST) {
    logger.warn(`Cost exceeded: $${cost.estimatedCost}`);
  }
  
  return response;
}
```

### 4. **Provider Health Checks**
```typescript
// Run health checks periodically
setInterval(async () => {
  for (const provider of providers) {
    const health = await provider.healthCheck();
    healthManager.recordHealth(provider.name, health);
    
    if (!health.isHealthy) {
      logger.error(`Provider ${provider.name} unhealthy:`, health.reason);
      // Automatically stop routing to this provider
    }
  }
}, 60_000);  // Every 60 seconds
```

### 5. **Structured Logging**
```typescript
// Structured logs, not random console.log
logger.info("llm:request", {
  provider: request.metadata?.provider,
  model: request.model,
  taskId: request.context?.taskId,
  tokenEstimate: estimateTokens(request.messages),
  capabilities: request.capabilities,
  routingPreferences: request.routingPreferences,
});

logger.info("llm:response", {
  provider: response.provider,
  model: response.metadata.model,
  latencyMs: response.metadata.latencyMs,
  tokens: response.usage.total(),
  cost: response.metadata.cost?.estimatedCost,
  finishReason: response.finishReason,
});
```

### 6. **Timeout & Cancellation**
```typescript
// Every provider request needs timeout
async generateCompletion(request: LLMRequest): Promise<LLMResponse> {
  const timeout = request.routingPreferences?.maxLatencyMs ?? 30_000;
  
  try {
    return await Promise.race([
      this.client.chat.completions.create(...),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new LLMError(
            "Request timeout",
            "TIMEOUT",
            true // retryable
          )),
          timeout
        )
      ),
    ]);
  } catch (error) {
    if (error instanceof LLMError && error.code === "TIMEOUT") {
      // Try next provider
      throw error;
    }
    // ...
  }
}
```

### 7. **Error Classification**
```typescript
// Every provider error must be classified
enum ErrorCategory {
  TRANSIENT = "transient",      // Will likely succeed on retry
  PERMANENT = "permanent",      // Will always fail
  PROVIDER_UNAVAILABLE = "provider_unavailable",
  CAPABILITY_MISSING = "capability_missing",
  RATE_LIMITED = "rate_limited",
  QUOTA_EXCEEDED = "quota_exceeded",
}

class LLMError extends Error {
  constructor(
    message: string,
    code: string,
    public category: ErrorCategory,
    public isRetryable: boolean
  ) {
    super(message);
  }
}
```

### 8. **Dependency Injection for Testing**
```typescript
// Every component receives dependencies
constructor(
  private providers: BaseLLMProvider[] = DEFAULT_PROVIDERS,
  private registry: ModelCapabilityRegistry = DEFAULT_REGISTRY,
  private logger: ILogger = consoleLogger,
  private metricsCollector: MetricsCollector = noOpMetrics,
) {}

// In tests, inject mocks
const mockProvider = new MockLLMProvider();
const router = new LLMRouter([mockProvider], registry, healthManager);
```

### 9. **Validation at Boundaries**
```typescript
// Validate all external responses
async generateCompletion(request: LLMRequest): Promise<LLMResponse> {
  const response = await this.provider.generateCompletion(request);
  
  // Validate response shape
  if (!response.content || typeof response.content !== "string") {
    throw new LLMError("Invalid response: missing content", "INVALID_RESPONSE", false);
  }
  
  if (!response.usage || typeof response.usage.total !== "function") {
    throw new LLMError("Invalid response: missing usage", "INVALID_RESPONSE", false);
  }
  
  return response;
}
```

### 10. **Retry Strategy**
```typescript
async routeWithRetry(
  request: LLMRequest,
  maxAttempts: number = 3
): Promise<LLMResponse> {
  let lastError: LLMError | null = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await this.route(request);
      return response;
    } catch (error) {
      lastError = error instanceof LLMError
        ? error
        : new LLMError(String(error), "UNKNOWN", false);
      
      // Don't retry permanent errors
      if (!lastError.isRetryable) {
        throw lastError;
      }
      
      // Exponential backoff
      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  
  throw lastError ?? new LLMError("All retries failed", "RETRY_EXHAUSTED", false);
}
```

---

## TOP 10 MISTAKES TO AVOID

### 1. ❌ **Storing Models in the Router**
```typescript
// WRONG: Hard to test, tight coupling
class LLMRouter {
  private providers = [
    new OpenAIProvider(apiKey),
    new HuggingFaceProvider(apiKey),
  ];
}

// RIGHT: Inject dependencies
class LLMRouter {
  constructor(private providers: BaseLLMProvider[]) {}
}
```

### 2. ❌ **Assuming All Responses Have Same Shape**
```typescript
// WRONG: Will fail with non-OpenAI providers
const content = response.choices[0].message.content;

// RIGHT: Use abstracted contract
const content = response.content;  // ← Unified interface
```

### 3. ❌ **Hardcoding Retry Logic**
```typescript
// WRONG: Scattered retry logic across codebase
try {
  const response = await provider.generate(request);
} catch (error) {
  // Retry logic here
}

// RIGHT: Centralized retry orchestration
const response = await router.routeWithRetry(request, { maxAttempts: 3 });
```

### 4. ❌ **No Timeout on LLM Calls**
```typescript
// WRONG: Can hang forever
const response = await provider.generateCompletion(request);

// RIGHT: Timeout ensures responsiveness
const response = await withTimeout(
  provider.generateCompletion(request),
  30_000  // 30 second hard limit
);
```

### 5. ❌ **Assuming Structured Output Works**
```typescript
// WRONG: OSS models don't guarantee valid JSON
const result = JSON.parse(response.content);

// RIGHT: Retry with fallback
const result = await parser.parseWithFallback(
  response.content,
  schema,
  fallbackValue
);
```

### 6. ❌ **No Cost Tracking**
```typescript
// WRONG: Can't optimize or forecast costs
const response = await provider.generateCompletion(request);

// RIGHT: Track every request
response.metadata.cost = this.calculateCost(response.usage);
this.costCollector.record(response.metadata.cost);
```

### 7. ❌ **Ignoring Provider Health**
```typescript
// WRONG: Doesn't check if provider is working
const provider = this.providers[0];

// RIGHT: Check health before routing
if (!this.healthManager.isHealthy(provider)) {
  throw new Error("Provider unhealthy");
}
```

### 8. ❌ **Tightly Coupling to One Response Format**
```typescript
// WRONG: Only works with OpenAI format
const toolCalls = response.choices[0].message.tool_calls;

// RIGHT: Provider-agnostic parsing
const toolCalls = await parser.parseFunctionCalls(response.content);
```

### 9. ❌ **No Fallback Plan When LLM Fails**
```typescript
// WRONG: If LLM fails, task fails
const plan = await llm.generatePlan(context);

// RIGHT: Always have fallback
const plan = await llm.generatePlan(context) ?? buildFallbackPlan(context);
```

### 10. ❌ **Propagating Internal Errors to Users**
```typescript
// WRONG: Users see internal implementation details
catch (error) {
  return { error: error.message };  // "OpenAI API key invalid"
}

// RIGHT: User-friendly errors
catch (error) {
  if (error instanceof LLMError) {
    return { error: "Unable to process request. Please retry." };
  }
}
```

---

## IDEAL vs MINIMAL vs SCALABLE ARCHITECTURES

### **IDEAL ARCHITECTURE** (Full Implementation)
- ✅ All 4 providers (OpenAI, HF, AMD, OSS)
- ✅ Full cost-aware routing
- ✅ Comprehensive observability
- ✅ Provider health checks
- ✅ Prompt optimization per provider
- ✅ Circuit breaker patterns
- ✅ Distributed tracing integration
- 📊 **Effort**: 8-10 weeks
- 💰 **Value**: Maximum flexibility, optimization, maintainability

### **MINIMAL VIABLE MIGRATION** (Phase 2-3)
- ✅ OpenAI provider (copy current impl)
- ✅ Basic LLMRouter with fallback
- ✅ Response parser
- ✅ Hugging Face provider (simple impl)
- ❌ Cost routing (use fallback)
- ❌ Complex observability
- ❌ Advanced health checks
- 📊 **Effort**: 3-4 weeks
- 💰 **Value**: Vendor flexibility, clean architecture

### **LONG-TERM SCALABLE ARCHITECTURE**
- ✅ Everything from Ideal
- ✅ Plus: Multi-region provider support
- ✅ Plus: Local inference cache ("model distillation")
- ✅ Plus: Custom fine-tuned models per task type
- ✅ Plus: Provider optimization feedback loop
- 📊 **Effort**: 12-16 weeks total
- 💰 **Value**: Enterprise-grade, self-optimizing system

---

## MIGRATION IMPLEMENTATION ROADMAP

### Week 1-2: Foundation
```
Day 1-2:  Design LLMRequest/LLMResponse contracts
Day 3-4:  Create BaseLLMProvider abstract class
Day 5:    Implement OpenAI provider (should take ~1-2 hours)
Day 6:    Create LLMRouter stub with single provider support
Day 7:    Create LLMResponseParser for JSON extraction
Day 8-9:  Unit tests for core components
Day 10:   Integration test with existing agent-runner (non-breaking)
```

### Week 3-4: Integration
```
Day 11-12: Create feature flag: USE_LLM_ROUTER=false (default)
Day 13:    Update agent-runner to use LLMRouter when flag enabled
Day 14:    Update planner to use LLMRouter when flag enabled
Day 15:    Update reflection-service to use LLMRouter when flag enabled
Day 16-17: Integration testing in staging (flag OFF then ON)
Day 18-19: Performance benchmarking vs old system
Day 20:    Deploy to production with flag OFF (zero risk)
```

### Week 5-6: Provider Expansion
```
Day 21-22: Implement Hugging Face provider
Day 23:    Implement AMD Cloud provider (template)
Day 24:    Implement local OSS provider (vLLM/TGI)
Day 25-26: Router capability matching
Day 27:    Router cost-aware fallback selection
Day 28-30: Integration tests with all providers
```

### Week 7-8: Optimization
```
Day 31-32: Add ProviderHealthManager
Day 33:    Add circuit breaker pattern
Day 34-35: Add structured observability/logging
Day 36:    Add cost tracking & optimization
Day 37-38: Performance tuning & benchmarks
Day 39-40: Final integration testing
```

---

## IMPLEMENTATION CHECKLIST

- [ ] Create `/services/llm` directory structure
- [ ] Implement `BaseLLMProvider` abstract class
- [ ] Define `LLMRequest` and `LLMResponse` contracts
- [ ] Implement `OpenAIProvider`
- [ ] Implement `LLMRouter` (single-provider fallback initially)
- [ ] Implement `LLMResponseParser`
- [ ] Add feature flag `USE_LLM_ROUTER`
- [ ] Update `agent-runner.ts` to use router
- [ ] Update `planner.ts` to use router
- [ ] Update `reflection-service.ts` to use router
- [ ] Write unit tests for all components
- [ ] Write integration tests for orchestration
- [ ] Deploy to staging with feature flag OFF
- [ ] Test with feature flag ON
- [ ] Implement Hugging Face provider
- [ ] Implement AMD Cloud provider
- [ ] Implement local OSS provider
- [ ] Add provider health checks
- [ ] Add cost tracking
- [ ] Add observability/logging
- [ ] Performance benchmarking
- [ ] Remove feature flag
- [ ] Deploy to production

---

## SUMMARY: KEY TAKEAWAYS

### Architecture Priorities
1. **Provider Abstraction** - No hardcoded provider coupling
2. **Request/Response Contracts** - Unified, provider-agnostic
3. **Graceful Degradation** - Always have fallback plan
4. **Observability** - Track every LLM interaction
5. **Cost Awareness** - Optimize within constraints

### Critical Non-Negotiables
- ✅ Dependency injection for all components
- ✅ Comprehensive error handling & classification
- ✅ Timeout on all async operations
- ✅ Circuit breaker for provider reliability
- ✅ Structured logging & tracing
- ✅ Cost tracking per request

### Why This Design Wins for AMD Hackathon
- 🚀 **Flexibility**: Swap providers without code changes
- 💰 **Cost**: Route to AMD Cloud or cheaper models automatically
- 📊 **Optimization**: Real data-driven routing improvements
- 🏆 **Production-Ready**: Enterprise reliability patterns
- 🔄 **Vendor Agnostic**: Showcase multi-provider orchestration

---

**Next Steps**: 
1. Review this design document
2. Clarify any provider-specific requirements
3. Start with Phase 1 (Foundation) implementation
4. Use feature flags to enable gradual adoption
