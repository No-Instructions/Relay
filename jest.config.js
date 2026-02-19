//module.exports = {
//  preset: 'ts-jest',
//  testEnvironment: 'node',
//};
//
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	// [...]
	preset: "ts-jest/presets/default-esm", // or other ESM presets
	moduleNameMapper: {
		"^(\\.{1,2}/.*)\\.js$": "$1",
		"^src/(.*)$": "<rootDir>/src/$1",
		"^yjs$": "<rootDir>/node_modules/yjs/src/index.js",
		"^yjs/dist/src/internals$": "<rootDir>/node_modules/yjs/src/internals.js",
	},
	testPathIgnorePatterns: ["/__tests__/mocks/"],
    globals: {
        "BUILD_TYPE": "production",
    },
	transformIgnorePatterns: ["/node_modules/(?!(yjs|lib0)/)"],
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
		"node_modules/(yjs|lib0)/.+\\.js$": [
			"ts-jest",
			{
				isolatedModules: true,
				useESM: true,
			},
		],
	},
};
