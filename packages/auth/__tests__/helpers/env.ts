/**
 * Test environment configuration.
 *
 * The auth package reads secrets via `config.requiredEnv` (lazily, at call
 * time), so any test that signs/verifies JWTs or exercises Google OAuth config
 * needs these variables present. Importing this module applies sane test
 * defaults exactly once, which lets it double as a Vitest `setupFiles` entry.
 *
 * Call `setTestEnv()` explicitly when a test needs to override or clear a
 * specific variable (e.g. asserting `requiredEnv` throws when a secret is
 * missing, or toggling `COOKIE_DOMAIN`).
 */

export type TestEnvKey =
    | "NODE_ENV"
    | "ACCESS_TOKEN_SECRET"
    | "REFRESH_TOKEN_SECRET"
    | "GOOGLE_CLIENT_ID"
    | "GOOGLE_CLIENT_SECRET"
    | "COOKIE_DOMAIN";

export type TestEnvOverrides = Partial<Record<TestEnvKey, string | undefined>>;

/**
 * Default values applied to `process.env` for tests. `COOKIE_DOMAIN` is
 * intentionally omitted so cookie helpers exercise their "no domain" branch by
 * default; opt in per-test via `setTestEnv({ COOKIE_DOMAIN: "..." })`.
 */
export const TEST_ENV_DEFAULTS: Record<Exclude<TestEnvKey, "COOKIE_DOMAIN">, string> = {
    NODE_ENV: "test",
    ACCESS_TOKEN_SECRET: "test-access-token-secret",
    REFRESH_TOKEN_SECRET: "test-refresh-token-secret",
    GOOGLE_CLIENT_ID: "test-google-client-id",
    GOOGLE_CLIENT_SECRET: "test-google-client-secret",
};

/**
 * Apply the test environment defaults, optionally overriding individual keys.
 * Passing an explicit `undefined` value deletes that variable from
 * `process.env`, which is useful for "missing secret" test cases.
 */
export function setTestEnv(overrides: TestEnvOverrides = {}): void {
    const merged: TestEnvOverrides = { ...TEST_ENV_DEFAULTS, ...overrides };

    for (const [key, value] of Object.entries(merged)) {
        if (value === undefined) {
            delete process.env[key];
            continue;
        }

        process.env[key] = value;
    }
}

// Applied on import so this file works as a Vitest setupFile.
setTestEnv();
