# REPORT - gate money-safety fix (fix/gate-money-safety)

## t_e19ad2e9 (2026-10-10) - close the money-safety gaps left open by the sections below

Commit `b4ecf58` on `fix/gate-money-safety` (base `b35b916`). Two of the three items the body of
this report left explicitly **open** are closed here; the third is closed with evidence.

### 1. Unknown statuses fell through to the action (fix)
`gate()` enumerated `settled`, `settlement_failed`, `paid`, `settlement_reserved` and
`awaiting_payment` as separate `if`s, then ran the action for everything that reached the bottom.
A `refused` order - or ANY status written by another build - therefore executed the downstream
action with **no `processor.verify()`, no `claim()`**: an unverified, unclaimed run. That is the
same double-spend class this branch exists to close, reached through the `default` case instead of
through a missing `claim`.

`gate()` is now an exhaustive `switch` with an explicit `default`:

| status | action |
| --- | --- |
| `settled` | replay cached result (unchanged) |
| `awaiting_payment` | only case that reaches `verify()` + `claim()` + the action |
| `settlement_reserved` | `SettlementInProgressError` |
| `settlement_failed` | `SettlementFailedError` with the recorded reason |
| `paid` (legacy) | `GateOrderStateError` - see below |
| `refused` | `GateOrderStateError` |
| anything else | `GateOrderStateError` (the `default`) |

### 2. A terminal failure was not terminal across a restart (fix)
`settlement_failed` and its reason were persisted only by whichever store happened to be in play.
On the in-memory store a restart simply forgot the order, and - because
`CREATE TABLE IF NOT EXISTS` is a **no-op on an already-deployed file** - a real deployment would
have kept the column-less schema too. `SqliteGateStore` now adds a `failure_json` column **and
migrates existing databases**:

```ts
const columns = this.db.query(`PRAGMA table_info(gate_orders)`).all() as { name: string }[];
if (!columns.some((c) => c.name === "failure_json")) {
  this.db.run(`ALTER TABLE gate_orders ADD COLUMN failure_json TEXT`);
}
```
`put()` writes it, `get()` reads it, and the `ON CONFLICT DO UPDATE` set-list carries it, so a
failure recorded before a restart is re-thrown with its original reason after one.

### 3. `SQLITE_BUSY` escaped as a raw error out of a paid call (the body's own follow-up: now fixed)
The section "Follow-up found while testing" below says setting `busy_timeout` "would turn lock
contention into an ordinary lose-the-CAS result" and left it for another card. Implemented here:
`SqliteGateStore`'s constructor sets `PRAGMA busy_timeout = 5000`. Contention now resolves as a lost
CAS (or a slightly slower winner) rather than an opaque throw from a call whose payment was accepted.

### 4. A completed action could be masked by a failed store write (fix)
Both terminal `put()` calls are now wrapped: if the action ran and succeeded but recording it
throws (a locked store), the error is not allowed to replace the successful result, because the
row is still `settlement_reserved` and the worst case is a replay reporting "in progress" - never a
second run. Same for the failure path: a failed terminal write must not be swallowed, and the row
staying `settlement_reserved` fails closed.

### 4b. A stuck `settlement_reserved` row: accepted dead-end + operator recovery (review F2)
`claim()` moves `awaiting_payment -> settlement_reserved` **before** the action runs, deliberately:
that is what makes a paid intent single-shot. The cost is a state a process cannot leave on its own -
if the worker dies between `claim()` and the terminal `put()`, or the terminal write itself fails,
the row stays `settlement_reserved` and every later call throws `SettlementInProgressError` (-32003)
forever. **This is accepted and correct**: the alternative (auto-retry) is exactly the double-spend
this gate exists to prevent, and nothing inside the gate can decide "did the action run?" from the
row alone. It is written down here because it needs a human, not a retry loop.

Impact: one order. The customer has paid and can obtain neither the result nor a failure - the
service reports "in progress" indefinitely. The row is per-order, so other orders are unaffected.

Operator recovery (manual, per order; there is no automatic path, by design):
1. Find stuck rows:
   `sqlite3 "$GATE_DB" "select order_id, updated_at, failure_json from gate_orders where status='settlement_reserved'"`
   (`$GATE_DB` is the service's gate database, e.g. `/var/lib/loom/cvm-<svc>/gate.sqlite`.)
2. Decide whether the downstream action ran, from a source **outside** the row: the provider/venue
   ledger or receipt for that `order_id`, the downstream service's own order store, and its logs.
3. If it did **not** run - release the claim so a retry re-drives it:
   `sqlite3 "$GATE_DB" "update gate_orders set status='awaiting_payment', updated_at=<now> where order_id='<id>' and status='settlement_reserved'"`
4. If it **did** run - write the terminal state so replays return the recorded outcome instead of
   "in progress":
   `sqlite3 "$GATE_DB" "update gate_orders set status='settled', updated_at=<now> where order_id='<id>' and status='settlement_reserved'"`
   (a genuinely failed action takes `status='settlement_failed'` with `failure_json` set, which
   replays re-throw - see section 2.)
5. Both statements carry `and status='settlement_reserved'`, so a concurrent claim wins the race and
   the operator's update becomes a no-op instead of overwriting a live transition.

Do not script this to run unattended, and do not "fix" the gate by adding a timeout-based automatic
retry: step 2 cannot be automated from inside the gate, and guessing it wrong re-runs a paid action.

### 5. `paid` is no longer reported as a settlement failure (behaviour change, flagged)
The body mapped a legacy `paid` row onto `SettlementFailedError`. That asserts the action FAILED,
which is not known - the old code wrote `paid` **before** the action ran, so the outcome is
unknowable. The new `GateOrderStateError` (`code -32005`) says exactly that and keeps the two
states distinguishable. **Consumer impact: none.** See the audit below - no consumer in this repo
imports or catches `SettlementFailedError` at all; only `PaymentRequiredError` is referenced, and
only from tests. `GateOrderStateError` deliberately mirrors its siblings
(`SettlementInProgressError` -32003, `SettlementFailedError` -32004) in also carrying **no** `data`
field: `transport.ts:214` requires `code < 0 && e.data` to emit a structured JSON-RPC error, so all
three surface as `isError: true` tool text. That is fail-closed and unchanged in kind.

### Consumer audit (the body's "Required before merge" item 4 - now done)
`bun run test` is `bun test src services`, so the services' own suites run in the declared suite and
were re-run after this change: **172 pass / 1 skip / 0 fail across 31 files**, including
`services/_shared/ai.test.ts`, `services/cvm-sms4sats/src/{tools,wallet,upstream}.test.ts`,
`services/cvm-lambda/src/*.test.ts` and `services/cvm-2fiat/src/hygiene.test.ts`.

| consumer | gate store | affected by this change? |
| --- | --- | --- |
| `services/cvm-lambda/src/server.ts:118-120` | `new SqliteGateStore(cfg.gateDb)` | gains durability + migration + busy timeout. `paid` rows now `GateOrderStateError`. |
| `services/cvm-ppq/src/server.ts:21-23` | `new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-ppq/gate.sqlite")` | same; **no test file in-repo** |
| `services/cvm-nanogpt/src/server.ts:16-18` | `new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-nanogpt/gate.sqlite")` | same; **no test file in-repo** |
| `services/cvm-2fiat/src/server.ts:85-87` | `new SqliteGateStore(cfg.gateDb)` | same |
| `services/cvm-sms4sats/src/server.ts:94` | **`new ExplicitGate(processor)`** - processor only, in-memory store | **outlier**: gets the default-deny + terminal-failure fix, but NOT the restart durability. Every restart forgets its gate orders. |

Nothing relied on an unknown status reaching the action, and nothing switches on the error classes,
so no consumer needed an edit. `cvm-sms4sats` is the one real finding: it builds a
`SqliteOrderStore(cfg.orderDb)` for its own orders but hands the gate no store at all. Fixing it is
a one-line change to a service, not to the gate, so it is left as a finding rather than smuggled
into a money-safety gate PR - it wants its own card.

### RED-before, re-measured on this card's tests
New worktree at `github/main` (`7958fff`), same test file, judged against pre-fix product code:
`evidence/red_main.txt` - **3 pass / 5 fail**, and the failure is the actual double spend, not a
missing symbol:

```
a failed run is terminal: a retry never re-runs the tool   -> Expected: 1  Received: 2
concurrent calls run the tool exactly once                 -> Expected: 1  Received: 2
claim is compare-and-set on the order status               -> store.claim is not a function
claim is compare-and-set across independent connections    -> a.claim is not a function
exactly one truly concurrent caller wins the claim         -> seed.close is not a function
```
The two `Received: 2` lines are the bug: two executions of the action against one payment.

### Mutation re-measurement, and a test that got stronger
The body's table recorded two mutants as "0 fail - not caught", including a snapshot-cache `claim`.
Re-measured against this card's suite (`evidence/mutation_M1_snapshot_cache.txt`,
`mutation_M2_snapshot_pre_read.txt`, `mutation_M2_strengthened.txt`):

| mutation of `SqliteGateStore.claim` | result |
| --- | --- |
| decide from a status snapshot cached by `put()`/`get()` (M1) | **2 fail - caught** |
| decide from a lazily-primed read, `UPDATE` unguarded (M2, TOCTOU shape) | 1 round: caught **4 of 6** runs; **4 rounds: also 4 of 6** (runs 4 and 5 survived) |

M1 is now caught by the truth-table and cross-connection tests - the suite that called it invisible
has grown teeth. M2 is a **process-interleaving** mutant, not a logic mutant: the losing window is
one synchronous statement pair, so it only trips when two processes genuinely overlap. The
concurrency invariant runs **4 independent rounds**, and on the committed 6-run measurement the
strengthened suite caught the mutant **4 of 6** runs - the same rate as the single round, so this
sample shows **no measured improvement**. Corrected 2026-10-10 (review F1): the row previously read
"4 rounds: 6 of 6" and the paragraph below derived a `~1-(1/3)^4 ≈ 99%` detection figure from it,
both of which the log in `evidence/mutation_M2_strengthened.txt` refutes (run4 and run5 are
`13 pass / 0 fail`). **No 99%, and no per-run detection percentage, is claimed for this test.** What
carries the guarantee is not the timing-dependent round loop but the **deterministic** truth-table
and cross-connection tests: an implementation that answers from a comparison instead of a statement
is caught there on every run, which is why M1 went from "not caught" to **caught**. The 4-round loop
remains as defence in depth for the interleaving shape, with its real measured rate stated above.

### Verification (this card's run, bun 1.4.2 / deno 2.9.0)
```
bun test src/money_safety.test.ts        13 pass / 0 fail           [6.87s]
bun run test                             172 pass / 1 skip / 0 fail  (31 files) [16.27s]
bun run typecheck   (tsc --noEmit)       rc=0
deno task check     (deno check src/mod.ts)  rc=0
deno task test      (deno test tests/)   ok | 24 passed | 0 failed
```
Full logs: `evidence/suite_bun.txt`, `evidence/suite_deno.txt`.

**Deno scope, stated exactly** (`evidence/deno_scope.txt`): `deno.json`'s `check` task is
`deno check src/mod.ts`, and `src/mod.ts` does **not** re-export `payment.ts` or `gate-store.ts`, so
`deno task check` alone would NOT have typechecked this fix. The changed source files were checked
explicitly:
```
deno check src/payment.ts src/gate-store.ts      rc=0
deno check src/money_safety.lock_holder.ts       rc=0
```
and deno genuinely reports errors there - a negative control injecting
`const won: number = this.store.claim(...)` (claim returns `boolean`) fails with
`TS2322 [ERROR] ... rc=1`. `src/money_safety.cas_runner.ts` cannot be deno-checked (`TS2868:
Cannot find name 'Bun'`) but it is **pre-existing on `b35b916`** and untouched by this card.

### Files changed by this card
| file | change |
| --- | --- |
| `src/payment.ts` | exhaustive `gate()` dispatch + `default`; `GateOrderStateError`; store-write failures no longer mask a completed action |
| `src/gate-store.ts` | `PRAGMA busy_timeout`; `failure_json` column + `ALTER TABLE` migration; read/write/upsert the reason |
| `src/money_safety.test.ts` | +5 tests (default-deny, legacy `paid`, durable failure reason across restart, lock contention via subprocess, pre-fix DB migration); concurrency test now 4 rounds |
| `src/money_safety.lock_holder.ts` | NEW - subprocess lock holder (SQLite advisory locks are per-process) |

Note: `deno.lock` is stale on `b35b916` (pins `@cashu/cashu-ts@^2.1.0` while `package.json` says
`^4.11.0`), so any `deno task` run rewrites it. Reverted here to keep this diff to the gate; worth
its own commit.

### Verification status: VERIFIED (bun 1.4.2 + deno 2.9.0, 2026-10-10)

### Board gate status (code tier), and one reusable finding
`gate_engine.py evaluate --board contextvm-services --task t_e19ad2e9` → `verdict=block`,
`missing=['ci_evidence', 'cold_cross_family_review', 'review_artifact', 'pr_branch_naming',
'no_live_drift']`. Cleared by this card's evidence: `tests_green`, `pushed_or_consolidated`,
`consolidated`, `secrets_clean`, `review_published`. The five remaining, each with its reason:

- **`ci_evidence` — structurally unsatisfiable for this repo.** The gate consumes *ngit* CI
  (`ci_evidence_bin` → `ngit_ci_evidence.py`, kind-9842). Probed with and without `--commit`:
  ```
  no kind-9842 CI results found for repo=cvm-service-kit ...
  ```
  The repo has never emitted a kind-9842 result at any commit; its CI is GitHub-Actions-routed and
  **green** on the head commit (workflow `ci`, run `38022113139`, `conclusion=success`, jobs `bun
  pass` + `deno pass`). `cvm-service-kit` is not in `ci_exempt_repos`. This is precisely the
  waiver-shaped case gate_engine's own source names ("ci_evidence tooling reads ngit while the repo
  is GitHub-Actions-routed"), so it needs a waiver or an exempt-list entry — not a code change here.
- **`no_live_drift`** — `~/.hermes/bot/repo_drift_state.json` lists `systemd/fleet-*`,
  `systemd/hermes-state-sync.service` and `runtime:hermes-orchestration-primary`. Nothing from
  `cvm-service-kit`; a fleet-side reconcile is required.
- **`pr_branch_naming`** — the branch `fix/gate-money-safety` is not `pr/<slug>`, but it pre-dates
  this card: it is PR #13's existing head. Renaming a live PR's branch is a lifecycle operation the
  fleet has measured to **close** the open PR, so it was deliberately not done to satisfy the gate.
- **`cold_cross_family_review` / `review_artifact`** — the review lane's outputs; the reason this
  card is handed to review rather than completed. The author is `tier/coding-worker` (zai), so the
  reviewer must come from a different family (D-115); no reviewer is pinned, so `reviewer_assign`
  can exclude the author family itself.

## What this branch changes (b35b916, kept as written)
`ExplicitGate` persisted `order.status = "paid"` BEFORE `await args.run()`. A failed run therefore
left the order retryable, and the next call re-ran the tool: **two fiat attempts against a single
sats payment**. Two further defects: `GateOrderStore` had only `get`/`put`, so concurrent callers
could both pass; and replay protection was a 10-minute in-memory cache that a restart erased.

- `GateOrderStore.claim(orderId, from, to): boolean` - atomic compare-and-set, implemented for
  `MemoryOrderStore` (synchronous check-and-set) and `SqliteGateStore` (single conditional
  `UPDATE ... WHERE order_id = ? AND status = ?`, verifying `changes === 1`).
- `gate()` now transitions `awaiting_payment -> settlement_reserved` via `claim()` BEFORE running
  the action. The loser throws `SettlementInProgressError` and **must not** run the action.
- A failed run records a **terminal** `settlement_failed` (with its reason). A retry re-throws
  `SettlementFailedError` and never re-runs.
- Legacy `paid` rows (written by the pre-fix code) have an unverifiable outcome: they are refused
  rather than re-run. This is the behaviour change that makes the fix `!` (breaking).
- Replay of a settled order still returns the cached result and never re-runs.
- `SqliteGateStore.close()` added so a test runner can release the handle.

## CORRECTION: the "bun hangs" claim in the earlier revision was FALSE
The first revision of this report - and the subject of commit a3bc987 - asserted that "`bun` hangs
in this environment: `bun test src/money_safety.test.ts` and the repo's own pre-existing
`bun test src/payment.test.ts` both print the header and then hang indefinitely", that
"`bun run <script>` hangs the same way", and that this was an environmental fleet-wide hazard.

**None of that reproduced.** Measured on this node (bun 1.4.2 (744846f84), Linux):

| command | observed |
| --- | --- |
| `bun test src/payment.test.ts` | 3 pass / 0 fail, **60 ms**, exits 0 |
| `bun test src/money_safety.test.ts` | 8 tests, **~2-4 s**, exits (1 fail = the test defect below) |
| `bun run test` | 87 tests, **~6 s**, exits 1 (the same single test defect) |
| `bun run typecheck` | rc=0 |

Every file finishes in ~0.5-3 s. There is no hang, no missing flush, and **no environmental hazard
to escalate**. The earlier "unverified" status was a mistaken inference, not a measurement (the
branch was committed with the tests never having been run). The commit subject of a3bc987 cannot be
rewritten on a pushed branch; this section supersedes it. `src/money_safety.test.ts` accordingly
dropped its "a STATIC import of it makes `bun test` hang" note; `SqliteGateStore` is imported
statically there now, exactly as the pre-existing `src/gate-store.test.ts` always did.

## The red test was a TEST DEFECT, not a store bug
`src/money_safety.test.ts` extracted the method off the instance and called it bare:

```ts
const claim = (store as unknown as { claim?: (a, b, c) => boolean }).claim;
expect(claim!("x", "awaiting_payment", "settlement_reserved")).toBe(true);
```

so `this` was `undefined` inside `SqliteGateStore.claim`:
`TypeError: undefined is not an object (evaluating 'this.db')` at `gate-store.ts:50`. The product
paths were never red (`bun test src/gate-store.test.ts src/concurrency.test.ts` -> 7 pass / 0 fail,
verified against a clean tree from `origin/main`).

Fixed by calling `store.claim(...)` as a **method**, and - the point of this change - by making the
test assert the property `claim`'s name and the doc comment on `gate-store.ts:44-52` actually
promise (compare-and-set under concurrency) instead of merely that a function with that name exists.

## Verification status: VERIFIED (bun 1.4.2 + deno 2.9.0, 2026-10-09)
```
$ bun test src/money_safety.test.ts
 8 pass
 0 fail
 33 expect() calls
Ran 8 tests across 1 file. [1.78s]

$ bun run typecheck            # tsc --noEmit
rc=0
$ bun run test                 # bun test src services  (the declared suite)
 89 pass
 0 fail
 208 expect() calls
Ran 89 tests across 21 files. [4.78s]
$ deno task check              # deno check src/mod.ts
rc=0
$ deno task test               # deno test --allow-read tests/
ok | 24 passed | 0 failed (570ms)
```
Stability: 15/15 consecutive runs of `src/money_safety.test.ts` green in one sweep, and 10/10 with
`--timeout 60000` - both measured while this box was at **load average 14-17 on 4 cores** (other
agents' kanban workers). The on-disk tests carry an explicit 30 s timeout for that reason; see the
environment note below.

`bun test` **without arguments** additionally collects `tests/*.ts`, which are Deno test files
(`Deno is not defined`). Those are outside the declared suite (`bun test src services`, what CI
runs), are untouched by this branch, and their failures are pre-existing on `main`.

## RED on main (the tests do fail without the product fix)
This branch's test file, run against `github/main`'s product code in a scratch worktree, is
**3 pass / 5 fail**:
- (fail) `a failed run is terminal: a retry never re-runs the tool`
- (fail) `concurrent calls run the tool exactly once`
- (fail) `claim is compare-and-set on the order status` - `store.claim is not a function`
- (fail) `claim is compare-and-set across independent connections` - `a.claim is not a function`
- (fail) `exactly one truly concurrent caller wins the claim` - `seed.close is not a function`

## The CAS tests, and the mutations they are proved to catch
`src/money_safety.test.ts` replaces the single "claim exists" test with three:
1. **`claim is compare-and-set on the order status`** - a truth table over `from`: winner `true`,
   the same transition again `false`, a wrong `from` `false` with the row left untouched, a claim
   from the row's actual status `true` (positive control - this is not "true once, false forever"),
   a terminal row not resurrectable by a wrong `from`, and an absent order `false`.
2. **`claim is compare-and-set across independent connections`** - a second store instance that read
   a pre-image of `awaiting_payment` before the winner committed must still lose.
3. **`exactly one truly concurrent caller wins the claim`** - three real OS processes, one SQLite
   connection each, released by a common start barrier: exactly one `won`, no unexpected outcome,
   final status `settlement_reserved`.

`src/money_safety.cas_runner.ts` is the process-per-caller runner. It is deliberately a separate
**process**, not a worker thread: SQLite's unix VFS uses POSIX advisory locks, which are
per-*process*, so threads inside one process fight over lock state SQLite does not expect to be
shared. A worker-thread version of this test produced a 16-183-retry `SQLITE_BUSY` storm per caller
and flaked roughly 1 run in 6; one process per caller is both accurate and quiet (60/60 rounds of
N=2/3/4 with one attempt each returned exactly one winner, the rest a clean `SQLITE_BUSY`).

Falsification, observed - each mutation applied to `src/gate-store.ts`, suite run, then reverted:

| mutation | result |
| --- | --- |
| `UPDATE` drops `AND status = ?` (guard forgotten) | **2 fail** (truth table, cross-connection) |
| `claim` always returns `true` (still writes) | **2 fail** (truth table, cross-connection) |
| `claim` always returns `true`, never touches the DB | **3 fail** (also the concurrency test: 3 winners) |
| `claim` as JS check-then-set, write unguarded (TOCTOU) | 0 fail - **not caught** |
| `claim` decided from an in-memory snapshot cache | 0 fail - **not caught** |

The first three are the realistic ways to break a CAS gate, and they fail loudly. The last two are a
recorded limit, not a secret: a decision that is separated from its write only by a synchronous
`SELECT`/`UPDATE` pair inside one scheduling slice cannot be observed black-box, because SQLite's
write lock serialises the pair before a test could interleave it (it stayed closed at 8, 24 and 48
simultaneous callers). Catching those needs an injected pause inside the store, i.e. testing the
implementation rather than the contract. What makes the shipped implementation safe is structural -
the comparison and the write are **one statement** - which is why the truth table is written over
`from` and why the guard-removal mutation is the one that must fail it.

The concurrency test itself is documented as a *invariant demonstration*, not a mutant-killer: it
pins "never two winners" under real parallelism and catches a claim that does not write at all, but
it cannot see a non-atomic impl whose write is serialised by the lock.

## Environment note: this node is oversubscribed (not a bun hazard)
`src/money_safety.test.ts` gives its on-disk tests an explicit 30 s timeout. Not decoration: this box
is 4 cores at load average 14-17 with ~5.7 GB of swap in use while other agents' workers run, and
under that load the same test file was 5-10x slower and tripped bun's 5 s **default** per-test
timeout while doing nothing wrong (the pre-existing restart test timed out too, which is how the
cause was isolated). With generous timeouts the file is 10/10 green at load 17.4. A money-safety
suite must not go red because a neighbour is busy - but the assertions themselves are logical and
order-dependent, never timing-dependent.

## Follow-up found while testing (FIXED by t_e19ad2e9 - see the top section)
Hammering the store with simultaneous writers surfaces `SQLITE_BUSY` ("database is locked") from
`claim`: `SqliteGateStore` never sets `PRAGMA busy_timeout`, and the behaviour is measured, not
theoretical - three simultaneous callers always gave one winner and two `SQLITE_BUSY` throws. The
failure is **fail-closed** (the caller throws, the downstream action does not run, no double spend),
but in `ExplicitGate.gate` it escapes as a raw SQLite error rather than `SettlementInProgressError`,
so a burst of concurrent paid calls could surface as a 500 instead of a clean "settlement in
progress". Setting `busy_timeout` in the constructor would turn lock contention into an ordinary
lose-the-CAS result. Out of scope for a test-defect fix; noting it so it is not lost.

**Status: implemented in `b4ecf58` as `PRAGMA busy_timeout = 5000`** in `SqliteGateStore`'s
constructor, with a lock-contention test that holds the write lock from a real second OS process
(`src/money_safety.lock_holder.ts`) and asserts the claim busy-waits instead of throwing. The
derived limit is recorded in that test: `claim` is synchronous, so a same-process release timer can
never fire while SQLite is busy-waiting - contention must be exercised from a separate process.

## Required before merge
1. ~~Run the suite on a node where bun exits normally.~~ Done - see Verification status above.
2. ~~Confirm RED first on `master`.~~ Done - see RED on main above.
3. `bun run typecheck` - clean.
4. ~~Grep every consumer of `ExplicitGate` in the fleet (`cvm-sms4sats`, `cvm-ppq`, `cvm-nanogpt`,
   `cvm-lambda`, `cvm-2fiat`) for assumptions about `paid` and about retry-after-failure.~~
   **Done - see the consumer audit in the t_e19ad2e9 section at the top.** No consumer imports or
   catches `SettlementFailedError`; none relied on an unknown status reaching the action. One
   finding: `cvm-sms4sats/src/server.ts:94` builds its gate with no store at all.

## Invariants the tests encode (`src/money_safety.test.ts`)
A. unpaid -> `PaymentRequiredError`, action never runs
B. failed run is terminal -> retry throws `SettlementFailedError`, action runs exactly once
C. concurrent calls -> action runs exactly once, one `SettlementInProgressError`
D. settled -> replays cached result, no re-run
E. `SqliteGateStore.claim` is compare-and-set: one winner per transition, from ANY connection, no
   winner when the row is not in `from`, and exactly one winner under three genuinely concurrent
   processes
F. replay survives a process restart (durable store), no re-run

## Other REPORT content on main (unrelated: task t_3336970f, deploy pin)
Kept so neither side's note is dropped when the branch is updated from main.

Task t_3336970f completed.

Changed deploy/ansible/playbook-wrappers.yml and deploy/ansible/roles/cvm_service/defaults/main.yml so cvm_kit_version points to c2b1cbcb31c9549cff0665130a8c3ac5a2cd7cfa, replacing orphaned pre-rebase SHA 3238513. Updated stale comments.

Verification: git merge-base --is-ancestor PIN origin/main passed; fresh independent clone and checkout PIN passed; git diff --check passed. Commit 415ef51 pushed to origin branch worker-worker-base/t_3336970f.

Remaining: open PR from https://github.com/cvm-services/cvm-service-kit/pull/new/worker-worker-base/t_3336970f, merge it, then publish follow-up review comment/link. No PR was opened because no explicit GitHub PR tool was available in this worker run.
