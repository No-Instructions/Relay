#!/usr/bin/env bash
# Runs the Obsidian community-store lint (eslint-plugin-obsidianmd) over the
# checkout's TypeScript sources.
#
#   store-lint.sh [SCRATCH_DIR]
#
# The plugin and an ESLint 9 major install fresh from the registry into
# SCRATCH_DIR (default $RUNNER_TEMP/store-lint) on every run: latest-each-run
# is deliberate, so a new store rule surfaces here before it surfaces in a
# plugin review. The repository's own devDependencies (ESLint 8, the legacy
# config) are neither installed nor resolved. Findings go to
# SCRATCH_DIR/results.json and the log; store-lint-summary.js applies the
# severity policy. Exits non-zero only when the toolchain or ESLint itself
# fails. Run from the repository root.
set -euo pipefail
ROOT="$(pwd)"
SCRATCH="${1:-${RUNNER_TEMP:-$(mktemp -d)}/store-lint}"
mkdir -p "$SCRATCH"

# Only the plugin and an ESLint 9 major are named; npm resolves the rest of
# the peer set (@eslint/js, typescript-eslint, @eslint/json, obsidian) from
# the plugin's peerDependencies at install time.
(
  cd "$SCRATCH"
  npm init -y > /dev/null
  npm install --no-audit --no-fund eslint-plugin-obsidianmd@latest eslint@9
  # Record the resolved versions, then gate each expected package separately
  # so one dropped or renamed peer cannot pass unnoticed.
  npm ls eslint eslint-plugin-obsidianmd typescript-eslint @eslint/js @eslint/json obsidian
  for PACKAGE in eslint eslint-plugin-obsidianmd typescript-eslint @eslint/js @eslint/json obsidian; do
    npm ls "$PACKAGE" > /dev/null || {
      echo "Expected store-lint package is missing: $PACKAGE"
      exit 1
    }
  done
)

# The checkout is dependency-less, so third-party imports type as `any`. The
# scratch tsconfig gives the plugin's typed rules a real TS program over src/,
# while typescript-eslint's own type-aware rules are switched off: against
# `any` imports they only flood. The plugin has no Svelte parser, so only
# TypeScript is linted.
cat > "$SCRATCH/tsconfig.store-lint.json" << JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "baseUrl": "$SCRATCH/node_modules",
    "allowJs": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["$ROOT/src/**/*.ts"]
}
JSON
cat > "$SCRATCH/eslint.config.mjs" << 'JS'
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

const scratch = new URL(".", import.meta.url).pathname;
const recommended = obsidianmd.configs?.recommended;
if (!Array.isArray(recommended) || recommended.length === 0) {
  throw new Error("eslint-plugin-obsidianmd recommended config is missing or empty");
}

export default defineConfig([
  ...recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: `${scratch}tsconfig.store-lint.json`,
        tsconfigRootDir: scratch,
      },
    },
    rules: { ...tseslint.configs.disableTypeChecked.rules },
  },
]);
JS

# The plugin reads manifest.json from the working directory when it loads, so
# ESLint runs from the checkout root with the scratch binary and config.
STATUS=0
"$SCRATCH/node_modules/.bin/eslint" \
  --config "$SCRATCH/eslint.config.mjs" \
  --format json --output-file "$SCRATCH/results.json" \
  "src/**/*.ts" package.json || STATUS=$?
if [ "$STATUS" -ge 2 ]; then
  echo "eslint did not complete (exit $STATUS)"
  exit "$STATUS"
fi

# Full findings listing for the log; the job summary carries per-rule counts.
node - "$SCRATCH/results.json" <<'NODE'
const results = require(process.argv[2]);
const ruleOf = m => m.ruleId
  || (/^Unused eslint-disable/.test(m.message) ? 'unused-disable-directive' : 'core');
let errors = 0;
let warnings = 0;
for (const file of results) {
  if (!file.messages.length) continue;
  errors += file.errorCount;
  warnings += file.warningCount;
  console.log(file.filePath);
  for (const m of file.messages) {
    const sev = m.severity === 2 ? 'error' : 'warn ';
    console.log(`  ${m.line}:${m.column}  ${sev}  ${m.message}  [${ruleOf(m)}]`);
  }
}
console.log(`\n${errors} errors, ${warnings} warnings across ${results.length} files`);
NODE
