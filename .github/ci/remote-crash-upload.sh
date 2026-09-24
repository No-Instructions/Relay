# Uploads the tail of the suite log and of the run step's stderr to the
# private report store when a job published no report, so a failed job still
# leaves evidence. Never overwrites a real report. lane.sh runs this on the
# VM with ci_vm_run after a failed run, before the VM is deleted.
set -u
META="$HOME/test-metadata.json"
if [ -s "$META" ] && grep -q '"reportUrl": *"https' "$META"; then
  echo "report already published; no crash upload"
  exit 0
fi
LOG="$HOME/test-plan-suite-output.txt"
MN_LOG="$HOME/mn-lane-output.txt"
SETUP_ERR="$HOME/ci-job.prev/err.log"
if [ ! -s "$LOG" ] && [ ! -s "$MN_LOG" ] && [ ! -s "$SETUP_ERR" ]; then
  echo "no suite log or setup stderr; nothing to upload"
  exit 0
fi
if [ ! -f ~/relay-harness/scripts/upload-report.mjs ]; then
  echo "harness not checked out; cannot upload crash evidence"
  exit 0
fi
[ -f ~/.config/relay-e2e/r2-env.sh ] && source ~/.config/relay-e2e/r2-env.sh
COMMIT=$(git -C ~/relay-plugin rev-parse HEAD 2>/dev/null || echo unknown)
EXEC="crash-$(hostname)-$(date -u +%Y%m%dT%H%M%SZ)"
DIR="/tmp/test-reports/runs/${COMMIT}/${EXEC}"
mkdir -p "$DIR"
[ -s "$LOG" ] && tail -c 200000 "$LOG" > "$DIR/suite-output-tail.txt"
[ -s "$MN_LOG" ] && tail -c 200000 "$MN_LOG" > "$DIR/mn-output-tail.txt"
[ -s "$SETUP_ERR" ] && tail -c 200000 "$SETUP_ERR" > "$DIR/setup-stderr-tail.txt"
printf '%s\n' '{"state":"error","synthetic":true,"reason":"suite produced no report; log tail only","summary":{"total":0,"pass":0,"fail":0},"tests":[]}' > "$DIR/summary.json"
cd ~/relay-harness && node scripts/upload-report.mjs "$DIR" "$COMMIT" "$EXEC" >&2 || true
echo "crash evidence: https://ci.system3.dev/runs/${COMMIT}/${EXEC}/index.html"
