export type RetryBackoffSchedule = readonly number[];

export interface RetryExecutionContext {
    attempt: number;
    retryCount: number;
    maxRetries: number;
}

export interface RetryAttemptDetails {
    attempt: number;
    retryCount: number;
    maxRetries: number;
    reason: string;
    delayMs: number;
    error: unknown;
}

export interface RetryExecutionOptions<T> {
    retryCount: number;
    maxRetries: number;
    operation: (context: RetryExecutionContext) => Promise<T>;
    shouldRetry?: (error: unknown) => boolean;
    getReason?: (error: unknown) => string;
    onRetry?: (details: RetryAttemptDetails) => Promise<void> | void;
}

export class RetryManager {
    private readonly backoffSchedule: RetryBackoffSchedule;

    constructor(backoffSchedule: RetryBackoffSchedule = [1000, 2000, 5000]) {
        this.backoffSchedule = backoffSchedule;
    }

    private getDelayMs(retryCount: number) {
        if (retryCount <= 0) return 0;
        const index = Math.min(retryCount - 1, this.backoffSchedule.length - 1);
        return this.backoffSchedule[index] ?? 0;
    }

    async execute<T>(options: RetryExecutionOptions<T>): Promise<T> {
        const maxRetries = Math.max(0, options.maxRetries);
        const shouldRetry = options.shouldRetry ?? (() => true);
        const getReason = options.getReason ?? ((error) => (error instanceof Error ? error.message : "unknown retry error"));
        let retryCount = Math.max(0, options.retryCount);
        let attempt = 0;

        while (true) {
            attempt += 1;

            try {
                return await options.operation({
                    attempt,
                    retryCount,
                    maxRetries,
                });
            } catch (error) {
                const canRetry = retryCount < maxRetries && shouldRetry(error);
                if (!canRetry) {
                    throw error;
                }

                retryCount += 1;
                const reason = getReason(error);
                const delayMs = this.getDelayMs(retryCount);

                await options.onRetry?.({
                    attempt,
                    retryCount,
                    maxRetries,
                    reason,
                    delayMs,
                    error,
                });

                if (delayMs > 0) {
                    await new Promise((resolve) => {
                        setTimeout(resolve, delayMs);
                    });
                }
            }
        }
    }
}
