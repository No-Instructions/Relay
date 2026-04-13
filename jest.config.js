/** @type {import('ts-jest').JestConfigWithTsJest} */

// Resolve yjs paths dynamically so tests work in git worktrees where
// node_modules may live in a parent directory rather than <rootDir>.
const path = require("path");
const yjsDir = path.dirname(require.resolve("yjs/package.json"));
const yjsIndex = path.join(yjsDir, "src/index.js");
const yjsInternals = path.join(yjsDir, "src/internals.js");

module.exports = {
	preset: "ts-jest/presets/default-esm",
	moduleNameMapper: {
		"^(\\.{1,2}/.*)\\.js$": "$1",
		"^src/(.*)$": "<rootDir>/src/$1",
		"^yjs$": yjsIndex,
		"^yjs/dist/src/internals$": yjsInternals,
	},
	testPathIgnorePatterns: ["/__tests__/mocks/", "archive/", ".claude"],
    globals: {
        "BUILD_TYPE": "production",
    },
	transformIgnorePatterns: ["[\\/]node_modules[\\/](?!(yjs|lib0)[\\/])"],
	transform: {
		"\\.ts$": [
			"ts-jest",
			{
				// Note: We shouldn't need to include `isolatedModules` here because it's a deprecated config option in TS 5,
				// but setting it to `true` fixes the `ESM syntax is not allowed in a CommonJS module when
				// 'verbatimModuleSyntax' is enabled` error that we're seeing when running our Jest tests.
				isolatedModules: true,
				useESM: true,
			},
		],
		"src/.+\\.js$": [
			"ts-jest",
			{
				isolatedModules: true,
				useESM: true,
			},
		],
		"node_modules[\\/](yjs|lib0)[\\/].+\\.js$": [
			"ts-jest",
			{
				isolatedModules: true,
				useESM: true,
			},
		],
	},
};
