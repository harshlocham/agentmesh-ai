export type RetryCategory =
    | "transient_llm"
    | "tool_timeout"
    | "network"
    | "validation"
    | "permanent_tool_rejection";

export interface RetryDecision {
    retryable: boolean;
    category: RetryCategory;
    delayMs: number;
    reason: string;
}

const BASE_BACKOFF_MS = Number(process.env.TASK_RETRY_BASE_BACKOFF_MS || 2000);
const MAX_BACKOFF_MS = Number(process.env.TASK_RETRY_MAX_BACKOFF_MS || 300000);

function computeBackoffDelay(attempt: number): number {
    const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** Math.max(0, attempt)));
    const jitter = 0.5 + Math.random() * 0.5;
    return Math.floor(exp * jitter);
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) {
        return err.message;
    }
    return String(err);
}

export function classifyExecutionError(err: unknown, attempt: number): RetryDecision {
    const message = errorMessage(err);
    const lower = message.toLowerCase();

    if (message.startsWith("LLM_ERROR:") || lower.includes("rate limit") || lower.includes("overloaded")) {
        return {
            retryable: true,
            category: "transient_llm",
            delayMs: computeBackoffDelay(attempt),
            reason: message.slice(0, 500),
        };
    }

    if (
        lower.includes("abort")
        || lower.includes("timeout")
        || lower.includes("timed out")
        || lower.includes("lease_heartbeat_lost")
        || lower.includes("lease heartbeat")
    ) {
        return {
            retryable: true,
            category: "tool_timeout",
            delayMs: computeBackoffDelay(attempt),
            reason: message.slice(0, 500),
        };
    }

    if (
        lower.includes("econnreset")
        || lower.includes("econnrefused")
        || lower.includes("network")
        || lower.includes("fetch failed")
        || lower.includes("socket hang up")
    ) {
        return {
            retryable: true,
            category: "network",
            delayMs: computeBackoffDelay(attempt),
            reason: message.slice(0, 500),
        };
    }

    if (
        lower.includes("validation")
        || lower.includes("invalid parameter")
        || lower.includes("zod")
        || lower.includes("parse")
        || lower.includes("schema")
    ) {
        return {
            retryable: false,
            category: "validation",
            delayMs: 0,
            reason: message.slice(0, 500),
        };
    }

    if (
        lower.includes("rejected")
        || lower.includes("forbidden")
        || lower.includes("unauthorized")
        || lower.includes("not allowed")
        || lower.includes("policy")
        || (lower.includes("status 4") && !lower.includes("429"))
    ) {
        return {
            retryable: false,
            category: "permanent_tool_rejection",
            delayMs: 0,
            reason: message.slice(0, 500),
        };
    }

    return {
        retryable: true,
        category: "network",
        delayMs: computeBackoffDelay(attempt),
        reason: message.slice(0, 500),
    };
}
