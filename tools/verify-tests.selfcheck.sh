#!/usr/bin/env bash
# verify-tests.selfcheck.sh — falsify tools/verify-tests.sh.
#
# Proves, with no network and no real suite, that the wrapper reports the four
# outcomes correctly - in particular that a runner which exits 0 having produced
# NO summary is NOT reported as a pass (that is the failure mode a money-safety
# verification must never accept), and that a stall is reported as HANG, not FAIL.
#
# Each case installs a stub `bun` first on PATH that reproduces a real bun test's
# stream discipline: banner on stdout, results on stderr.
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VT="$HERE/verify-tests.sh"
STUBD=$(mktemp -d); trap 'rm -rf "$STUBD"' EXIT
pass=0; fail=0

check() { # check <name> <expected_rc> <expected_tag> <stdout_must_contain>
  local name=$1 want_rc=$2 want_tag=$3 want_text=$4 out rc
  out=$("$VT" 2>/dev/null); rc=$?
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL $name: rc=$rc want=$want_rc"; fail=$((fail+1)); return
  fi
  if ! grep -q "BUN-TEST VERDICT: $want_tag" <<<"$out"; then
    echo "FAIL $name: no '$want_tag' verdict"; echo "$out" | tail -3; fail=$((fail+1)); return
  fi
  if [ -n "$want_text" ] && ! grep -qF "$want_text" <<<"$out"; then
    echo "FAIL $name: stdout missing '$want_text'"; fail=$((fail+1)); return
  fi
  echo "ok   $name (rc=$rc, verdict $want_tag)"
  pass=$((pass+1))
}

stub() { # stub <name> <body>
  cat >"$STUBD/bun" <<EOF
#!/usr/bin/env bash
$2
EOF
  chmod +x "$STUBD/bun"
}

echo "== stub-based cases (wrapper must merge stderr and require a summary) =="

stub pass 'echo "bun test v1.4.2 (stub)"; { echo; echo "src/x.test.ts:"; echo "(pass) a > b [1.00ms]"; echo; echo " 3 pass"; echo " 0 fail"; echo "Ran 3 tests across 1 file. [12.00ms]"; } >&2; exit 0'
PATH="$STUBD:$PATH" check "pass-with-summary" 0 PASS "(pass) a > b"

stub norr 'echo "bun test v1.4.2 (stub)"; exit 0'
PATH="$STUBD:$PATH" check "exit-0-without-summary" 2 NO-VERDICT "BUN-TEST VERDICT"

stub fail 'echo "bun test v1.4.2 (stub)"; { echo " 1 pass"; echo " 2 fail"; echo "Ran 3 tests across 2 files. [40.00ms]"; } >&2; exit 1'
PATH="$STUBD:$PATH" check "failing-suite" 1 FAIL "Ran 3 tests across 2 files"

stub hang 'echo "bun test v1.4.2 (stub)"; sleep 120'
BUN_TEST_HARD_TIMEOUT=3 PATH="$STUBD:$PATH" check "stalled-runner" 3 HANG "still running after 3s"

echo
echo "== real bun: canary + the repo's declared suite =="
"$VT" --canary 2>&1 | tail -3
echo "canary rc=$?"
"$VT" 2>&1 | tail -3
suite_rc=${PIPESTATUS[0]}
echo "suite rc=$suite_rc"

echo
if [ "$fail" -eq 0 ]; then
  echo "SELFCHECK: $pass/$((pass+fail)) stub cases ok"
else
  echo "SELFCHECK: $fail failures"; exit 1
fi
