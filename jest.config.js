/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.spec.ts"],
  moduleNameMapper: {
    // Mock the Obsidian API — it is not available in Node test environment
    "^obsidian$": "<rootDir>/tests/__mocks__/obsidian.ts",
  },
  globals: {
    "ts-jest": {
      tsconfig: {
        // Allow tests to import from src/ with strict mode matching src tsconfig
        strict: true,
        module: "commonjs",
        esModuleInterop: true,
        target: "ES2018",
        moduleResolution: "node",
        baseUrl: ".",
        lib: ["DOM", "ES2018", "ES2021.String"],
        noImplicitAny: true,
        strictNullChecks: true,
      },
    },
  },
};
