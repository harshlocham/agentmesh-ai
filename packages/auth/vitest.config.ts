import { defineConfig, configDefaults } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const alias = {
    "@": path.resolve(__dirname, "../db"),
};

// Loaded before every test file: applies test env defaults (JWT secrets, etc.).
const envSetup = path.resolve(__dirname, "./__tests__/helpers/env.ts");

export default defineConfig({
    resolve: { alias },
    test: {
        projects: [
            {
                resolve: { alias },
                test: {
                    name: "unit",
                    environment: "node",
                    globals: true,
                    setupFiles: [envSetup],
                    // Pure-unit specs: the new `unit/` folder plus existing flat
                    // specs, excluding anything named `*.integration.test.ts`.
                    include: [
                        "__tests__/unit/**/*.test.ts",
                        "__tests__/*.test.ts",
                    ],
                    exclude: [
                        ...configDefaults.exclude,
                        "__tests__/**/*.integration.test.ts",
                    ],
                },
            },
            {
                resolve: { alias },
                test: {
                    name: "integration",
                    environment: "node",
                    globals: true,
                    setupFiles: [envSetup],
                    // DB-backed and flow specs. Generous timeouts cover the
                    // first-run mongodb-memory-server binary download/boot.
                    hookTimeout: 60_000,
                    testTimeout: 30_000,
                    include: [
                        "__tests__/integration/**/*.test.ts",
                        "__tests__/e2e/**/*.test.ts",
                        "__tests__/**/*.integration.test.ts",
                    ],
                },
            },
        ],
    },
});
