import type { LLMProviderMetricSnapshot } from "./types.js";

type MetricEvent =
    | { provider: string; event: "request" }
    | { provider: string; event: "success"; latencyMs: number }
    | { provider: string; event: "timeout" }
    | { provider: string; event: "fallback" }
    | { provider: string; event: "malformed_response" }
    | { provider: string; event: "repair" };

type MutableSnapshot = LLMProviderMetricSnapshot & { successCount: number };

const snapshots = new Map<string, MutableSnapshot>();

function getOrCreate(provider: string): MutableSnapshot {
    const existing = snapshots.get(provider);
    if (existing) {
        return existing;
    }

    const created: MutableSnapshot = {
        provider,
        requestCount: 0,
        successCount: 0,
        timeoutCount: 0,
        fallbackCount: 0,
        malformedResponseCount: 0,
        repairCount: 0,
        totalLatencyMs: 0,
        lastRequestAt: undefined,
    };

    snapshots.set(provider, created);
    return created;
}

export function recordLLMProviderMetric(event: MetricEvent) {
    const snapshot = getOrCreate(event.provider);

    if (event.event === "request") {
        snapshot.requestCount += 1;
        snapshot.lastRequestAt = new Date().toISOString();
        return;
    }

    if (event.event === "success") {
        snapshot.successCount += 1;
        snapshot.totalLatencyMs += event.latencyMs;
        return;
    }

    if (event.event === "timeout") snapshot.timeoutCount += 1;
    if (event.event === "fallback") snapshot.fallbackCount += 1;
    if (event.event === "malformed_response") snapshot.malformedResponseCount += 1;
    if (event.event === "repair") snapshot.repairCount += 1;
}

export function getLLMProviderMetricsSnapshot(provider: string): LLMProviderMetricSnapshot {
    return { ...getOrCreate(provider) };
}

export function getAllLLMProviderMetricsSnapshots(): LLMProviderMetricSnapshot[] {
    return [...snapshots.values()].map((entry) => ({ ...entry }));
}

export function resetLLMProviderMetrics() {
    snapshots.clear();
}