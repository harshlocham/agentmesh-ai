module.exports = {
    testEnvironment: "node",
    testMatch: ["<rootDir>/__tests__/**/*.test.ts"],
    transform: {
        "^.+\\.(ts|tsx)$": [
            "ts-jest",
            {
                tsconfig: {
                    types: ["jest", "node"],
                },
            },
        ],
    },
    clearMocks: true,
};
