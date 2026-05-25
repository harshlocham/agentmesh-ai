/**
 * Performance instrumentation utilities for startup optimization
 * Tracks TTFB, LCP, API timing, socket connection, and render performance
 */

interface PerformanceMetrics {
    ttfb?: number;
    lcp?: number;
    startupApiDuration?: number;
    socketConnectDuration?: number;
    renderDuration?: number;
    userFetchDuration?: number;
    conversationsFetchDuration?: number;
    messagesFetchDuration?: number;
}

const metrics: PerformanceMetrics = {};

/**
 * Mark the start of a performance operation
 */
export function markStart(name: string): void {
    if (typeof window !== 'undefined' && window.performance) {
        window.performance.mark(`${name}-start`);
    }
}

/**
 * Mark the end of a performance operation and record duration
 */
export function markEnd(name: string): number {
    if (typeof window !== 'undefined' && window.performance) {
        try {
            window.performance.mark(`${name}-end`);

            // Check if start mark exists before measuring
            const startMarkName = `${name}-start`;
            const existingMarks = window.performance.getEntriesByName(startMarkName, 'mark');

            if (existingMarks.length === 0) {
                // Start mark doesn't exist, skip measurement
                if (process.env.NODE_ENV === 'development') {
                    console.debug(`Performance mark '${startMarkName}' was not found, skipping measure for '${name}'`);
                }
                return 0;
            }

            window.performance.measure(name, startMarkName, `${name}-end`);
            const measure = window.performance.getEntriesByName(name)[0] as PerformanceMeasure | undefined;
            const duration = measure?.duration ?? 0;

            logPerformance(name, duration);
            return duration;
        } catch (e) {
            if (process.env.NODE_ENV === 'development') {
                console.debug(`Failed to measure ${name}:`, e);
            }
            return 0;
        }
    }
    return 0;
}

/**
 * Record an API call duration
 */
export function recordApiTiming(endpoint: string, duration: number): void {
    const key = `api:${endpoint}`;
    logPerformance(key, duration);

    // Track startup API calls
    if (endpoint === '/api/me') {
        metrics.userFetchDuration = duration;
    } else if (endpoint === '/api/conversations') {
        metrics.conversationsFetchDuration = duration;
    } else if (endpoint.includes('/api/messages')) {
        metrics.messagesFetchDuration = duration;
    }
}

/**
 * Record socket connection timing
 */
export function recordSocketTiming(duration: number): void {
    metrics.socketConnectDuration = duration;
    logPerformance('socket:connect', duration);
}

/**
 * Log performance metric to console (dev/monitoring)
 */
function logPerformance(name: string, duration: number): void {
    const threshold = getThresholdForMetric(name);
    const status = duration > threshold ? '⚠️' : '✅';

    if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
        console.log(`${status} [PERF] ${name}: ${duration.toFixed(2)}ms`);
    }

    // Send to monitoring service in production
    if (process.env.NODE_ENV === 'production' && typeof window !== 'undefined') {
        void sendMetricToMonitoring(name, duration);
    }
}

/**
 * Get performance threshold for a metric
 */
function getThresholdForMetric(name: string): number {
    const thresholds: Record<string, number> = {
        'api:me': 500,
        'api:conversations': 800,
        'api:messages': 1000,
        'socket:connect': 1500,
        'startup:shell-render': 500,
        'startup:full-render': 2000,
    };

    return thresholds[name] ?? 1000;
}

/**
 * Send metric to monitoring service (e.g., Sentry, DataDog, etc.)
 * Implement this based on your monitoring setup
 */
async function sendMetricToMonitoring(name: string, duration: number): Promise<void> {
    try {
        // Example: send to your monitoring endpoint
        await fetch('/api/metrics', {
            method: 'POST',
            body: JSON.stringify({ name, duration, timestamp: Date.now() }),
            headers: { 'Content-Type': 'application/json' },
        });
    } catch {
        // Silently fail - don't disrupt the app
    }
}

/**
 * Get all collected metrics
 */
export function getMetrics(): PerformanceMetrics {
    return { ...metrics };
}

/**
 * Log collected metrics to console (useful for debugging)
 */
export function logStartupMetrics(): void {
    if (typeof window !== 'undefined') {
        const allMetrics = {
            ...metrics,
            navigationTiming: window.performance?.timing,
            paintEntries: window.performance?.getEntriesByType('paint'),
            measureEntries: window.performance?.getEntriesByType('measure'),
        };

        console.table(allMetrics);
    }
}

/**
 * Monitor Largest Contentful Paint (LCP)
 */
export function monitorLCP(callback: (duration: number) => void): void {
    if (typeof window !== 'undefined' && 'PerformanceObserver' in window) {
        try {
            const observer = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                const lastEntry = entries[entries.length - 1];
                callback((lastEntry as PerformancePaintTiming).renderTime ?? (lastEntry as PerformancePaintTiming).loadTime ?? 0);
            });

            observer.observe({ entryTypes: ['largest-contentful-paint'], buffered: true });
        } catch (e) {
            console.error('Failed to observe LCP:', e);
        }
    }
}

/**
 * Monitor Time to First Byte (TTFB)
 */
export function getTTFB(): number {
    if (typeof window !== 'undefined' && window.performance?.timing) {
        const { responseStart, fetchStart } = window.performance.timing;
        return Math.max(0, responseStart - fetchStart);
    }
    return 0;
}

interface PerformancePaintTiming extends PerformanceEntry {
    renderTime?: number;
    loadTime?: number;
}

/**
 * Create a performance observer for custom metrics
 */
export function createPerformanceObserver(
    entryType: string,
    callback: (entries: PerformanceEntry[]) => void
): PerformanceObserver | null {
    if (typeof window !== 'undefined' && 'PerformanceObserver' in window) {
        try {
            const observer = new PerformanceObserver((list) => {
                callback(list.getEntries());
            });

            observer.observe({ entryTypes: [entryType], buffered: true });
            return observer;
        } catch (e) {
            console.error(`Failed to create observer for ${entryType}:`, e);
            return null;
        }
    }
    return null;
}
