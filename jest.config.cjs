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
	},
	testPathIgnorePatterns: ["/__tests__/mocks/"],
    globals: {
        "BUILD_TYPE": "production",
    },
	transform: {
		".ts": [
			"ts-jest",
			{
				// Note: We shouldn't need to include `isolatedModules` here because it's a deprecated config option in TS 5,
				// but setting it to `true` fixes the `ESM syntax is not allowed in a CommonJS module when
				// 'verbatimModuleSyntax' is enabled` error that we're seeing when running our Jest tests.
				isolatedModules: true,
				useESM: true,
			},
		],
	},
};
