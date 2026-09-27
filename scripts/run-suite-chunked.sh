#!/usr/bin/env bash
# W105 — chunked full-suite runner (the W101 precedent: the sandbox has
# 2 CPUs; a single vitest run may exceed the command window).
# Usage: bash scripts/run-suite-chunked.sh <batch-number> <batches-total>
# Reads /tmp/all-test-files.txt (one test file per line), runs slice
# <batch-number>/<batches-total>, writes /tmp/w105-suite/batch-<n>.json
# (vitest json reporter) and prints the human summary.

set -euo pipefail

BATCH="${1:?batch number}"
TOTAL="${2:?total batches}"
LIST=/tmp/all-test-files.txt
OUTDIR=/tmp/w105-suite
mkdir -p "$OUTDIR"

COUNT=$(wc -l < "$LIST")
PER=$(( (COUNT + TOTAL - 1) / TOTAL ))
START=$(( (BATCH - 1) * PER + 1 ))
END=$(( BATCH * PER ))

FILES=$(awk -v s="$START" -v e="$END" 'NR >= s && NR <= e { print }' "$LIST")

if [ -z "$FILES" ]; then
  echo "batch $BATCH/$TOTAL: no files (empty slice)"
  exit 0
fi

echo "batch $BATCH/$TOTAL: lines $START..$END"

# shellcheck disable=SC2086
bunx vitest run $FILES --reporter=json --outputFile="$OUTDIR/batch-$BATCH.json" > "$OUTDIR/batch-$BATCH.stdout" 2>&1 || true

node -e '
const fs = require("fs");
const path = process.argv[1];
const raw = JSON.parse(fs.readFileSync(path, "utf8"));
console.log(`batch done: files=${raw.numTotalTestSuites} passed=${raw.numPassedTests} failed=${raw.numFailedTests} skipped=${raw.numPendingTests + raw.numTodoTests}`);
if (raw.numFailedTests > 0) {
  for (const suite of raw.testResults) {
    for (const test of suite.assertionResults.filter((t) => t.status === "failed")) {
      console.log(`FAIL ${suite.name} > ${test.fullName}`);
    }
  }
  process.exit(1);
}
' "$OUTDIR/batch-$BATCH.json"
