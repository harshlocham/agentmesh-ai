import { generateDeviceFingerprint } from "../../../session/fingerprint.js";

/**
 * Request-context builders for refresh/step-up integration tests.
 *
 * A "request context" is the device/network metadata a client sends with a
 * refresh call (`deviceId`, `userAgent`, `ipAddress`). `refreshService` derives
 * a device fingerprint from it and compares against the fingerprint persisted on
 * the session. These builders keep the stored fingerprint and the incoming
 * context genuinely coordinated, using the REAL production `generateDeviceFingerprint`.
 */
export interface RequestContext {
    deviceId?: string;
    userAgent?: string;
    ipAddress?: string;
}

const DEFAULTS: Required<RequestContext> = {
    deviceId: "device-fingerprint-aaaa-1111",
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TestAgent/1.0",
    ipAddress: "203.0.113.10",
};

/** Build a request context with sane, fingerprint-stable defaults. */
export function buildRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
    return {
        deviceId: overrides.deviceId ?? DEFAULTS.deviceId,
        userAgent: overrides.userAgent ?? DEFAULTS.userAgent,
        ipAddress: overrides.ipAddress ?? DEFAULTS.ipAddress,
    };
}

/**
 * The `deviceId` value a real session would persist for this context.
 *
 * Mirrors production `createUserSession`, which stores
 * `generateDeviceFingerprint({ deviceId, userAgent, ipAddress })` rather than
 * the raw deviceId. Storing this on a session row makes a later refresh with the
 * same context pass the fingerprint check.
 */
export function storedDeviceFingerprint(ctx: RequestContext): string {
    return generateDeviceFingerprint({
        deviceId: ctx.deviceId,
        userAgent: ctx.userAgent,
        ipAddress: ctx.ipAddress,
    });
}

/**
 * Produce a context whose device fingerprint DIFFERS from `ctx` (device drift),
 * which should trigger the step-up flow on refresh.
 */
export function driftedContext(
    ctx: RequestContext,
    overrides: Partial<RequestContext> = {}
): RequestContext {
    return buildRequestContext({
        ...ctx,
        deviceId: "device-fingerprint-zzzz-9999",
        ...overrides,
    });
}
