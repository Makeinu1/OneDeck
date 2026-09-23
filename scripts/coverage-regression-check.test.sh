#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/coverage-regression-check.sh"
TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

cat >"$TMPDIR_TEST/baseline.json" <<'JSON'
{"card_data_hash":"old-parser-output","source_corpus_hash":"0123456789abcdef","supported_cards":1,"total_cards":1,"diagnostics":{},"cards":[]}
JSON
cat >"$TMPDIR_TEST/current.json" <<'JSON'
{"supported_cards":1,"total_cards":1,"diagnostics":{},"cards":[]}
JSON

"$CHECK" "$TMPDIR_TEST/baseline.json" "$TMPDIR_TEST/current.json" \
  --source-corpus-hash 0123456789abcdef --fail-on-engine >/dev/null

if "$CHECK" "$TMPDIR_TEST/baseline.json" "$TMPDIR_TEST/current.json" \
  --source-corpus-hash fedcba9876543210 >/dev/null 2>"$TMPDIR_TEST/mismatch.err"; then
  echo "expected source corpus hash mismatch to fail" >&2
  exit 1
fi
grep -Fq 'CARD DATA DRIFT' "$TMPDIR_TEST/mismatch.err"

if "$CHECK" "$TMPDIR_TEST/baseline.json" "$TMPDIR_TEST/current.json" \
  >/dev/null 2>"$TMPDIR_TEST/missing.err"; then
  echo "expected missing current source corpus hash to fail" >&2
  exit 1
fi
grep -Fq 'current source corpus hash was not supplied' "$TMPDIR_TEST/missing.err"

echo "coverage-regression-check hash fencing: ok"
