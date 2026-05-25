"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { TaskRecord, TaskStatus } from "@chat/types";
import { authenticatedFetch } from "@/lib/utils/api";
import { getSocket } from "@/hooks/socketClient";
import useTaskStore from "@/store/task-store";
import { Button } from "@/components/ui/button";
import { Check, Loader2, Sparkles } from "lucide-react";

interface TaskPanelProps {
    conversationId: string;
}

const TASK_STATUSES: TaskStatus[] = ["pending", "executing", "completed", "failed", "partial"];
const EMPTY_TASK_IDS: string[] = [];
const EMPTY_STEPS: ExecutionStep[] = [];

type ExecutionStepStatus = "pending" | "running" | "completed";

interface ExecutionStep {
    id: string;
    label: string;
    detail: string;
    status: ExecutionStepStatus;
}

interface TaskInlineCardProps {
    task: TaskRecord;
    onStatusChange: (taskId: string, status: TaskStatus) => void;
}

function formatDueDate(value: string | null) {
    if (!value) return "No due date";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "No due date";
    return parsed.toLocaleDateString();
}

function getExecutionSteps(task: TaskRecord): ExecutionStep[] {
    switch (task.status) {
        case "pending":
            return [
                {
                    id: "understand",
                    label: "Understanding the request",
                    detail: "Reading the latest context and intent.",
                    status: "running",
                },
                {
                    id: "prepare",
                    label: "Preparing actions",
                    detail: "Drafting the next execution steps.",
                    status: "pending",
                },
                {
                    id: "complete",
                    label: "Finishing the execution",
                    detail: "Waiting for the task to move forward.",
                    status: "pending",
                },
            ];
        case "executing":
            return [
                {
                    id: "understand",
                    label: "Understanding the request",
                    detail: "The system has already parsed the task.",
                    status: "completed",
                },
                {
                    id: "prepare",
                    label: "Preparing actions",
                    detail: "Building the next response in real time.",
                    status: "running",
                },
                {
                    id: "complete",
                    label: "Finishing the execution",
                    detail: "Waiting for the final update.",
                    status: "pending",
                },
            ];
        case "partial":
            return [
                {
                    id: "understand",
                    label: "Understanding the request",
                    detail: "The task is already fully parsed.",
                    status: "completed",
                },
                {
                    id: "prepare",
                    label: "Preparing actions",
                    detail: "The execution is waiting on a dependency.",
                    status: "completed",
                },
                {
                    id: "complete",
                    label: "Resolving the blocker",
                    detail: "Waiting for the next signal to continue.",
                    status: "running",
                },
            ];
        case "completed":
        case "failed":
            return [
                {
                    id: "understand",
                    label: "Understanding the request",
                    detail: "The task context was captured successfully.",
                    status: "completed",
                },
                {
                    id: "prepare",
                    label: "Preparing actions",
                    detail: "Execution steps were generated.",
                    status: "completed",
                },
                {
                    id: "complete",
                    label: task.status === "completed" ? "Execution complete" : "Execution failed",
                    detail: task.status === "completed" ? "The task finished cleanly." : "The task did not pass verification.",
                    status: "completed",
                },
            ];
        default:
            return EMPTY_STEPS;
    }
}

function getProgressValue(steps: ExecutionStep[]) {
    if (steps.length === 0) return 0;
    const completed = steps.filter((step) => step.status === "completed").length;
    return (completed / steps.length) * 100;
}

function getStepTone(status: ExecutionStepStatus) {
    switch (status) {
        case "running":
            return {
                border: "border-blue-500/40 dark:border-blue-400/30",
                background: "bg-blue-500/10",
                text: "text-blue-900 dark:text-blue-50",
                detail: "text-blue-800/85 dark:text-blue-100/70",
                ring: "ring-blue-500/25 dark:ring-blue-400/20",
            };
        case "completed":
            return {
                border: "border-emerald-500/35 dark:border-emerald-400/25",
                background: "bg-emerald-500/10",
                text: "text-emerald-900 dark:text-emerald-50",
                detail: "text-emerald-800/85 dark:text-emerald-100/70",
                ring: "ring-emerald-500/25 dark:ring-emerald-400/20",
            };
        default:
            return {
                border: "border-border",
                background: "bg-muted/50",
                text: "text-foreground",
                detail: "text-muted-foreground",
                ring: "ring-border/60",
            };
    }
}

const StepRow = memo(function StepRow({
    step,
    shouldReduceMotion,
}: {
    step: ExecutionStep;
    shouldReduceMotion: boolean;
}) {
    const tone = getStepTone(step.status);

    return (
        <motion.div
            layout="position"
            initial={false}
            animate={
                shouldReduceMotion
                    ? { opacity: 1, y: 0 }
                    : step.status === "pending"
                        ? { opacity: 0.58, y: 0 }
                        : step.status === "running"
                            ? { opacity: 1, y: -2 }
                            : { opacity: 1, y: 0 }
            }
            transition={{ duration: 0.24, ease: "easeOut" }}
            className={`mb-2 flex items-start gap-3 rounded-lg border px-3 py-3 ring-1 last:mb-0 ${tone.border} ${tone.background} ${tone.ring}`}
        >
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                <AnimatePresence mode="wait" initial={false}>
                    {step.status === "running" ? (
                        <motion.span
                            key="running"
                            initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.9 }}
                            animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: [0.96, 1.06, 0.96] }}
                            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                            transition={{ duration: 0.7, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
                            className="relative flex h-5 w-5 items-center justify-center rounded-full bg-blue-500/15 dark:bg-blue-400/15"
                        >
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600 dark:text-blue-200" />
                        </motion.span>
                    ) : step.status === "completed" ? (
                        <motion.span
                            key="completed"
                            initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.6 }}
                            animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, scale: [0.8, 1.08, 1] }}
                            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.8 }}
                            transition={{ duration: 0.24, ease: "easeOut" }}
                            className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15 dark:bg-emerald-400/15"
                        >
                            <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-300" />
                        </motion.span>
                    ) : (
                        <motion.span
                            key="pending"
                            initial={shouldReduceMotion ? false : { opacity: 0.45 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex h-5 w-5 items-center justify-center rounded-full border border-border bg-muted/80"
                        >
                            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
                        </motion.span>
                    )}
                </AnimatePresence>
            </div>

            <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${tone.text}`}>{step.label}</p>
                <p className={`mt-0.5 text-xs leading-5 ${tone.detail}`}>{step.detail}</p>
            </div>
        </motion.div>
    );
});

function TaskInlineCard({ task, onStatusChange }: TaskInlineCardProps) {
    const shouldReduceMotion = useReducedMotion();
    const steps = useMemo(() => getExecutionSteps(task), [task]);
    const progress = getProgressValue(steps);
    const hasRunningStep = steps.some((step) => step.status === "running");

    return (
        <motion.article
            layout
            initial={shouldReduceMotion ? false : { opacity: 0, y: 10 }}
            animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden rounded-xl border border-border bg-card p-4 text-card-foreground shadow-sm backdrop-blur-sm"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                        <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-foreground">
                            {task.source === "ai" ? "AI task" : task.source === "manual" ? "Manual task" : "Imported task"}
                        </span>
                        <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 text-foreground">
                            {task.status.replace("_", " ")}
                        </span>
                    </div>
                    <h4 className="truncate text-sm font-semibold tracking-tight text-foreground">{task.title}</h4>
                    {task.description && (
                        <p className="mt-1 line-clamp-2 text-sm leading-5 text-muted-foreground">{task.description}</p>
                    )}
                </div>

                <select
                    value={task.status}
                    className="rounded-lg border border-input bg-background px-2.5 py-2 text-xs text-foreground outline-none transition focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                    onChange={(event) => onStatusChange(task._id, event.target.value as TaskStatus)}
                >
                    {TASK_STATUSES.map((status) => (
                        <option key={status} value={status}>
                            {status.replace("_", " ")}
                        </option>
                    ))}
                </select>
            </div>

            <div className="mt-4">
                {hasRunningStep && (
                    <motion.div
                        initial={shouldReduceMotion ? false : { opacity: 0 }}
                        animate={shouldReduceMotion ? { opacity: 1 } : { opacity: 1 }}
                        className="mb-3 flex items-center gap-2 text-xs text-blue-800 dark:text-blue-100"
                    >
                        <motion.span
                            animate={shouldReduceMotion ? undefined : { opacity: [0.45, 1, 0.45], scale: [0.98, 1, 0.98] }}
                            transition={{ duration: 1.4, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
                            className="inline-flex h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_12px_rgba(59,130,246,0.55)] dark:bg-blue-400 dark:shadow-[0_0_16px_rgba(96,165,250,0.8)]"
                        />
                        <span className="font-medium">AI is thinking...</span>
                        <span className="flex items-center gap-0.5 text-blue-700/80 dark:text-blue-200/70">
                            <motion.span
                                animate={shouldReduceMotion ? undefined : { opacity: [0.2, 1, 0.2] }}
                                transition={{ duration: 1, repeat: Number.POSITIVE_INFINITY, delay: 0, ease: "easeInOut" }}
                            >
                                .
                            </motion.span>
                            <motion.span
                                animate={shouldReduceMotion ? undefined : { opacity: [0.2, 1, 0.2] }}
                                transition={{ duration: 1, repeat: Number.POSITIVE_INFINITY, delay: 0.2, ease: "easeInOut" }}
                            >
                                .
                            </motion.span>
                            <motion.span
                                animate={shouldReduceMotion ? undefined : { opacity: [0.2, 1, 0.2] }}
                                transition={{ duration: 1, repeat: Number.POSITIVE_INFINITY, delay: 0.4, ease: "easeInOut" }}
                            >
                                .
                            </motion.span>
                        </span>
                    </motion.div>
                )}

                <AnimatePresence initial={false} mode="popLayout">
                    {steps.map((step) => (
                        <StepRow key={step.id} step={step} shouldReduceMotion={Boolean(shouldReduceMotion)} />
                    ))}
                </AnimatePresence>
            </div>

            <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{Math.round(progress)}% complete</span>
                    <span>{steps.filter((step) => step.status === "completed").length} of {steps.length} steps done</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <motion.div
                        layout
                        className="h-full rounded-full bg-linear-to-r from-blue-500 via-cyan-400 to-emerald-400"
                        initial={false}
                        animate={{ width: `${progress}%` }}
                        transition={{ duration: 0.35, ease: "easeOut" }}
                    />
                </div>
            </div>

            <div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-[11px] text-muted-foreground">
                <span>Due {formatDueDate(task.dueAt)}</span>
                <span className="inline-flex items-center gap-1">
                    <Sparkles className="h-3 w-3 text-primary" />
                    Real-time execution
                </span>
            </div>
        </motion.article>
    );
}

export default function TaskPanel({ conversationId }: TaskPanelProps) {
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [newTaskTitle, setNewTaskTitle] = useState("");
    const [newTaskDescription, setNewTaskDescription] = useState("");

    const setConversationTasks = useTaskStore((state) => state.setConversationTasks);
    const upsertTask = useTaskStore((state) => state.upsertTask);
    const tasksById = useTaskStore((state) => state.tasksById);
    const conversationTaskIds = useTaskStore((state) => state.tasksByConversation[conversationId] ?? EMPTY_TASK_IDS);

    const tasks = useMemo(() => {
        return conversationTaskIds
            .map((id) => tasksById[id])
            .filter((task): task is TaskRecord => Boolean(task))
            .sort((left, right) => {
                if (left.status !== right.status) {
                    return left.status.localeCompare(right.status);
                }
                return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
            });
    }, [conversationTaskIds, tasksById]);

    const loadTasks = useCallback(
        async (opts?: { silent?: boolean }) => {
            if (!opts?.silent) {
                setLoading(true);
            }
            try {
                const response = await authenticatedFetch(`/api/tasks?conversationId=${conversationId}`);
                if (!response.ok) return;
                const payload = (await response.json()) as TaskRecord[];
                setConversationTasks(conversationId, payload);
            } catch (error) {
                console.error("Failed to load tasks", error);
            } finally {
                if (!opts?.silent) {
                    setLoading(false);
                }
            }
        },
        [conversationId, setConversationTasks]
    );

    useEffect(() => {
        void loadTasks();
    }, [loadTasks]);

    useEffect(() => {
        const socket = getSocket();
        const onConnect = () => {
            void loadTasks({ silent: true });
        };
        socket.on("connect", onConnect);
        return () => {
            socket.off("connect", onConnect);
        };
    }, [loadTasks]);

    const createTask = async () => {
        const title = newTaskTitle.trim();
        if (title.length < 3) return;

        setCreating(true);
        try {
            const response = await authenticatedFetch("/api/tasks", {
                method: "POST",
                body: JSON.stringify({
                    conversationId,
                    title,
                    description: newTaskDescription.trim(),
                }),
            });

            if (!response.ok) {
                throw new Error("Failed to create task");
            }

            const created = (await response.json()) as TaskRecord;
            upsertTask(created);
            setNewTaskTitle("");
            setNewTaskDescription("");
        } catch (error) {
            console.error("Failed to create task", error);
        } finally {
            setCreating(false);
        }
    };

    const updateTaskStatus = async (taskId: string, status: TaskStatus) => {
        try {
            const response = await authenticatedFetch(`/api/tasks/${taskId}`, {
                method: "PATCH",
                body: JSON.stringify({ status }),
            });
            if (!response.ok) {
                throw new Error("Failed to update task status");
            }

            const updated = (await response.json()) as TaskRecord;
            upsertTask(updated);
        } catch (error) {
            console.error("Failed to update task", error);
        }
    };

    return (
        <aside className="hidden min-h-0 w-85 shrink-0 border-l border-border bg-[hsl(var(--left-panel))] text-foreground xl:flex xl:flex-col dark:bg-[radial-gradient(circle_at_top,rgba(37,99,235,0.12),transparent_28%),linear-gradient(180deg,hsl(var(--left-panel)),hsl(var(--background)))]">
            <div className="border-b border-border px-4 py-4">
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-semibold tracking-tight text-foreground">Tasks</h3>
                        <p className="mt-1 text-xs text-muted-foreground">Actionable work for this conversation</p>
                    </div>
                    <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11px] text-primary">
                        Live
                    </span>
                </div>
            </div>

            <div className="space-y-2 border-b border-border p-3">
                <input
                    className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
                    value={newTaskTitle}
                    placeholder="Create a task"
                    onChange={(event) => setNewTaskTitle(event.target.value)}
                />
                <textarea
                    className="max-h-24 min-h-16 w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
                    value={newTaskDescription}
                    placeholder="Description (optional)"
                    onChange={(event) => setNewTaskDescription(event.target.value)}
                />
                <Button
                    size="sm"
                    disabled={creating || newTaskTitle.trim().length < 3}
                    onClick={createTask}
                    className="w-full rounded-xl"
                >
                    {creating ? "Creating..." : "Create task"}
                </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {loading && <p className="text-xs text-muted-foreground">Loading tasks...</p>}

                {!loading && tasks.length === 0 && (
                    <p className="text-xs text-muted-foreground">No tasks yet for this conversation.</p>
                )}

                <AnimatePresence initial={false} mode="popLayout">
                    <div className="space-y-3">
                        {tasks.map((task) => (
                            <TaskInlineCard key={task._id} task={task} onStatusChange={updateTaskStatus} />
                        ))}
                    </div>
                </AnimatePresence>
            </div>
        </aside>
    );
}