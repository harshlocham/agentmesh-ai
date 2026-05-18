module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  transform: {
    "^.+\\.(ts|tsx)$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
      },
    ],
  },
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    "^@chat/types/(.*)$": "<rootDir>/../../packages/types/$1",
    "^@chat/services/(.*)$": "<rootDir>/../../packages/services/$1",
  },
  clearMocks: true,
};
