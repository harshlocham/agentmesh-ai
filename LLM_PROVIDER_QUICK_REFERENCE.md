# LLM Provider Migration - Quick Reference
## One-Page Guide for AMD Hackathon Implementation

---

## 🎯 MIGRATION ROADMAP AT A GLANCE

```
TIMELINE:        Weeks 1-2          Weeks 3-4          Weeks 5-6          Weeks 7-8          Week 9-10
                 FOUNDATION         INTEGRATION        EXPANSION          OPTIMIZATION       PRODUCTION
                 
What:            Core types,        Feature flags,     HF, AMD, OSS       Health checks,     Canary rollout,
                 Base provider,     Route legacy       providers,         cost optimization, Remove flags
                 OpenAI provider,   code              fallback orches.    observability
                 Router
                 
Risk:            ⚪ NONE           🟡 MINIMAL         🟡 LOW             🟡 LOW             🟢 MANAGED
                 (parallel)        (feature flags)    (new providers)    (optimization)     (canary)

Dependencies:    ✅ NONE            ✅ NONE            ✅ Phase 1-2        ✅ Phase 1-3       ✅ Phase 1-4

Status:          Foundation         Safe Integration   Capability         Production-      Full
                 Complete           in Place          Expansion          Ready             Deployment
```

---

## 📊 ARCHITECTURE AT A GLANCE

```typescript
// CURRENT STATE
AgentRunner.requestLlmResponse()
  └─→ new OpenAI({ apiKey })
      └─→ openai.responses.create()

// AFTER MIGRATION
AgentRunner (unchanged orchestration)
  └─→ LLMRouter.route(request)
      ├─→ selectProviders()
      ├─→ try OpenAIProvider
      ├─→ fallback HFProvider
      └─→ fallback AMDProvider
```

---

## 🚀 10 KEY INTERFACES YOU NEED

```typescript
// 1. Core Request
interface LLMRequest {
  messages: Message[];
  model: string;
  capabilities?: RequestCapabilities;
  context?: ExecutionContext;
  routingPreferences?: RoutingPreferences;
}

// 2. Core Response
interface LLMResponse {
  content: string;
  usage: TokenUsage;
  metadata: ResponseMetadata;
  provider: string;
}

// 3. Provider Base
abstract class BaseLLMProvider {
  abstract generateCompletion(request: LLMRequest): Promise<LLMResponse>;
  abstract generateStructured<T>(request: LLMRequest, schema): Promise<StructuredLLMResponse<T>>;
  abstract getCapabilities(): ProviderCapabilities;
  abstract healthCheck(): Promise<ProviderHealth>;
  abstract calculateCost(usage: TokenUsage, modelId: string): CostEstimate;
}

// 4. Router
class LLMRouter {
  route(request: LLMRequest): Promise<RoutingResult>;
  routeStructured<T>(request: LLMRequest, schema): Promise<StructuredLLMResponse<T>>;
}

// 5. Error
class LLMError extends Error {
  category: ErrorCategory;
  isRetryable: boolean;
  provider?: string;
}

// 6-10. See implementation guide for details
```

---

## 🔧 MINIMUM VIABLE IMPLEMENTATION (Weeks 1-2)

```
File Structure (just these files):
apps/task-worker/services/llm/
├── core/
│   ├── types.ts                    # 300 lines: All interfaces
│   └── base-provider.ts            # 50 lines: Abstract class
├── providers/
│   └── openai-provider.ts          # 250 lines: Copy current + adapt
├── router/
│   └── llm-router.ts               # 150 lines: Select + fallback
├── parsing/
│   └── response-parser.ts          # 100 lines: JSON extraction
└── index.ts                        # 10 lines: Re-exports

TOTAL: ~850 lines of NEW code
COMPLEXITY: LOW (mostly adapting existing)
```

---

## 🎯 MIGRATION STEPS (COPY-PASTE FRIENDLY)

### Step 1: Create Type Definitions (Day 1-2)
```bash
# Create directory structure
mkdir -p apps/task-worker/services/llm/{core,providers,router,parsing,management,registry,observability,config}

# Copy `types.ts` from implementation guide
# Copy `base-provider.ts` from implementation guide
```

### Step 2: Implement OpenAI Provider (Day 3-4)
```bash
# Copy `openai-provider.ts` from implementation guide
# Should take ~1-2 hours (mostly moving existing code)
```

### Step 3: Implement Router (Day 5-6)
```bash
# Copy `llm-router.ts` from implementation guide
# Start simple: single-provider with fallback
# Add multi-provider support in Phase 3
```

### Step 4: Add Tests (Day 7-10)
```bash
mkdir -p apps/task-worker/tests/{unit/llm,integration/llm,mocks}
# Copy test examples from implementation guide
```

### Step 5: Update Agent-Runner (Day 11-15)
```typescript
// In constructor:
const router = new LLMRouter({
  providers: new Map([
    [new OpenAIProvider(apiKey).name, new OpenAIProvider(apiKey)]
  ]),
  primaryProvider: "openai",
  maxRetries: 2
});

// In requestLlmResponse():
if (process.env.USE_LLM_ROUTER === "true") {
  const result = await router.route(request);
  return result.response;
}
// Else fallback to current impl
```

---

## 🧪 TESTING STRATEGY

### Unit Tests (1-2 days)
```typescript
// Test each provide independently
- OpenAIProvider.generateCompletion() ✓
- OpenAIProvider.healthCheck() ✓
- LLMResponseParser.extractJSON() ✓
- LLMRouter.selectProviders() ✓
```

### Integration Tests (1-2 days)
```typescript
// Test orchestration flow
- AgentRunner + Router ✓
- Planner + Router ✓
- Reflection + Router ✓
- Fallback scenarios ✓
```

### Staging Validation (1 day)
```bash
# Feature flag OFF → OLD behavior (baseline)
pm2 start ecosystem.config.js
npm run test:staging  # Should pass 100%

# Feature flag ON → NEW behavior
export USE_LLM_ROUTER=true
npm run test:staging  # Should pass 100%

# Compare metrics
- Latency: ±5% ✓
- Error rate: 0% ✓
- Cost: ±2% ✓
```

---

## 📋 CHECKLIST: READY FOR WEEK 1?

- [ ] Architecture document reviewed by team
- [ ] Implementation guide reviewed by team
- [ ] Directory structure plan approved
- [ ] OpenAI SDK version confirmed (v4.x)
- [ ] Environment variables planned
- [ ] Feature flag naming approved
- [ ] Staging environment ready
- [ ] Monitoring dashboards prepared
- [ ] Rollback plan documented
- [ ] Week 1 kickoff meeting scheduled

---

## ⚠️ CRITICAL DON'Ts

```
❌ DON'T hardcode OpenAI into router
❌ DON'T remove feature flag during Phase 2
❌ DON'T deploy Phase 3 without Phase 2 tests passing
❌ DON'T assume all responses have same format
❌ DON'T forget timeout on every request
❌ DON'T deploy without cost tracking
❌ DON'T assume JSON parsing will always work
❌ DON'T ignore error categories
❌ DON'T skip fallback implementation
❌ DON'T deploy to production without canary
```

---

## ✅ CRITICAL DOs

```
✅ DO inject all dependencies
✅ DO test every provider independently
✅ DO use feature flags for rollout
✅ DO track costs from day 1
✅ DO implement fallback logic early
✅ DO log everything structured
✅ DO set timeout on all requests
✅ DO classify all errors
✅ DO validate all responses at boundaries
✅ DO monitor staging for 24h before prod
```

---

## 📊 SUCCESS METRICS

### Phase 1-2 (Foundation + Integration)
```
✓ All unit tests pass (100%)
✓ Integration tests pass (100%)
✓ Feature flag ON/OFF both work
✓ Latency: 0% change (±5% acceptable)
✓ Error rate: 0%
✓ Cost tracking working
```

### Phase 3 (Expansion)
```
✓ HF provider integration tests pass
✓ AMD provider integration tests pass
✓ OSS provider integration tests pass
✓ Multi-provider routing works
✓ Fallback scenarios tested
```

### Phase 4 (Optimization)
```
✓ Health checks running
✓ Cost optimization active
✓ Observability complete
✓ Performance benchmarks recorded
✓ Production readiness checklist ✅
```

---

## 🎓 LEARNING PATH FOR TEAM

### For Backend Developers
1. Read `LLM_PROVIDER_ARCHITECTURE.md` (Sections 1-5)
2. Review `LLM_PROVIDER_IMPLEMENTATION_GUIDE.md` (Parts 1-4)
3. Implement OpenAI provider following code skeleton
4. Write unit tests
5. Integrate with agent-runner

### For DevOps/SRE
1. Read `LLM_PROVIDER_ARCHITECTURE.md` (Sections 10-14)
2. Review observability setup
3. Configure feature flags in deployment
4. Set up monitoring dashboards
5. Plan canary rollout

### For Product/Tech Leads
1. Read Executive Summary
2. Review Roadmap
3. Understand Risk Analysis
4. Review Success Metrics
5. Plan stakeholder communication

---

## 🔄 WEEK-BY-WEEK COMMIT PLAN

```
Week 1:
  • Commit 1: Core types + base provider
  • Commit 2: OpenAI provider implementation
  • Commit 3: Router implementation
  • Commit 4: Response parser
  • Commit 5: Unit tests

Week 2:
  • Commit 6: Legacy integration layer
  • Commit 7: Agent-runner with feature flag
  • Commit 8: Planner with feature flag
  • Commit 9: Reflection service with feature flag
  • Commit 10: Integration tests

Week 3:
  • Commit 11: Hugging Face provider
  • Commit 12: AMD Cloud provider
  • Commit 13: Local OSS provider
  • Commit 14: Multi-provider router tests

Week 4+:
  • Health checks
  • Cost tracking
  • Observability
  • Performance tuning
  • Production readiness
```

---

## 📞 DECISION TREE: WHICH PROVIDER?

```
User asks: "Which provider should I use?"

Q: Need structured JSON output reliably?
  YES → OpenAI or AMD Cloud (native support)
  NO → Any provider

Q: Optimizing for cost?
  YES → Check: Mistral 7B < Llama 2 70B < OpenAI GPT-4
       Route to cheapest with fallback to reliable

Q: Need tool calling?
  YES → OpenAI > Llama 2 70B > Mistral 7B
  NO → Any provider

Q: Operating in restricted environment (no internet)?
  YES → Local OSS (vLLM/TGI)
  NO → Use cloud providers

Q: What OS are you running on?
  NVIDIA → Use vLLM (best optimized)
  AMD → Use AMD Cloud (when available)
  Default → Use OpenAI (most reliable)
```

---

## 🎓 OSS MODEL QUICK PICKS

| Use Case | Model | Provider | Latency | Cost |
|----------|-------|----------|---------|------|
| **Planning** | Mistral 7B | HF Inference | 1-2s | $0.0001 |
| **Tool Routing** | Llama 2 70B | HF Inference | 2-4s | $0.00006 |
| **JSON Gen** | Mistral 7B + Outlines | Local | 0.5-1s | Free (local) |
| **Reflection** | Llama 2 70B | HF Inference | 2-4s | $0.00006 |
| **Fast Check** | Phi-2 | Local | 0.1-0.2s | Free (local) |
| **All-in-one** | GPT-4o | OpenAI | 0.3s | $0.015 |

---

## 🚨 COMMON PITFALLS & FIXES

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| No timeout on requests | Task worker hangs | Add prometheus timeout wrapper |
| Hardcoded provider | Can't swap providers | Use BaseLLMProvider abstraction |
| No error classification | All errors treated same | Implement ErrorCategory enum |
| Missing fallback | One provider down = total failure | Implement LLMRouter with 2+ providers |
| No cost tracking | Bills surprise you | Add cost estimation to every response |
| JSON parsing fails silently | Wrong behavior, no error | Add retry + fallback logic |
| Logs missing context | Can't debug issues | Add requestId to all logs |
| No health checks | Don't know provider status | Implement ProviderHealthManager |

---

## 💡 PRO TIPS

1. **Use feature flags conservatively**
   ```
   Week 1-2: USE_LLM_ROUTER=false (default)
   Week 3-4: Allows both via config
   Week 5-8: Recommend true
   Week 9+: Default true, old code removed
   ```

2. **Cost optimization sequence**
   ```
   Month 1: All requests go to OpenAI (most reliable)
   Month 2: A/B test with HF Inference (cheaper)
   Month 3: Cost-aware routing enabled
   Month 4+: Multi-provider optimization loop
   ```

3. **Structured output strategy**
   ```
   Primary: Provider's native JSON mode (OpenAI)
   Fallback: Prompt engineering + validation
   Last resort: Fallback deterministic plan
   ```

4. **Error handling pattern**
   ```
   Transient → Retry with backoff
   Rate limited → Queue and retry later
   Quota exceeded → Use cheaper/alternative provider
   Permanent → Log error, use fallback plan
   Provider down → Circuit breaker, skip provider
   ```

5. **Observability baseline**
   ```
   Day 1: Basic request/response logging
   Day 2: Add latency metrics
   Day 3: Add cost tracking
   Day 4: Add error classification
   Day 5: Add distributed tracing
   Day 6+: Advanced analytics & optimization
   ```

---

## 🏆 READY TO START?

```bash
# Day 1 morning checklist:
✓ Architecture document reviewed
✓ Team aligned on approach
✓ Environment approved
✓ Directory structure planned
✓ First code skeleton ready

# Day 1 end goal:
git commit -m "feat(llm): Add core type definitions and base provider"

# End of Week 1:
git commit -m "feat(llm): OpenAI provider + Router + tests"
```

---

## 📞 WHO TO ASK

```
Q: "How do I implement provider X?"
A: Use BaseLLMProvider as template + code from provider skeleton

Q: "What if JSON parsing fails?"
A: Use parseWithFallback() + fallback plan

Q: "Provider is slow, what do I do?"
A: Check ProviderHealth + switch to faster alternative via router

Q: "How do I track costs?"
A: Call calculateCost() on every response, store in observability system

Q: "How do I test this locally?"
A: Use MockLLMProvider + unit tests, feature flag for integration

Q: "Is this production-ready?"
A: After Phase 4 with monitoring + health checks + fallbacks

Q: "Can I deploy to production now?"
A: Only with feature flag OFF. Canary rollout required for ON.
```

---

## 📚 DOCUMENT STRUCTURE

```
1. LLM_PROVIDER_ARCHITECTURE.md (60 pages)
   ├─ Executive Summary
   ├─ Core Design Principles
   ├─ System Components (6 major)
   ├─ Interfaces & Types
   ├─ Folder Structure
   ├─ Migration Strategy (5 phases)
   ├─ Provider Implementations (3 examples)
   ├─ Routing Strategy
   ├─ Observability
   ├─ OSS Model Recommendations
   └─ Best Practices & Pitfalls

2. LLM_PROVIDER_IMPLEMENTATION_GUIDE.md (40 pages)
   ├─ Core Type Definitions
   ├─ Base Provider Implementation
   ├─ OpenAI Provider (Complete)
   ├─ LLMRouter Implementation
   ├─ Response Parser
   ├─ Migration Examples (Before/After)
   ├─ Integration Tests
   ├─ Configuration Templates
   └─ Deployment Checklist

3. THIS FILE: LLM_PROVIDER_MIGRATION_QUICK_REFERENCE.md (1 page)
   ├─ At-a-glance roadmap
   ├─ Architecture overview
   ├─ Key interfaces
   ├─ MVF implementation
   ├─ Migration steps
   ├─ Testing strategy
   ├─ Success metrics
   └─ Learning paths

USE:
- Architecture doc when designing system
- Implementation guide when writing code
- Quick reference during daily standups
```

---

**Total Effort Estimate: 8-10 weeks → Production**
**MVP Effort: 2-3 weeks → Feature-flagged integration**
**Team Size: 2-3 backend engineers**

**Questions? Review the full architecture document.**
