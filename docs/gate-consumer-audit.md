# Consumer audit: the shared money gate (`ExplicitGate` / `GateOrderStore`)

Card: `t_7233c336` — PR #13 money gate: consumer audit (BLOCKING) + recovery path + test hardening.
Branch: `fix/gate-consumer-audit`, based on `github/main` @ `e2a7065`.

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
$ grep -rn --include=*.ts "implements GateOrderStore" src services
src/gate-store.ts:9:export class SqliteGateStore implements GateOrderStore {
src/payment.ts:140:export class MemoryOrderStore implements GateOrderStore {

$ grep -rn --include=*.ts ": GateOrderStore" src services
src/payment.ts:161:    private readonly store: GateOrderStore = new MemoryOrderStore(),
```

Only the two kit implementations exist, and both define `claim`. No consumer declares
its own store type, and none takes a `GateOrderStore` in its own signature. Therefore
`this.store.claim is not a function` **cannot** be reached from any consumer: every
construction site passes either a `SqliteGateStore` or nothing.

## F3. Per-consumer gate construction — the complete table

```
$ grep -rn --include=*.ts "new ExplicitGate(" src services | grep -v '\.test\.ts'
services/cvm-lambda/src/server.ts:118      ? new ExplicitGate(
services/cvm-ppq/src/server.ts:21          ? new ExplicitGate(
services/cvm-nanogpt/src/server.ts:16      ? new ExplicitGate(
services/cvm-2fiat/src/server.ts:95        ? new ExplicitGate(
services/cvm-sms4sats/src/server.ts:93     return new ExplicitGate(processor, new SqliteGateStore(gateDb));
src/evidence/red_before.ts:48              const gate = new ExplicitGate(processor, new MemoryOrderStore());  # evidence harness
```

| consumer | gate store at `main` (`e2a7065`) | durable? | affected by the hardened interface |
| --- | --- | --- | --- |
| `services/cvm-lambda/src/server.ts:118-120` | `new SqliteGateStore(cfg.gateDb)` | yes | none — has `claim`; only gains the terminal-state behaviour |
| `services/cvm-ppq/src/server.ts:21-23` | `new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-ppq/gate.sqlite")` | yes | none |
| `services/cvm-nanogpt/src/server.ts:16-18` | `new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-nanogpt/gate.sqlite")` | yes | none |
| `services/cvm-2fiat/src/server.ts:95` | `new SqliteGateStore(cfg.gateDb)` | yes | none |
| `services/cvm-sms4sats/src/server.ts` | **`new ExplicitGate(processor)` — no store** | **no (in-process Map)** | **this was the defect; fixed on this branch, see F5** |

## F4. No consumer branches on a gate status, so the new terminal states break nothing

```
$ grep -rn --include=*.ts -E '\.status *=== *"(paid|settled|settlement_)' src services | grep -v '\.test\.ts'
src/payment.ts:195:    if (order.status === "settled") {
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
