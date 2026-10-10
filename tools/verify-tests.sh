#!/usr/bin/env bash
# verify-tests.sh — run bun tests so that a stall, a crash, or a silent no-run
# can never be read as "the suite passed" - or as "the suite failed".
#
# WHY THIS EXISTS (measured on bun 1.4.2, Linux, 2026-10-10):
#  1. `bun test` writes the version banner to STDOUT and every result line,
#     including the `Ran N tests across M files.` summary, to STDERR. A harness
#     that captures stdout alone sees 28 bytes ("bun test v1.4.2 (...)\n") and
#     nothing else - indistinguishable from a runner that hung before running a
#     single test. This wrapper merges both streams and re-emits the merged
#     output on stdout.
#  2. `bun run <entrypoint>` auto-installs missing dependencies (default
#     `--install=auto`). Against a registry that blackholes (packets dropped -
#     a dead proxy, a VPN flap, a saturated uplink) it spins at 100% CPU
#     emitting ZERO bytes on stdout AND stderr and never gives up: measured
#     still spinning at 300s. `bun test` does NOT auto-install, so this wrapper
#     invokes the runner directly and never goes through `bun run`.
#  3. A run that exits 0 without a summary line proves nothing. Verification
#     gates must treat it as NOT VERIFIED, never as a pass.
#
# Usage:
#   tools/verify-tests.sh                      # declared suite: bun test src services
#   tools/verify-tests.sh src/payment.test.ts  # specific files/paths
#   tools/verify-tests.sh --canary             # is this node able to run bun tests?
#   BUN_TEST_HARD_TIMEOUT=600 tools/verify-tests.sh ...
#
# Exit codes: 0 = PASS (summary present, runner exited 0)
#             1 = FAIL (summary present, runner exited non-zero)
#             2 = NO-VERDICT (runner exited without a summary: nothing was verified)
#             3 = HANG (hard timeout reached; the runner was still alive)
#             4 = usage/environment error (no bun, no timeout(1))
set -u

HARD_TIMEOUT=${BUN_TEST_HARD_TIMEOUT:-300}
CANARY_TIMEOUT=${BUN_TEST_CANARY_TIMEOUT:-30}
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

verdict() { # verdict <TAG> <rc> <detail>
  printf '\nBUN-TEST VERDICT: %s rc=%s %s\n' "$1" "$2" "$3"
}

run_merged() { # run_merged <timeout_seconds> <cmd...>  -> writes merged output to $OUT, sets rc
  local t=$1; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 5 "$t" "$@" >"$OUT" 2>&1
    rc=$?
  else
    "$@" >"$OUT" 2>&1
    rc=$?
  fi
}

# ---- canary: can this node execute a bun test at all? -----------------------
if [ "${1:-}" = "--canary" ]; then
  command -v bun >/dev/null 2>&1 || { echo "canary: bun not on PATH"; exit 4; }
  TMPD=$(mktemp -d); OUT=$(mktemp); trap 'rm -rf "$TMPD" "$OUT"' EXIT
  cat >"$TMPD/canary.test.ts" <<'TS'
import { expect, test } from "bun:test";
test("canary", () => { expect(1 + 1).toBe(2); });
TS
  run_merged "$CANARY_TIMEOUT" bun test "$TMPD/canary.test.ts"
  summary=$(grep -E '^[[:space:]]*Ran [0-9]+ tests? across ' "$OUT" | tail -1)
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    cat "$OUT"; verdict "CANARY-HANG" "$rc" "node cannot execute bun test (stalled ${CANARY_TIMEOUT}s)"
    exit 3
  fi
  if [ -z "$summary" ] || ! grep -qE '^[[:space:]]*1 pass' "$OUT"; then
    cat "$OUT"; verdict "CANARY-NO-RESULT" "$rc" "bun test produced no canary result"
    exit 2
  fi
  cat "$OUT"; verdict "CANARY-OK" "$rc" "node can execute bun test"
  exit 0
fi

# ---- normal suite run ------------------------------------------------------
command -v bun >/dev/null 2>&1 || { echo "verify-tests: bun not on PATH" >&2; exit 4; }
[ $# -gt 0 ] && TARGETS=("$@") || TARGETS=(src services)
cd "$REPO_ROOT" || exit 4

OUT=$(mktemp); trap 'rm -f "$OUT"' EXIT
start=$SECONDS
run_merged "$HARD_TIMEOUT" bun test "${TARGETS[@]}"
elapsed=$((SECONDS - start))
summary=$(grep -E '^[[:space:]]*Ran [0-9]+ tests? across ' "$OUT" | tail -1)

cat "$OUT"   # re-emit on stdout: the merged view is the point

if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
  verdict "HANG" "$rc" "still running after ${HARD_TIMEOUT}s (${elapsed}s elapsed) - NOT a test failure"
  exit 3
fi
if [ -z "$summary" ]; then
  verdict "NO-VERDICT" "$rc" "runner exited without a summary line - nothing was verified"
  exit 2
fi
if [ "$rc" = 0 ]; then
  verdict "PASS" "$rc" "${summary# } [${elapsed}s]"
  exit 0
fi
verdict "FAIL" "$rc" "${summary# } [${elapsed}s]"
exit 1
