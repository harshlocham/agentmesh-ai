/**
 * Deferred loading utilities for non-critical features
 * Use requestIdleCallback to load features when browser is idle
 */

import { useEffect } from 'react';

type DeferredCallback = () => void | Promise<void>;

interface DeferrableTask {
    name: string;
    callback: DeferredCallback;
    timeout?: number;
    priority?: 'high' | 'normal' | 'low';
}

const deferredTasks: DeferrableTask[] = [];
let isProcessingTasks = false;

/**
 * Queue a task for deferred loading
 * Task will run when browser is idle using requestIdleCallback
 */
export function deferTask(
    name: string,
    callback: DeferredCallback,
    options?: { timeout?: number; priority?: 'high' | 'normal' | 'low' }
): void {
    if (typeof window === 'undefined') {
        return;
    }

    const task: DeferrableTask = {
        name,
        callback,
        timeout: options?.timeout ?? 2000,
        priority: options?.priority ?? 'normal',
    };

    deferredTasks.push(task);
    processDeferredTasks();
}

/**
 * Load deferred tasks using requestIdleCallback
 */
function processDeferredTasks(): void {
    if (isProcessingTasks || deferredTasks.length === 0) {
        return;
    }

    isProcessingTasks = true;

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
        requestIdleCallback(
            () => {
                const task = deferredTasks.shift();
                if (task) {
                    try {
                        Promise.resolve(task.callback()).catch(err => {
                            console.error(`Failed to execute deferred task "${task.name}":`, err);
                        });
                    } catch (err) {
                        console.error(`Error in deferred task "${task.name}":`, err);
                    }
                }
                isProcessingTasks = false;
                processDeferredTasks(); // Process next task
            },
            { timeout: deferredTasks[0]?.timeout ?? 2000 }
        );
    } else {
        // Fallback for browsers without requestIdleCallback
        const task = deferredTasks.shift();
        if (task) {
            setTimeout(() => {
                try {
                    Promise.resolve(task.callback()).catch(err => {
                        console.error(`Failed to execute deferred task "${task.name}":`, err);
                    });
                } catch (err) {
                    console.error(`Error in deferred task "${task.name}":`, err);
                }
                isProcessingTasks = false;
                processDeferredTasks(); // Process next task
            }, 100);
        }
    }
}

/**
 * Deferred loading hook for React components
 * Use this to defer heavy component/data loading
 */
export function useDeferredLoad(
    callback: DeferredCallback,
    dependencies: React.DependencyList = [],
    options?: { timeout?: number; priority?: 'high' | 'normal' | 'low' }
): void {
    // useEffect is already imported at the top of this file

    useEffect(() => {
        deferTask(`component-load-${Date.now()}`, callback, options);
    }, dependencies);
}

/**
 * Deferred content loader
 * Loads content after initial render completes
 */
export function deferredImport<T>(
    importFn: () => Promise<T>,
    onLoad?: (data: T) => void,
    onError?: (error: Error) => void
): void {
    deferTask('dynamic-import', async () => {
        try {
            const data = await importFn();
            onLoad?.(data);
        } catch (err) {
            onError?.(err instanceof Error ? err : new Error(String(err)));
        }
    });
}

/**
 * Queue multiple deferred tasks
 */
export function deferTasks(tasks: DeferrableTask[]): void {
    deferredTasks.push(...tasks);
    processDeferredTasks();
}

/**
 * Clear any pending deferred tasks
 */
export function clearDeferredTasks(): void {
    deferredTasks.length = 0;
    isProcessingTasks = false;
}

/**
 * Get count of pending deferred tasks
 */
export function getPendingTaskCount(): number {
    return deferredTasks.length;
}
