#!/usr/bin/env bash
#
# Guard against running `npm run build` in a dev environment.
# The build command produces a production bundle (api.system3.md).
# For local development, use the staging build instead.
#
# Staging build (continuous watcher, points to dev servers):
#   npm run staging vaults/live1/.obsidian/plugins/system3-relay/ &
#   npm run staging vaults/live2/.obsidian/plugins/system3-relay/ &
#
# See MEMORY.md "Staging Build" section for details.

set -e

# Only guard when .staging-only marker file is present.
# Without it, run the normal build.
if [ ! -f ".staging-only" ]; then
    tsc -noEmit -skipLibCheck && node esbuild.config.mjs develop
    exit $?
fi

echo ""
echo "=========================================================="
echo "  DO NOT use 'npm run build' for local development."
echo ""
echo "  'npm run build' produces a PRODUCTION bundle that"
echo "  connects to api.system3.md (production servers)."
echo "  It will break your local auth session."
echo ""
echo "  For local development, use the staging build:"
echo ""
echo "    npm run staging vaults/live1/.obsidian/plugins/system3-relay/ &"
echo "    npm run staging vaults/live2/.obsidian/plugins/system3-relay/ &"
echo ""

# Show staging process status
STAGING_PIDS=$(pgrep -f "esbuild.config.mjs staging" 2>/dev/null | head -10)
if [ -n "$STAGING_PIDS" ]; then
    echo "  Staging watchers are already running (PIDs: $(echo $STAGING_PIDS | tr '\n' ' '))."
    echo ""
    if ls .build-status/*.log 1>/dev/null 2>&1; then
        # Compute current source fingerprint for staleness check
        HEAD=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
        DIFF=$(git diff HEAD 2>/dev/null)
        if [ -z "$DIFF" ]; then
            CURRENT_FP="$HEAD"
        else
            DIFF_HASH=$(echo "$DIFF" | sha1sum | cut -c1-8)
            CURRENT_FP="${HEAD}+${DIFF_HASH}"
        fi

        echo "  Last build results:"
        for f in .build-status/*.log; do
            name=$(basename "$f" .log)
            status=$(head -1 "$f")
            # Check if build fingerprint matches current source state
            BUILD_FP=$(echo "$status" | grep -o 'src:[^ ]*' | cut -d: -f2)
            if [ "$BUILD_FP" = "$CURRENT_FP" ]; then
                echo "    $name: $status  ✓ current"
            else
                echo "    $name: $status  ✗ stale (src now: $CURRENT_FP)"
            fi
        done
        echo ""
    fi
    echo "  To trigger a rebuild, touch a source file:"
    echo ""
    echo "    touch src/main.ts"
    echo ""
else
    echo "  No staging watchers running. Start them with the commands above."
    echo ""
fi

echo "  To force a production build anyway, run directly:"
echo "    npx tsc -noEmit -skipLibCheck && node esbuild.config.mjs develop"
echo "=========================================================="
echo ""
exit 1
