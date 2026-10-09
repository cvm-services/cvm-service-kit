# REPORT - gate money-safety fix (fix/gate-money-safety)

## What this branch changes
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

## Follow-up found while testing (not fixed here - needs its own card)
Hammering the store with simultaneous writers surfaces `SQLITE_BUSY` ("database is locked") from
`claim`: `SqliteGateStore` never sets `PRAGMA busy_timeout`, and the behaviour is measured, not
theoretical - three simultaneous callers always gave one winner and two `SQLITE_BUSY` throws. The
failure is **fail-closed** (the caller throws, the downstream action does not run, no double spend),
but in `ExplicitGate.gate` it escapes as a raw SQLite error rather than `SettlementInProgressError`,
so a burst of concurrent paid calls could surface as a 500 instead of a clean "settlement in
progress". Setting `busy_timeout` in the constructor would turn lock contention into an ordinary
lose-the-CAS result. Out of scope for a test-defect fix; noting it so it is not lost.

## Required before merge
1. ~~Run the suite on a node where bun exits normally.~~ Done - see Verification status above.
2. ~~Confirm RED first on `master`.~~ Done - see RED on main above.
3. `bun run typecheck` - clean.
4. Grep every consumer of `ExplicitGate` in the fleet (`cvm-sms4sats`, `cvm-ppq`, `cvm-nanogpt`,
   `cvm-lambda`, `cvm-2fiat`) for assumptions about `paid` and about retry-after-failure. **Still
   open** - the `!` in the fix commit is real: `GateOrderStore` gained a required method and
   `GateOrderStatus` gained members.

## Invariants the tests encode (`src/money_safety.test.ts`)
A. unpaid -> `PaymentRequiredError`, action never runs
B. failed run is terminal -> retry throws `SettlementFailedError`, action runs exactly once
C. concurrent calls -> action runs exactly once, one `SettlementInProgressError`
D. settled -> replays cached result, no re-run
E. `SqliteGateStore.claim` is compare-and-set: one winner per transition, from ANY connection, no
   winner when the row is not in `from`, and exactly one winner under three genuinely concurrent
   processes
F. replay survives a process restart (durable store), no re-run
