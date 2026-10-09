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

## Verification status: NOT VERIFIED - read this before merging
I could **not** run the tests in the environment this was written in. `bun` hangs in this
environment: `bun test src/money_safety.test.ts` **and the repo's own pre-existing
`bun test src/payment.test.ts`** both print the header and then hang indefinitely without running a
single test. `bun run <script>` hangs the same way. Redirecting stdout to a file yields nothing
because bun never flushes when it hangs. A trivial file importing only `bun:test` + `payment.ts`
did run its test and pass (`1 pass`), so the harness itself is not fundamentally broken - but every
shipping-relevant file hangs, so this is **environmental, not a property of this branch**.

Therefore: the branch is pushed for review, **not merged**. The fix must be run on a healthy node.

## Required before merge
1. Run `bun test src/money_safety.test.ts src/payment.test.ts src/gate-store.test.ts` on a node
   where bun exits normally. All must pass.
2. Confirm RED first on `master`: `src/money_safety.test.ts` asserts `runs === 1` after a failed
   run, which fails on `master` (it re-runs, so `runs === 2`).
3. `bun run typecheck` (`tsc --noEmit`) - the `GateOrderStatus` union gained members and
   `GateOrderStore` gained a required method, so **any other implementer of `GateOrderStore` must
   implement `claim()`**, and exhaustive `switch` statements over the status may need updating.
4. Grep every consumer of `ExplicitGate` in the fleet (`cvm-sms4sats`, `cvm-ppq`, `cvm-nanogpt`,
   `cvm-lambda`, `cvm-2fiat`) for assumptions about `paid` and about retry-after-failure.

## Invariants the tests encode (`src/money_safety.test.ts`)
A. unpaid -> `PaymentRequiredError`, action never runs
B. failed run is terminal -> retry throws `SettlementFailedError`, action runs exactly once
C. concurrent calls -> action runs exactly once, one `SettlementInProgressError`
D. settled -> replays cached result, no re-run
E. `SqliteGateStore.claim` is compare-and-set (second claim returns false)
F. replay survives a process restart (durable store), no re-run

## Environment note (worth its own card)
`bun test` / `bun run` hanging indefinitely, including on pre-existing test files, is a fleet-wide
hazard: it silently makes "run the tests" impossible while looking like a test failure.
