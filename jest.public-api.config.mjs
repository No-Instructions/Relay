// Public contract tests run without the encrypted __tests__ developer overlay.
import base from "./jest.config.mjs";

export default {
	...base,
	setupFiles: [],
	testMatch: ["<rootDir>/tests/**/*.test.ts"],
};
