#!/usr/bin/env bash
# verify-tests.sh — run bun tests so that a stall, a crash, or a silent no-run
# can never be read as "the suite passed" - or as "the suite failed".
#
# WHY THIS EXISTS (all measured on bun 1.4.2, Linux, 2026-10-10, cvm-service-kit):
#
#  1. STREAMS. `bun test` writes the version banner to STDOUT and every result
#     line, including the `Ran N tests across M files.` summary, to STDERR. A
#     harness that captures stdout alone sees 28 bytes and nothing else -
#     indistinguishable from a runner that hung before executing a single test.
#     This wrapper merges both streams and re-emits the merged output on stdout.
#
#  2. AUTO-INSTALL. `bun run <entrypoint>` installs missing dependencies by
#     default (`--install=auto`). Against a registry that blackholes (packets
#     dropped, no RST: dead proxy, VPN flap, saturated uplink) it spins at 100%
#     CPU emitting ZERO bytes on both streams and never gives up - measured
#     54.8s of CPU per 60s, still spinning at 300s. `bun test` never
#     auto-installs, so this wrapper calls the runner directly, never `bun run`.
#
#  3. MODULE IMPORT STALL. When BUN_INSTALL (default ~/.bun) is a DANGLING
#     SYMLINK - e.g. into an unmounted mount - `bun test <repo file>` hangs
#     forever with a byte-exact signature:
#         stdout: "bun test v1.4.2 (744846f84)\n"      (28 bytes)
#         stderr: "\nsrc/payment.test.ts:\n"           (22 bytes)
#         then nothing, ever. 0 (pass) lines, rc=124, process state S,
#         wchan=ep_poll (an event-loop wait, not I/O and not a crash).
#     A standalone 3-line canary test PASSES in that same state (measured), so a
#     canary is NOT a valid probe for this fault - it only proves bun:test works,
#     not that this repo's modules can be loaded. The preflight below checks the
#     configuration directly instead, warns, and shortens the budget so the
#     verdict arrives in ~30s instead of the full hard timeout.
#     Cures (both measured against a dangling BUN_INSTALL, repo file, 124 -> 0.12s):
#         repair it : make BUN_INSTALL a real directory again
#         override  : export BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/bun-tc
#
#  4. EMPTY RUNS. A run that exits 0 without a summary line proves nothing.
#     Verification gates must treat it as NOT VERIFIED, never as a pass.
#
# Usage:
#   tools/verify-tests.sh                      # declared suite: bun test src services
#   tools/verify-tests.sh src/payment.test.ts  # specific files/paths
#   tools/verify-tests.sh --canary             # can bun:test execute at all here?
#
# Env knobs: BUN_TEST_HARD_TIMEOUT (300), BUN_TEST_FAULT_TIMEOUT (30),
#            BUN_TEST_CANARY_TIMEOUT (30).
#
# Exit codes: 0 = PASS (summary present, runner exited 0)
#             1 = FAIL (summary present, runner exited non-zero)
#             2 = NO-VERDICT (runner exited without a summary: nothing was verified)
#             3 = HANG (hard timeout reached; the runner was still alive)
#             4 = environment unusable before the runner (no bun, no timeout(1))
set -u

HARD_TIMEOUT=${BUN_TEST_HARD_TIMEOUT:-300}
FAULT_TIMEOUT=${BUN_TEST_FAULT_TIMEOUT:-30}
CANARY_TIMEOUT=${BUN_TEST_CANARY_TIMEOUT:-30}
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FAULT=0

verdict() { # verdict <TAG> <rc> <detail>
  printf '\nBUN-TEST VERDICT: %s rc=%s %s\n' "$1" "$2" "$3"
}

fault_note() {
  cat <<EOF

SUSPECTED CAUSE (detected in this environment, not in the tests):
  BUN_INSTALL=${1} is a dangling symlink -> $(readlink "$1" 2>/dev/null)
  Under this configuration a repo test file stalls during module import and emits
  only the banner plus one filename line. Measured: rc=124 forever; 0 tests.
Fix either way:
  repair   : mv "$1" "$1".dangling-\$(date +%s) && mkdir -p "$1"
  override : export BUN_RUNTIME_TRANSPILER_CACHE_PATH=/tmp/bun-tc
EOF
}

run_merged() { # run_merged <out_file> <timeout_seconds> <cmd...>
  local out=$1 t=$2; shift 2
  if command -v timeout >/dev/null 2>&1; then
    timeout -k 5 "$t" "$@" >"$out" 2>&1
  else
    "$@" >"$out" 2>&1
  fi
}

canary() { # sets CAN_OUT, returns the runner's rc (127 = could not even stage)
  local d out rc
  CAN_OUT=""
  d=$(mktemp -d) || return 127
  cat >"$d/canary.test.ts" <<'TS'
import { expect, test } from "bun:test";
test("canary", () => { expect(1 + 1).toBe(2); });
TS
  out=$(mktemp) || { rm -rf "$d"; return 127; }
  run_merged "$out" "$CANARY_TIMEOUT" bun test "$d/canary.test.ts"; rc=$?
  CAN_OUT=$(cat "$out" 2>/dev/null); rm -rf "$d" "$out"
  return $rc
}

preflight() {
  local inst=${BUN_INSTALL:-$HOME/.bun} tc=${BUN_RUNTIME_TRANSPILER_CACHE_PATH:-}
  if [ -L "$inst" ] && [ ! -e "$inst" ]; then
    if [ -n "$tc" ] && [ -w "$tc" ]; then
      printf 'preflight: BUN_INSTALL=%s is a dangling symlink, but BUN_RUNTIME_TRANSPILER_CACHE_PATH=%s is writable - that override is measured to clear the stall\n' "$inst" "$tc"
      return 0
    fi
    printf 'preflight: BUN_INSTALL=%s is a DANGLING SYMLINK -> %s\n' "$inst" "$(readlink "$inst")"
    printf 'preflight: capping this run at %ss instead of %ss (a run in this state stalls before running any test)\n' \
      "$FAULT_TIMEOUT" "$HARD_TIMEOUT"
    FAULT=1
    if [ "$FAULT_TIMEOUT" -lt "$HARD_TIMEOUT" ]; then HARD_TIMEOUT=$FAULT_TIMEOUT; fi
  fi
  return 0
}

if [ "${1:-}" = "--canary" ]; then
  command -v bun >/dev/null 2>&1 || { echo "canary: bun not on PATH"; exit 4; }
  canary; rc=$?
  if [ "$rc" = 127 ]; then echo "canary: could not stage the canary test"; exit 4; fi
  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    printf '%s\n' "$CAN_OUT"; verdict "CANARY-HANG" "$rc" "node cannot execute bun test (stalled ${CANARY_TIMEOUT}s)"
    exit 3
  fi
  if ! grep -qE '^[[:space:]]*1 pass' <<<"$CAN_OUT"; then
    printf '%s\n' "$CAN_OUT"; verdict "CANARY-NO-RESULT" "$rc" "bun test produced no canary result"
    exit 2
  fi
  printf '%s\n' "$CAN_OUT"; verdict "CANARY-OK" "$rc" "bun:test executes here (NOTE: this does NOT prove repo modules load)"
  exit 0
fi

command -v bun >/dev/null 2>&1 || { echo "verify-tests: bun not on PATH" >&2; exit 4; }
[ $# -gt 0 ] && TARGETS=("$@") || TARGETS=(src services)
cd "$REPO_ROOT" || exit 4

preflight

OUT=$(mktemp); trap 'rm -f "$OUT"' EXIT
start=$SECONDS
run_merged "$OUT" "$HARD_TIMEOUT" bun test "${TARGETS[@]}"
rc=$?
elapsed=$((SECONDS - start))
summary=$(grep -E '^[[:space:]]*Ran [0-9]+ tests? across ' "$OUT" | tail -1)

cat "$OUT"   # re-emit on stdout: the merged view is the point

if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
  verdict "HANG" "$rc" "still running after ${HARD_TIMEOUT}s (${elapsed}s elapsed) - NOT a test failure"
  [ "$FAULT" = 1 ] && fault_note "${BUN_INSTALL:-$HOME/.bun}"
  exit 3
fi
if [ -z "$summary" ]; then
  verdict "NO-VERDICT" "$rc" "runner exited without a summary line - nothing was verified"
  [ "$FAULT" = 1 ] && fault_note "${BUN_INSTALL:-$HOME/.bun}"
  exit 2
fi
if [ "$rc" = 0 ]; then
  verdict "PASS" "$rc" "${summary# } [${elapsed}s]"
  exit 0
fi
verdict "FAIL" "$rc" "${summary# } [${elapsed}s]"
exit 1
