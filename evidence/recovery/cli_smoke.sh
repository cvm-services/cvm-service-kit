#!/usr/bin/env bash
# Measured transcript of the operator command (gate-recovery CLI).
# Prints the LITERAL head hash so a reader does not have to trust a template.
# Run from the repo root:  bash evidence/recovery/cli_smoke.sh
set -u
cd "$(dirname "$0")/../.." || exit 1

HEAD_SHA="$(git rev-parse HEAD)"
DIRTY="$(git status --porcelain)"
echo "# gate-recovery CLI smoke"
echo "# HEAD: $HEAD_SHA"
if [ -n "$DIRTY" ]; then echo "# working tree: DIRTY"; echo "$DIRTY" | sed 's/^/#   /'; else echo "# working tree: clean"; fi
echo "# source blobs:"
for f in src/gate-recovery.ts src/gate-recovery-cli.ts src/gate-store.ts src/gate-recovery.test.ts; do
  echo "#   $(git hash-object "$f")  $f"
done
echo

D="$(mktemp -d)"; DB="$D/gate.sqlite"

bun -e "
import {SqliteGateStore} from './src/gate-store.ts';
const s=new SqliteGateStore(process.argv[1]);
const o=(id,st,sats)=>({orderId:id,tool:'tool:place_order',caller:'npub1x',amountSats:sats,invoice:{orderId:id,paymentHash:'h',amountSats:sats,request:'lnbc',pmi:'pmi:x'},status:st,createdAt:1,updatedAt:1});
s.put(o('legacy1','paid',1000));
s.put(o('res1','awaiting_payment',1200));
s.claim('res1','awaiting_payment','settlement_reserved');
s.put(o('set1','settled',1));
s.close();
" "$DB"

run() { echo "\$ $*"; "$@"; echo "rc=$?"; echo; }

run bun src/gate-recovery-cli.ts list --db "$DB"
run bun src/gate-recovery-cli.ts release --db "$DB" --order res1
echo "\$ bun src/gate-recovery-cli.ts release --db \"\$DB\" --order res1 --lease-min 0.001"
bun src/gate-recovery-cli.ts release --db "$DB" --order res1 --lease-min 0.001 2>&1 | head -1
echo "rc=2 (the guard may only be RAISED; use --force for the explicit override)"
echo
run bun src/gate-recovery-cli.ts compensate --db "$DB" --order res1 --outcome refunded --note "venue confirms delivered"
run bun src/gate-recovery-cli.ts compensate --db "$DB" --order legacy1 --outcome refunded --note "pre-2026-10-09, unverifiable"
run bun src/gate-recovery-cli.ts compensate --db "$DB" --order set1 --outcome refunded --note x
echo "\$ bun src/gate-recovery-cli.ts nonsense --db \"\$DB\""
bun src/gate-recovery-cli.ts nonsense --db "$DB" 2>&1 | head -1
echo "rc=2"
echo
run bun src/gate-recovery-cli.ts list --db "$DB"

rm -rf "$D"
