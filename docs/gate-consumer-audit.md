# Consumer audit: the shared money gate (`ExplicitGate` / `GateOrderStore`)

Card: `t_7233c336` — PR #13 money gate: consumer audit (BLOCKING) + recovery path + test hardening.
Branch: `fix/gate-consumer-audit`, merged with `github/main` @ `0dc9b71` (the audit's first
pass was written against `e2a7065`; the branch had drifted 9 commits behind, so the merge was
taken and **every grep below re-run on the merged tree** — see the merge note at the end).

The cross-family review of PR #13 made this audit the blocking item, on the premise
that changing an exported, fleet-shared interface (`GateOrderStore.claim` became
required, `GateOrderStatus` gained members) would break five *out-of-repo* consumers
(`cvm-sms4sats`, `cvm-ppq`, `cvm-nanogpt`, `cvm-lambda`, `cvm-2fiat`) at typecheck or
throw `this.store.claim is not a function` *after* payment was verified.

**The premise is false, and that is the first finding.**

## F1. The five named consumers are not repositories — they are directories in this one

```
$ gh repo list cvm-services --limit 50
cvm-services/cvm-registry           cvm-services/contextvm-services
cvm-services/cvm-orders             cvm-services/cvm-kalman-server
cvm-services/cvm-service-kit        cvm-services/nadanada-service
                                    cvm-services/jlcpcb-service
                                    cvm-services/hermes-insights-cvm
                                    cvm-services/openai-codex-auth
```

There is no `cvm-services/cvm-sms4sats`, `cvm-ppq`, `cvm-nanogpt`, `cvm-lambda` or
`cvm-2fiat` on GitHub:

```
$ gh repo view cvm-services/cvm-sms4sats --json name
GraphQL: Could not resolve to a Repository with the name 'cvm-services/cvm-sms4sats'. (repository)

$ gh repo view cvm-services/cvm-2fiat --json name
GraphQL: Could not resolve to a Repository with the name 'cvm-services/cvm-2fiat'. (repository)
```

All five are directories of this repo:

```
$ ls -d services/*/
services/_shared/  services/cvm-2fiat/  services/cvm-lambda/
services/cvm-nanogpt/  services/cvm-ppq/  services/cvm-sms4sats/
```

Every one of them imports the gate through a relative path, not a published package:

```
$ for d in cvm-sms4sats cvm-ppq cvm-nanogpt cvm-lambda cvm-2fiat; do \
    echo "$d: $(grep -rl --include=*.ts 'src/index.ts' services/$d | wc -l) files import ../../../src/index.ts"; done
cvm-sms4sats: 8 files import ../../../src/index.ts
cvm-ppq: 1 files import ../../../src/index.ts
cvm-nanogpt: 1 files import ../../../src/index.ts
cvm-lambda: 1 files import ../../../src/index.ts
cvm-2fiat: 6 files import ../../../src/index.ts
```

Consequences that change the verdict:

1. **The blast radius is in-tree and typechecked.** `tsconfig.json` includes
   `["src/**/*.ts", "services/**/*.ts"]`, so `bun run typecheck` (`tsc --noEmit`)
   compiles every consumer against the changed interface. A consumer-owned store
   missing `claim` could not have shipped: it fails the declared `typecheck` script,
   not production.
2. **There is no cross-repo version skew.** No consumer can pin an older kit while
   the interface moves, because none of them consume a published kit version.

## F2. No consumer owns a `GateOrderStore` — the `TypeError` failure mode does not exist

```
$ grep -rn --include=*.ts "implements GateOrderStore" src services | grep -v '\.test\.ts'
src/gate-store.ts:34:export class SqliteGateStore implements GateOrderStore {
src/payment.ts:305:export class MemoryOrderStore implements GateOrderStore {

$ grep -rn --include=*.ts ": GateOrderStore" src services | grep -v '\.test\.ts'
src/payment.ts:356:    private readonly store: GateOrderStore = new MemoryOrderStore(),
```

Only the two kit implementations exist, and both define `claim`. No consumer declares
its own store type, and none takes a `GateOrderStore` in its own signature. Therefore
`this.store.claim is not a function` **cannot** be reached from any consumer: every
construction site passes either a `SqliteGateStore` or nothing.

(Without the `grep -v '\.test\.ts'` filter the same grep also matches two **test doubles**
inside `src/replay_binding.test.ts` — `LossyStore` and `LegacyClaimStore`. They are in the
kit's own test file, not in any service, and they implement the interface *because* they are
deliberate mutation fixtures for the replay-binding tests. They are the only other matches,
which is the point.)

## F3. Per-consumer gate construction — the complete table

```
$ grep -rn --include=*.ts "new ExplicitGate(" src services | grep -v '\.test\.ts'
src/evidence/red_before.ts:48:const gate = new ExplicitGate(processor, new MemoryOrderStore());
services/cvm-lambda/src/server.ts:118:      ? new ExplicitGate(
services/cvm-sms4sats/src/server.ts:93:  return new ExplicitGate(processor, new SqliteGateStore(gateDb));
services/cvm-2fiat/src/server.ts:95:      ? new ExplicitGate(
services/cvm-ppq/src/server.ts:21:      ? new ExplicitGate(
services/cvm-nanogpt/src/server.ts:16:      ? new ExplicitGate(
services/cvm-deepinfra/src/server.ts:26:      ? new ExplicitGate(
```

The first line is the `src/evidence/` RED-before harness, not a service. The remaining
**six** are product construction sites — five at the time of the first pass, plus
`cvm-deepinfra` (see the second merge note at the end).

| consumer | gate store at the merged head | durable? | affected by the hardened interface |
| --- | --- | --- | --- |
| `services/cvm-lambda/src/server.ts:118-120` | `new SqliteGateStore(cfg.gateDb)` | yes | none — has `claim`; only gains the terminal-state behaviour |
| `services/cvm-ppq/src/server.ts:21-23` | `new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-ppq/gate.sqlite")` | yes | none |
| `services/cvm-nanogpt/src/server.ts:16-18` | `new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-nanogpt/gate.sqlite")` | yes | none |
| `services/cvm-2fiat/src/server.ts:95` | `new SqliteGateStore(cfg.gateDb)` | yes | none |
| `services/cvm-deepinfra/src/server.ts:26-29` | `new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-deepinfra/gate.sqlite")` | yes | none |
| `services/cvm-sms4sats/src/server.ts` | **`new ExplicitGate(processor)` — no store** | **no (in-process Map)** | **this was the defect; fixed on this branch, see F5** |

## F4. No consumer branches on a gate status, so the new terminal states break nothing

```
$ grep -rn --include=*.ts -E '\.status *=== *"(paid|settled|settlement_)' src services | grep -v '\.test\.ts'
src/payment.ts:394:    if (order.status === "settled") {
```

That is the *only* product-code branch on a `GateOrder.status` anywhere in the tree —
inside the gate itself. In particular the legacy `"paid"` status is read at exactly one
place (`src/payment.ts`, the exhaustive switch) and by no consumer.

The two `.status ===` hits that do exist in services are unrelated: they are upstream
*supplier* statuses, not gate statuses.

```
services/cvm-sms4sats/src/tools.ts:188    res?.status === "completed" || res?.status === "code_received"   # sms4sats API
services/cvm-sms4sats/src/upstream.ts:97  last?.status === "code_received"                                  # sms4sats API
```

### F4b. The `===`-only grep above is narrower than the conclusion — widened (review finding A2)

A cross-family re-review of this audit (finding A2) correctly noted that a single
`grep -E '\.status *=== *"..."'` does not by itself establish *"no consumer branches on a
gate status in ANY form"*: it would miss `!=`, `==`, `!==`, a `switch (x.status)` with
`case`, single quotes, computed `x["status"]`, or a variable derived from `.status`. The
conclusion is unchanged, but it now rests on a search that can actually see those forms.
Every comparison-like use of `.status` in product code, with the sms4sats supplier-status
and HTTP-status false positives removed:

```
$ grep -rn --include=*.ts -E '\.status\s*(===|!==|==|!=)|switch\s*\(.*\.status' src services \
    | grep -v '\.test\.ts'
src/gate-recovery.ts:116:  if (order.status !== "settlement_reserved") ...
src/gate-recovery.ts:153:  if (order.status !== "settlement_failed") ...
src/escalation.ts:308:      if (intent && intent.status !== "settled") {        # fiat intent, not GateOrder
src/settlement.ts:107:    switch (intent.status) {                              # fiat intent, not GateOrder
src/payment.ts:84:    next.status === "awaiting_payment" &&                 # the gate itself
src/payment.ts:85:    TERMINAL_STATUSES.includes(prev.status)               # the gate itself
src/payment.ts:338:    if (!cur || cur.status !== from) return false;        # the gate itself (CAS)
src/payment.ts:394:    if (order.status === "settled") {                     # the gate itself
src/payment.ts:411:    switch (order.status) {                               # the gate itself
src/l402.ts:50:  if (first.status !== 402) {                           # HTTP status
services/cvm-lambda/src/server.ts:221:  if (j.status !== "succeeded" && j.status !== "failed") {  # supplier job
services/cvm-sms4sats/src/upstream.ts:96:  if (last?.status && TERMINAL.has(last.status)) ...       # sms4sats API
services/cvm-sms4sats/src/upstream.ts:97:  if (last?.status === "code_received") ...                 # sms4sats API
services/cvm-sms4sats/src/tools.ts:154:  if (quote.status !== 402 || !quote.challenge ...) {      # HTTP status
```

Every `GateOrderStatus`-typed comparison is inside `src/payment.ts` (the gate) or
`src/gate-recovery.ts` (this branch's operator module, whose two `!==` guards *refuse*
anything that is not `settlement_reserved` / `settlement_failed` — i.e. they fail closed).
The `escalation.ts` / `settlement.ts` hits are the **fiat intent** state machine on a
different type; `l402.ts` / `tools.ts` are HTTP; `lambda/server.ts` / `upstream.ts` are
supplier statuses. No service reads a `GateOrder.status`.

The literal-string search agrees — this is the check that does not depend on the
comparison operator at all:

```
$ for s in awaiting_payment settlement_reserved settlement_failed refused; do
    echo "== $s"; grep -rn --include=*.ts "\"$s\"" services/ | grep -v '\.test\.ts'; done
== awaiting_payment         (no matches)
== settlement_reserved      (no matches)
== settlement_failed        (no matches)
== refused                  2 matches, both comment PROSE, not comparisons:
   services/jlc-quote/src/types.ts:7:   ... a refusal carries no ...
   services/cvm-2fiat/src/hygiene.ts:17: ... "not implemented" and "refused" are different claims ...
```

So no `GateOrderStatus` literal occurs in any service's *code*; the only two hits are
English prose in comments, in two services that do not touch the gate (`cvm-jlc-quote`
runs `PAYMENT_MODE: "none"`).

Similarly, no consumer catches the error classes. `SettlementFailedError`,
`SettlementInProgressError` and `GateOrderStateError` appear in **no** service product
code — the only references outside `src/payment.ts` are test files
(`services/cvm-sms4sats/src/{tools,wallet}.test.ts`, `services/_shared/ai.test.ts`,
`services/cvm-2fiat/src/escalation-wiring.test.ts`):

```
$ grep -rn --include=*.ts -E "SettlementFailedError|SettlementInProgressError|GateOrderStateError|PaymentRequiredError" services/ | grep -v '\.test\.ts'
(no matches)
```

Services only ever see these as an `isError: true` tool result, which is the fail-closed
path. Retry assumptions are therefore not invalidated anywhere: a retry of a terminal
order is refused by the gate before the consumer's `run()` is called.

## F5. The one real consumer defect: `cvm-sms4sats` had no store at all — fixed here

`ExplicitGate` defaults to `MemoryOrderStore`, an in-process `Map`. `cvm-sms4sats`
already builds `new SqliteOrderStore(cfg.orderDb)` for its own order book, but handed
the gate no store, so the gate's *own* memory of "this payment is settled" lived only
in RAM. On `Restart=always` (the deployed unit, see F6) that memory is erased, a
replayed proof is re-verified against a still-settled invoice, and the paid tool runs a
second time against one payment — the double spend the gate exists to prevent, for that
tool shape.

Fixed on this branch: `buildGate(processor, cfg.gateDb)` now constructs
`new ExplicitGate(processor, new SqliteGateStore(gateDb))`, `GATE_DB` defaults to
`/var/lib/loom/cvm-sms4sats/gate.sqlite` (the state dir the `cvm_service` role already
creates and owns) and is declared in `deploy/ansible/playbook-wrappers.yml`.

Evidence — `services/cvm-sms4sats/src/gate-durability.test.ts`, with a falsification
control so the test cannot pass vacuously:

* CONTROL (`new ExplicitGate(processor)`, the pre-fix shape): after a simulated restart
  the replayed order **does** re-run the tool — `runs === 2`.
* Fix (`buildGate`): after the same restart the replay returns the cached result and
  `runs === 1`.
* Mutant reverting `buildGate` to `new ExplicitGate(processor)` → the durability test
  fails with `Expected: "sent-1" / Received: "sent-2"` (measured).

### F5b. The cutover window this fix does NOT retroactively close (review finding A1)

A cross-family re-review (finding A1) raised the one window the fix cannot close, and it is
real: the durability fix starts a **fresh, empty** `gate.sqlite`. A payment that was settled
by the *old* in-memory gate has no row in the new file, so the first replay of a
**pre-upgrade** proof after the upgrade re-verifies against a still-settled invoice and can
run the tool a second time. That is the same mechanism F5 cites.

Two things bound it, and neither is a substitute for the ops step:

1. **It is not a regression — it is the pre-existing behaviour, bounded.** Before the fix the
   in-memory Map was erased on *every* `Restart=always`, so the whole settlement history was
   replayable at all times. After the fix the exposed set is exactly the orders that were
   settled *and still resident in RAM* at the moment of cutover. The fix strictly shrinks the
   window from "always" to "the in-flight set at cutover", and closes it permanently
   afterwards. The reviewer's proposed falsification — seed a processor whose `verify`
   accepts a pre-upgrade proof, call the tool twice, observe `runs === 2` — is exactly the
   branch's own pre-fix CONTROL test, which already asserts those `runs === 2`. It is
   demonstrable today; it is the shape of the bug, not of the fix.
2. **It is not closeable by backfill.** The gate row needs the outcome that was never
   written (the old store wrote nothing durable) and the `proofHash` binding. A row invented
   at cutover would assert a settlement the gate cannot evidence.

**The mitigation is an ops step, not code**, and it is now in the runbook
(`docs/gate-recovery-runbook.md` § "Upgrading a service to the durable gate"): stop taking
new paid work, let the in-flight actions drain, then upgrade. The residual is stated rather
than engineered away, because the honest fix for "the old store recorded nothing" is not a
migration — it is never having had the old store.

## F6. Multi-replica exposure of `MemoryOrderStore` — measured, not assumed

`MemoryOrderStore.claim` is a synchronous check-and-set on a `Map`, so its guarantee
holds only within one process. The audit question was whether any consumer runs across
replicas, which would leave the double-spend unfixed there.

```
$ grep -rn -iE "replica|scale|cluster|instances" deploy/
(no matches)

$ cat deploy/ansible/roles/cvm_service/templates/service.service.j2
[Service]
Type=simple
ExecStart={{ cvm_service_home }}/.bun/bin/bun {{ cvm_service_repo_dir }}/{{ cvm_service_script }}
Restart=always
```

`deploy/ansible/playbook-wrappers.yml` declares one `wrappers:` entry per service, each
with a single `script:`; the role renders a plain non-templated `Type=simple` unit. One
process per service, no systemd instancing (`@`), no replica count, no horizontal
scaling anywhere in the deploy tree.

So at `main` the single-process limitation was not *currently* reachable — but it was
not a safe place to stand either, because the same in-memory store also lost state on
every ordinary `Restart=always` (F5). With `cvm-sms4sats` moved to `SqliteGateStore`,
**no shipped service constructs a gate over the in-memory store any more**; the only
remaining use is `new MemoryOrderStore()` as a test double and the
`src/evidence/red_before.ts` harness. If a future service needs to run more than one
replica, `SqliteGateStore.claim` (one guarded `UPDATE ... WHERE status = ?`) is the
cross-process-correct implementation to use; `MemoryOrderStore` is explicitly not.

## F7. Other repos are not gate consumers

The manager addendum flagged that the consumer list might be incomplete and named
`contextvm-services` as a possible consumer. Audited:

* `cvm-services/contextvm-services` — vendors the kit, but only
  `src/{announce,mod,validate,vocab}.ts`; there is **no** vendored `payment.ts` or
  `gate-store.ts`, and `ExplicitGate`/`GateOrderStore` appear nowhere in the repo. It
  is an announcement/vocab consumer, not a money-gate consumer.
* `cvm-services/cvm-orders`, `cvm-services/cvm-registry`,
  `cvm-services/cvm-kalman-server`, `cvm-services/hermes-insights-cvm` — no
  `cvm-service-kit` import of any kind (grep for `cvm-service-kit|cvm-kit`: no hits).
  `cvm-orders` has its own `SqliteOrderStore`-style order book, but that is this repo's
  `src/orders.ts` interface (`OrderStore`: `get`/`createOrGet`/`update`) — a different
  type from `GateOrderStore`, untouched by the `claim` change.

## Verdict per audit item

| item from the blocker | verdict | evidence |
| --- | --- | --- |
| a store impl lacking the required `claim` → `TypeError` after payment | **does not exist**; and would be caught by `bun run typecheck`, in-tree | F1, F2 |
| any branch on `status === "paid"` / retry assumptions invalidated by terminal states | **none in any consumer**; one branch, inside the gate | F4 |
| `MemoryOrderStore` single-process; consumer across replicas keeps the double spend | no replica deployment exists; **the same store also lost state on every restart, and `cvm-sms4sats` was using it — fixed** | F5, F6 |

## Reproducing

```
gh repo list cvm-services --limit 50
ls -d services/*/
grep -rn --include=*.ts "implements GateOrderStore" src services
grep -rn --include=*.ts ": GateOrderStore" src services
grep -rn --include=*.ts "new ExplicitGate(" src services | grep -v '\.test\.ts'
grep -rn --include=*.ts -E '\.status *=== *"(paid|settled|settlement_)' src services | grep -v '\.test\.ts'
grep -rn -iE "replica|scale|cluster|instances" deploy/
bun run typecheck          # compiles src + services against the changed interface
bun test services/cvm-sms4sats/src/gate-durability.test.ts
```

## F8. Recovery from the two terminal states (the review's HIGH finding) — implemented

The cross-family review's HIGH finding was independent of the consumer question: the gate
correctly never re-runs an action against a verified payment, but that left two states with
no exit — `settlement_reserved` (crashed after the claim) and `settlement_failed` (action
failed) — i.e. "money taken, order stuck", with no lease, no reconcile/refund command and
no ops runbook.

Implemented as an operator path that cannot be automatic, because **whether a crashed
`settlement_reserved` action reached the venue is knowable only by looking at the venue**;
a lease expiry is indistinguishable from a slow action, so an automatic release would
re-run an action of unknown outcome — the original double spend.

| piece | what it does |
| --- | --- |
| `src/gate-recovery.ts` | `findStuckOrders` (read-only: reserved + failed, with age and lease flag), `releaseReservation` (CAS `settlement_reserved -> awaiting_payment`, refuses a live lease unless `force`), `recordCompensation` (durable audit record for a `settlement_failed` order; deliberately leaves the status alone) |
| `src/gate-recovery-cli.ts` | `bun src/gate-recovery-cli.ts list\|release\|compensate --db <gate.sqlite>`; exit 1 on refusal, 2 on usage error |
| `src/gate-store.ts` | `list(statuses?)` + a `gate_recovery` table (`putResolution`/`listResolutions`). `list` is on the concrete store, NOT on the `GateOrderStore` interface — the interface is not widened again |
| `src/gate-recovery.test.ts` | 6 tests, including the falsification control that inspecting is read-only, that a live lease is refused and `list` alone never moves a row |
| `docs/gate-recovery-runbook.md` | the operator procedure, per-service gate DB paths, and the hard rules |

Two properties the tests pin down explicitly:

* **The escape hatch works end to end.** Crash after claim → `SettlementInProgressError`
  for the caller; `releaseReservation` past the lease → the retry re-verifies, claims and
  runs the tool **once**; a further replay returns the cache.
* **Nothing can be resurrected.** `releaseReservation` refuses any order that is not
  currently `settlement_reserved` (settled and failed rows both refuse), and
  `recordCompensation` refuses anything that is not `settlement_failed`. A compensated
  order still throws `SettlementFailedError` with `runs === 0`.

## Status of the review's other findings on `fix/gate-consumer-audit`

| finding | status |
| --- | --- |
| BLOCKER: five consumers vs `claim` / terminal states | **closed** — F1–F7 above; the premise was false and the one real defect (`cvm-sms4sats` in-memory store) is fixed |
| HIGH: no recovery path | **closed** — F8 |
| MED: unenumerated statuses fall through to `run()` | already fixed in the merged gate (`src/payment.ts`, exhaustive switch + `default`); covered by `money_safety.test.ts` "an unrecognised order status is refused, never run" |
| MED: terminal write unguarded (SQLITE_BUSY pins the row) | already fixed in the merged gate (both terminal `put`s wrapped, fail closed); covered by the lock-contention test |
| MED: `rejects.toThrow()` with no argument | already fixed — the test now asserts `SettlementFailedError` + code + orderId + message |
| MED: comment contradicts the mutation table | **closed** — the `~99%` claim is removed from the concurrency test comment and both stale rows in `REPORT.md` carry the re-measurement (M1 caught, M2 4-of-6 at any round count) |
| MED: `GateOrder.failure` with no DDL/migration; `changes === 1` presumes a unique key | already fixed — explicit `ALTER TABLE` migration + `order_id TEXT PRIMARY KEY`; covered by the pre-fix-database migration test |
| LOW: `deno.lock` riding in an unrelated commit | **closed** — split into its own commit (`chore(deno): reconcile the committed deno.lock with package.json`) |
| UNVERIFIED: replay guard keying on `result !== undefined` | **closed** — the guard is `status === "settled"`, and the "void tool (run() returns undefined)" test pins it against both stores |

## Merge note (2026-10-14) — the branch was 9 commits behind and is now merged with main

When this card was picked up for verification, `fix/gate-consumer-audit` was based on
`e2a7065` while `main` had advanced to `0dc9b71` (PRs #14–#19, including PR #19's
*settled-replay proof binding* — `GateOrder.proofHash`, `TERMINAL_STATUSES`, the
`SettlementEvidenceMismatchError` / `SettlementBindingNotPersistedError` classes, and the
new-generation `CASE` in `SqliteGateStore.put`). A stale PR cannot be merged, so `main`
was merged into the branch (never rebased, per the fleet working agreement) and the two
conflicts were resolved as a **union**:

* `src/gate-store.ts` — main's `proof_hash` migration, `TERMINAL_STATUSES`-derived SQL and
  4-argument `claim()` are KEPT, together with this branch's `gate_recovery` table,
  `list()`, `putResolution()` / `listResolutions()` and the `GateResolution` type. The
  recovery path only ever calls `get` / `list` / `claim(id, from, to)`, all of which the
  merged store still satisfies (the `proofHash` parameter is optional).
* `PROGRESS.md` — both sections kept.

Two consequences worth stating plainly:

1. **The line numbers in F2/F2b/F4 above were re-run on the merged tree** (they had moved:
   `payment.ts` gained ~275 lines from PR #19). The claims did not change; only the
   citations did. F2's grep now needs the `grep -v '\.test\.ts'` filter because PR #19
   added two test doubles that implement the interface inside the kit's own test file.
2. **Re-verified on the merge result** (`cb01506`): `bun run typecheck` rc=0;
   `bun test src services` → **258 pass / 1 skip / 0 fail** (259 tests, 38 files) rc=0;
   `bun test src/gate-recovery.test.ts` 6/6; `bun test services/cvm-sms4sats/src/gate-durability.test.ts`
   3/3; `bun test src/money_safety.test.ts` 14/14.

**Not verified here (stated, not hidden):** `deploy/ansible/playbook-wrappers.yml` gains a
`GATE_DB:` env line for the `cvm-sms4sats` wrapper. That is an IaC change and the fleet
working agreement requires IaC to be executed against a live node *and read back from the
node*; this host has no managed target and no fleet credentials, so the line is
**unexecuted**. It is a pure additive env var consumed by `configFromEnv` (defaulted in
code, so an un-updated host still works) — but that is an argument, not evidence.

## Merge note 2 (2026-10-14) — main advanced again, and the consumer set GREW to six

`main` moved on from `0dc9b71` to `b9a50bf` (12 commits: PRs #20–#22, the `cvm-jlc-quote`
service and `cvm-deepinfra`). `main` was merged into the branch again
(`6b69d08`, merge, never rebase). It applied with **no conflicts**; the single file
touched on both sides is `deploy/ansible/playbook-wrappers.yml`, and the two hunks are in
different regions (ours adds `GATE_DB:` for `cvm-sms4sats` at the wrapper list head; main
appends a whole `cvm-jlc-quote` wrapper at the tail).

**The finding that matters: the consumer set is not closed, and it grew.**

`cvm-deepinfra` is a **new sixth** `ExplicitGate` construction site
(`services/cvm-deepinfra/src/server.ts:26-29`), and `cvm-jlc-quote` is a new service that
does *not* touch the gate (`PAYMENT_MODE: "none"`). The F3 table above is updated.

This does not weaken the audit — it *demonstrates its own argument*:

* The new consumer was written against the hardened interface and passes a durable
  `SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-deepinfra/gate.sqlite")`, i.e. it
  already has the required `claim`. Had it not, `bun run typecheck` (which compiles
  `src/**/*.ts` **and** `services/**/*.ts`) would have failed the moment it landed, on
  `main`, before any gate change could reach it. That is F1/F2's point, confirmed by the
  first new consumer to appear since the audit was written.
* It is also why "audit the five named consumers" was the wrong shape of question: the
  consumer set is defined by the repo's `services/*` directory and the typecheck, not by a
  prose list frozen at review time. **The durable control is the in-tree typecheck, not a
  checklist** — any future consumer is covered by it automatically.

**Re-verified on the merge result** (`6b69d08`): `bun run typecheck` rc=0;
`bun test src services` → **328 pass / 1 skip / 0 fail** (329 tests, 43 files) rc=0;
`deno task test` → **29 passed / 0 failed**; `deno check src/payment.ts src/gate-store.ts
src/gate-recovery.ts src/gate-recovery-cli.ts` rc=0.

**One honest caveat about `bun test` and `tests/`.** `bun test src services tests` reports
**3 fail / 3 errors** — all of them `ReferenceError: Deno is not defined` from
`tests/deepinfra_quote_test.ts` and the other `Deno.test`-native files that `main` added
under `tests/`. This is **pre-existing on `main`**, not a regression from this branch:
a detached worktree at pristine `github/main` (`b9a50bf`) reports the identical
`0 pass / 3 fail / 3 errors` for `bun test tests`. Those files belong to the **Deno** lane,
where they pass (`deno task test` → 29 passed / 0 failed). The bun suite of record is
therefore `bun test src services`, which is green.

## Round-2 cross-family review (2026-10-15) — findings, and their closure

A genuine cross-family review was obtained this round (the recovery path earlier reported
to be unobtainable). The lane that served was the oneshot harness against `kimi-k2.7-code`,
which the flat router served as **`deepseek-flash`** — a different family from the glm/zai
author, so D-115 is satisfied by lineage; the *requested* lineage was lost to a substitution
and that is stated rather than hidden. Artifact:
`~/reports/reviews/cvm-service-kit-pr17-A2-audit.md` (`VERDICT: REQUEST_CHANGES`).
Its findings were overwhelmingly **"the supplied material did not contain the evidence"**
rather than "the code is wrong" — so each is closed below *with the evidence*, and the
audit doc now carries it. Nothing here was dismissed.

### A2-B1 (BLOCKER): the F4 grep is narrower than the conclusion

**Accepted — and it was a fair hit on the evidence, not the conclusion.** The reviewer's own
suggested falsifier was `grep -rn --include=*.ts -i 'paid' services`. Run:

```
$ grep -rn --include=*.ts -i 'paid' services/ | grep -v '\.test\.ts'
```

Every hit is English prose or an unrelated field: tool `description` strings ("paid per
call", "idempotency key for a paid call"), comments, the `mock-l402.ts` mock server's own
`{ paid: boolean }` order flag, and `cvm-lambda/tools/mint-testnut.ts` reading a **mint
quote** state (`"PAID"` / `"ISSUED"`, a Cashu mint state, not a `GateOrderStatus`). No hit is
a comparison against a gate status. The operator-independent literal search and the widened
comparison search are in **F4b** above; both agree. Conclusion unchanged: no consumer
branches on a `GateOrder.status` in any form.

### A2-B2 (BLOCKER): casts or structural construction of a store

**Accepted — the greps did not cover `as GateOrderStore` / `as any` / an inline literal.**
Run:

```
$ grep -rn --include=*.ts -E "as GateOrderStore|as any|<GateOrderStore>" src services | grep -v '\.test\.ts'
```

**Zero `as GateOrderStore` and zero `<GateOrderStore>`.** The `as any` hits are all
`bun:sqlite` row casts (`this.db.query(...).get(id) as any`) in `src/gate-store.ts`,
`src/intent-store.ts`, `src/proof-store.ts`, `src/escalation.ts`,
`services/cvm-lambda/src/jobs.ts` — none is a store construction. And the structurally
dangerous form the reviewer named (an inline object literal passed as the second argument)
is ruled out by reading every construction site in full, not just its first line:

```
$ for f in cvm-lambda:118 cvm-sms4sats:93 cvm-2fiat:95 cvm-ppq:21 cvm-nanogpt:16 cvm-deepinfra:26; do
    svc=${f%%:*}; ln=${f##*:}; sed -n "$((ln-2)),$((ln+8))p" services/$svc/src/server.ts; done
```

All six resolve to `new SqliteGateStore(<path>)` — five inline in the guarded ternary
(`paymentMode === "cashu" && priceSats > 0 ? new ExplicitGate(proc, new SqliteGateStore(...)) : undefined`)
and one in `buildGate`. There is no object-literal store and no cast anywhere.

### A2-HIGH: the sms4sats state directory is asserted, not verified

**Accepted as a fair challenge; the evidence removes it.** `SqliteGateStore` does no
`mkdir` — `new Database(path)` then `CREATE TABLE IF NOT EXISTS` — so a missing parent
directory would indeed throw at startup. Two independent pieces of evidence close it:

1. **The role creates it, with the right owner.** `deploy/ansible/playbook-wrappers.yml:46`
   declares `state_dir: /var/lib/loom/cvm-sms4sats`, which the role consumes at
   `tasks/main.yml:154` (`cvm_service_state_dir: "{{ item.state_dir }}"`) and creates at
   `tasks/main.yml:137-143`:
   ```
   path: "{{ cvm_service_state_dir }}"   state: directory
   owner: "{{ cvm_service_user }}"       group: "{{ cvm_service_user }}"   mode: "0755"
   ```
2. **The directory is not new — the service already writes two SQLite files into it.**
   `ORDER_DB: /var/lib/loom/cvm-sms4sats/orders.sqlite` and
   `CASHU_WALLET_DB: /var/lib/loom/cvm-sms4sats/cashu.sqlite` are in the same wrapper block
   and have been in production. If that directory were absent or unwritable, `cvm-sms4sats`
   would already fail on its order book and wallet today. The same
   `/var/lib/loom/<svc>/gate.sqlite` path shape is already declared for `cvm-nanogpt`
   (`:78`), `cvm-ppq` (`:94`) and `cvm-2fiat` (`:110`), so the prerequisite is load-bearing
   for five services, not introduced by this branch.

Residual, stated: the wrapper line itself is an **IaC change and remains unexecuted on a
live node from this host** (no managed target, no fleet credentials) — the fleet agreement
requires a read-back from the node, and the argument above is an argument, not that
read-back. It is one additive env var, defaulted in code, on a path the service already uses.

### A2-MED: "no consumer catches the error classes" is name-only

**Accepted as a limit of the evidence; the broader search agrees.** A consumer could catch
generically and branch on `e.name` / `e.code`. Every `catch` in `services/` product code:

```
$ grep -rn --include=*.ts -E "catch\s*\(|\.name\s*===|\.code\s*===|instanceof" services/ | grep -v '\.test\.ts'
```

is one of: a top-level `main().catch((e) => console.error("FATAL:", ...))` fatal logger
(`cvm-lambda:304`, `cvm-sms4sats:176`, `cvm-2fiat:194`, `cvm-ppq:74`, `cvm-nanogpt:129`-ish,
`jlc-quote:171`), the shared `health.ts` probe wrapper, or a tool-level adapter catch. **None
inspects an error `name`/`code`, and none catches a gate error class** — no `instanceof
Settlement*` exists in any service. Services see a refusal only as an `isError: true` tool
result.

### A2-LOW: the "no replica deployment" search is under-searched

**Accepted; widened.** The named alternatives — systemd `@` instancing, `--workers`, `pm2`,
`docker-compose`, Kubernetes manifests:

```
$ grep -rn -E "systemd.*@|@\.service|--workers|pm2|docker-compose|kind: Deployment" deploy/ src/ services/
```

The only match is `cvm-lambda/.../build-rootfs.sh` writing
`serial-getty@ttyS0.service.d/autologin.conf` — an **OS getty** on the built rootfs image,
not service instancing. No `@`-instanced unit, no worker/process manager, no compose file,
no Deployment manifest anywhere in the tree. F6's conclusion holds.

### Settled from the review's COULD_NOT_VERIFY block (not filed — retired)

| open question from the reviewer | resolution |
| --- | --- |
| the second argument at each `new ExplicitGate(` site | all six shown verbatim above: `new SqliteGateStore(...)` |
| `SqliteGateStore` internals (creates DB/table? handles a fresh path?) | `src/gate-store.ts:34-59`: `new Database(path)`, `PRAGMA busy_timeout = 5000`, `CREATE TABLE IF NOT EXISTS gate_orders (... order_id TEXT PRIMARY KEY ...)`; no `mkdir` (hence A2-HIGH) |
| the `cvm_service` role dir task + the real `GATE_DB` hunk | quoted above (`tasks/main.yml:137-143`, `playbook-wrappers.yml:46,61`) |
| `gate-durability.test.ts` contents / control result | 3 tests: `CONTROL: an in-memory gate store really does lose settlement across a restart`, `buildGate gives the gate a durable store: a replay after restart never re-runs`, `the gate database defaults into the service state dir and honours GATE_DB` |
| `bun run typecheck` on head `6395631` | `tsc --noEmit` rc=0 (run this round) |
| whole-tree `bun test` + Deno lane | `bun test src services` **328 pass / 1 skip / 0 fail** (329 tests, 43 files) rc=0 (run this round); Deno lane: see the Merge note 2 caveat about `tests/` |
| `ExplicitGate` constructor + `GateOrderStore` interface | `private readonly store: GateOrderStore = new MemoryOrderStore()` (`src/payment.ts:356`); the interface is in `src/payment.ts`; `claim` is required and both kit stores define it |
| `as any` / dynamic import / re-export store construction | closed by A2-B2 above: none |
| every alternative status-comparison form | closed by F4b + A2-B1 above |
| `cvm-jlc-quote` does not touch the gate; `contextvm-services` vendors no `payment.ts` | from the audit: `cvm-jlc-quote` runs `PAYMENT_MODE: "none"` and appears in no `new ExplicitGate(` site; `contextvm-services` vendors only `announce/mod/validate/vocab` |
| `@` instancing / workers / compose / k8s in `deploy/` | closed by A2-LOW above: none |

## Independent self-check (SAME family — explicitly NOT a D-115 review)

Every non-flash model lane was capacity-exhausted on this host when the pass ran —
`HTTP 503 "all providers exhausted (flat router)"` for `kimi-k3`, `kimi-k2.7-code`,
`kimi-k3:cloud`, `minimax-m3:cloud` and `deepseek/deepseek-v4-pro`. A **cross-family** review
therefore could not be obtained here, and the re-review request was published on the PR
instead (see the PR comment). A same-family, independent-context adversarial pass was run
anyway — `deepseek/deepseek-v4-flash`, which is the *dispatching agent's own family*, so it
**does not satisfy D-115 and is not a review of record**. Its findings and dispositions:

| finding | disposition |
| --- | --- |
| HIGH: `gate-recovery-cli.ts` absent from the reviewed diff, so the CLI money-path is unreviewed | **not a defect** — an artefact of the diff subset handed to the lane. The file is in the branch, and its exit codes were measured directly here (usage 2, bad subcommand 2, refusal 1) |
| MED: `releaseReservation`'s only guard is the time-based lease, and `--force` bypasses even that | **accepted, documented** — the lease is a *surfacing hint*, never an enforcement, because whether a crashed action reached the venue is knowable only from the venue. There is no durable record of a **release** itself, which is a real asymmetry with `recordCompensation`; noted here rather than fixed, since adding one changes the CLI contract |
| MED: the escape-hatch test's `verify()` returns `true` unconditionally, so it proves the CAS/release mechanics but not a real single-use proof being re-driven | **accepted** — the same simplification the gate's own tests use; the processor-level exactly-once hazard is a documented residual (`PaymentProcessor.verify` JSDoc, REPORT §5) |
| LOW: `list([])` returned **ALL** orders, contradicting its own doc ("all orders when omitted") | **FIXED** — RED test added first (`src/gate-store.test.ts`, "list([]) is an EMPTY filter, not 'no filter'"), then `list([])` returns `[]`; `list()` / `list("x")` / `list(["x","y"])` unchanged |
| LOW: a compensated order stays in `findStuckOrders` forever | **by design** — the report shows it as `compensated=<outcome>` so the operator sees it is resolved, and `settlement_failed` is deliberately never rewritten (that status is what keeps a replay refusing) |
