"use client";

import { useMemo } from "react";
import type { TaskExecutionEventRecord, TaskExecutionUpdatedPayload } from "@chat/types";
import useTaskStore from "@/store/task-store";

const EMPTY_EXECUTION_EVENTS: TaskExecutionEventRecord[] = [];

export type ExecutionStepStatus = "pending" | "running" | "completed";

export interface DerivedExecutionStep {
    id: string;
    label: string;
    detail: string;
    status: ExecutionStepStatus;
}

export interface TaskExecutionView {
    phase: string | null;
    activeTool: string | null;
    retryStatus: string | null;
    approvalPending: boolean;
    verification: boolean;
    progress: number;
    durationMs: number | null;
    runId: string | null;
    failureReason: string | null;
    steps: DerivedExecutionStep[];
}

function eventDedupeKey(event: TaskExecutionEventRecord): string {
    return `${event.runId}:${event.sequence}`;
}

function mapEventToStep(event: TaskExecutionEventRecord, index: number): DerivedExecutionStep {
    const payload = event.payload ?? {};
    const summary = typeof payload.summary === "string" ? payload.summary : event.type.replace(/_/g, " ");
    const error = typeof payload.error === "string" ? payload.error : null;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : null;

    let status: ExecutionStepStatus = "completed";
    if (event.type === "tool_started" || event.type === "execution_started" || event.type === "retry_started") {
        status = "running";
    } else if (event.type === "tool_failed" || event.type === "execution_failed") {
        status = "completed";
    }

    return {
        id: `${event.runId}-${event.sequence}-${index}`,
        label: summary,
        detail: error ?? toolName ?? event.phase,
        status,
    };
}

function deriveStepsFromEvents(events: TaskExecutionEventRecord[]): DerivedExecutionStep[] {
    if (events.length === 0) {
        return [];
    }

    const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
    const unique = new Map<string, TaskExecutionEventRecord>();
    for (const event of sorted) {
        unique.set(eventDedupeKey(event), event);
    }

    const deduped = Array.from(unique.values()).sort((a, b) => a.sequence - b.sequence);
    const steps = deduped.map(mapEventToStep);

    if (steps.length > 0) {
        const last = steps[steps.length - 1];
        const lastEvent = deduped[deduped.length - 1];
        if (
            lastEvent.type !== "execution_completed"
            && lastEvent.type !== "execution_failed"
            && lastEvent.type !== "tool_failed"
        ) {
            last.status = "running";
        }
    }

    return steps;
}

function deriveFromLatestPayload(latest: TaskExecutionUpdatedPayload | undefined): Partial<TaskExecutionView> {
    if (!latest) {
        return {};
    }

    return {
        phase: latest.phase ?? null,
        activeTool: latest.details?.toolName ?? null,
        retryStatus: latest.step === "retry_scheduled" ? latest.summary : null,
        approvalPending: latest.state === "approval_pending",
        verification: latest.step === "verify_result" || latest.step === "verification_completed",
        progress: typeof latest.progress === "number" ? latest.progress : 0,
        runId: latest.runId ?? null,
        failureReason: latest.error,
    };
}

export function deriveExecutionView(
    events: TaskExecutionEventRecord[],
    latest?: TaskExecutionUpdatedPayload
): TaskExecutionView {
    const fromLatest = deriveFromLatestPayload(latest);
    const steps = deriveStepsFromEvents(events);

    const startedAt = events.find((event) => event.type === "execution_started")?.createdAt
        ?? (latest?.updatedAt ? String(latest.updatedAt) : null);
    const endedAt = events.find((event) =>
        event.type === "execution_completed" || event.type === "execution_failed"
    )?.createdAt ?? null;

    let durationMs: number | null = null;
    if (startedAt) {
        const startMs = new Date(startedAt).getTime();
        const endMs = endedAt ? new Date(endedAt).getTime() : Date.now();
        if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
            durationMs = Math.max(0, endMs - startMs);
        }
    }

    return {
        phase: fromLatest.phase ?? events.at(-1)?.phase ?? null,
        activeTool: fromLatest.activeTool ?? null,
        retryStatus: fromLatest.retryStatus ?? (events.some((e) => e.type === "retry_scheduled") ? "Retry scheduled" : null),
        approvalPending: fromLatest.approvalPending ?? events.some((e) => e.type === "waiting_for_approval"),
        verification: fromLatest.verification ?? events.some((e) => e.type === "verification"),
        progress: fromLatest.progress ?? (typeof latest?.progress === "number" ? latest.progress : 0),
        durationMs,
        runId: fromLatest.runId ?? events.at(-1)?.runId ?? null,
        failureReason: fromLatest.failureReason ?? null,
        steps,
    };
}

export function useTaskExecution(taskId: string): TaskExecutionView {
    const events = useTaskStore((state) => state.executionEventsByTaskId[taskId] ?? EMPTY_EXECUTION_EVENTS);
    const latest = useTaskStore((state) => state.executionByTaskId[taskId]);

    return useMemo(() => deriveExecutionView(events, latest), [events, latest]);
}
