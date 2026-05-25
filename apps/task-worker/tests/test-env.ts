/**
 * Test-only defaults for internal service auth.
 * Production startup still requires INTERNAL_SECRET to be configured explicitly.
 */
if (!process.env.INTERNAL_SECRET?.trim()) {
    process.env.INTERNAL_SECRET = "test-internal-secret";
}
