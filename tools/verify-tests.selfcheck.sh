#!/usr/bin/env bash
# verify-tests.selfcheck.sh — falsify tools/verify-tests.sh.
#
# Proves, with no network and no real suite:
#   * a runner that exits 0 having produced NO summary is NOT reported as a pass
#     (the failure mode a money-safety verification must never accept);
#   * a stall is reported as HANG, not as FAIL;
#   * the measured env fault (BUN_INSTALL = dangling symlink) shortens the budget
#     and the HANG verdict names the cause and the fix;
#   * that same fault does NOT cause a false refusal when the suite genuinely
#     finishes (a stub that passes quickly still reports PASS);
#   * a writable BUN_RUNTIME_TRANSPILER_CACHE_PATH is honoured as the cure.
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VT="$HERE/verify-tests.sh"
STUBD=$(mktemp -d); FH=/tmp/vt-fh
trap 'rm -rf "$STUBD" "$FH"' EXIT
pass=0; fail=0

check() { # check <name> <expected_rc> <expected_tag> <stdout_must_contain>
  local name=$1 want_rc=$2 want_tag=$3 want_text=$4 out rc
  out=$("$VT" 2>/dev/null); rc=$?
  if [ "$rc" != "$want_rc" ]; then
    echo "FAIL $name: rc=$rc want=$want_rc"; echo "$out" | tail -3; fail=$((fail+1)); return
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

stub() { # stub <body>
  cat >"$STUBD/bun" <<EOF
#!/usr/bin/env bash
$1
EOF
  chmod +x "$STUBD/bun"
}
STUB_PASS='echo "bun test v1.4.2 (stub)"; { echo; echo "src/x.test.ts:"; echo "(pass) a > b [1.00ms]"; echo; echo " 3 pass"; echo " 0 fail"; echo "Ran 3 tests across 1 file. [12.00ms]"; } >&2; exit 0'

echo "== stub cases: the wrapper must merge stderr and require a summary =="
stub "$STUB_PASS"
PATH="$STUBD:$PATH" check "pass-with-summary" 0 PASS "(pass) a > b"

stub 'echo "bun test v1.4.2 (stub)"; exit 0'
PATH="$STUBD:$PATH" check "exit-0-without-summary" 2 NO-VERDICT "BUN-TEST VERDICT"

stub 'echo "bun test v1.4.2 (stub)"; { echo " 1 pass"; echo " 2 fail"; echo "Ran 3 tests across 2 files. [40.00ms]"; } >&2; exit 1'
PATH="$STUBD:$PATH" check "failing-suite" 1 FAIL "Ran 3 tests across 2 files"

stub 'echo "bun test v1.4.2 (stub)"; sleep 120'
BUN_TEST_HARD_TIMEOUT=3 PATH="$STUBD:$PATH" check "stalled-runner" 3 HANG "still running after 3s"

echo
echo "== the measured env fault: BUN_INSTALL is a dangling symlink =="
mkdir -p "$FH/.tmp"
ln -s /mnt/not-mounted-xyz/.bun "$FH/.bun"

stub 'echo "bun test v1.4.2 (stub)"; sleep 120'
HOME="$FH" BUN_INSTALL="$FH/.bun" BUN_TEST_FAULT_TIMEOUT=3 BUN_TEST_HARD_TIMEOUT=300 \
  PATH="$STUBD:$PATH" check "fault-shortens-budget-and-names-cause" 3 HANG "dangling symlink"

stub "$STUB_PASS"
HOME="$FH" BUN_INSTALL="$FH/.bun" BUN_TEST_FAULT_TIMEOUT=3 BUN_TEST_HARD_TIMEOUT=300 \
  PATH="$STUBD:$PATH" check "fault-does-not-false-refuse-a-green-suite" 0 PASS "Ran 3 tests across 1 file"

HOME="$FH" BUN_INSTALL="$FH/.bun" BUN_RUNTIME_TRANSPILER_CACHE_PATH="$FH/.tmp" \
  PATH="$STUBD:$PATH" check "writable-transpiler-override-honoured" 0 PASS "Ran 3 tests across 1 file"

echo
echo "== real bun: canary + the repo's declared suite =="
"$VT" --canary >/tmp/vt-canary.txt 2>&1; echo "canary rc=$? :: $(tail -1 /tmp/vt-canary.txt)"
"$VT" >/tmp/vt-suite.txt 2>&1; echo "suite  rc=$? :: $(tail -1 /tmp/vt-suite.txt)"

echo
if [ "$fail" -eq 0 ]; then
  echo "SELFCHECK: $pass/$((pass+fail)) cases ok"
else
  echo "SELFCHECK: $fail failures"; exit 1
fi
