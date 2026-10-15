reviewer_model: deepseek/deepseek-v4-flash
elapsed=46.0s usage={'prompt_tokens': 6875, 'total_tokens': 10959, 'completion_tokens': 4084, 'estimated_cost': 0.0026777799999999994, 'prompt_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': None}, 'completion_tokens_details': {'reasoning_tokens': 0}}
======================================================================
# Cold Review — money path (HALF 1)

I was given the diff for `src/payment.ts`, `src/gate-store.ts`, and `services/cvm-sms4sats/src/server.ts`, plus harvested test/typecheck evidence. I do **not** have the body of `ExplicitGate.gate()` itself — only the store it calls. Several of the questions you asked (does the gate call `claim` before `run`? does it re-verify before the CAS? does it check `compensated`?) are answered *inside* `gate()`, which is **not in this diff**. I flag every place where that gap prevents me from confirming a claim.

---

## FINDING 1 — BLOCKING: the CAS is not a check-and-set on the *payment evidence*; the claim can bind a different/absent proof

**EVIDENCE** (`gate-store.ts`, `claim`):
```
`UPDATE gate_orders SET status = ?, updated_at = ?, rev = rev + 1,
                       proof_hash = COALESCE(?, proof_hash)
 WHERE order_id = ? AND status = ? AND compensated = 0`
```
The CAS predicate is `(order_id, status, compensated)`. `proof_hash` is written with `COALESCE(?, proof_hash)` — i.e. **if the caller passes `null`/`undefined`, the existing `proof_hash` is preserved and the transition still succeeds.** The `WHERE` clause does not test the incoming proof against the stored one.

**WHY IT MATTERS.** Your question "does the claim bind the payment evidence, or can a different/absent proof replay a result?" cannot be answered "yes" from this store. The store will happily move `awaiting_payment → settlement_reserved` for a caller that supplies *no* proof hash, and will happily move it for a caller that supplies a *different* proof hash than the one already bound (the COALESCE keeps the old one, so the row ends up bound to proof A while the caller presented proof B). Whether that is exploitable depends entirely on whether `gate()` (a) verifies the proof *before* calling `claim`, and (b) passes the verified proof hash into `claim`. **Neither is visible in this diff.** The comment in `payment.ts` says the cached result is only handed back "if the caller can present the same evidence" — but that check is in `gate()`, not here, and the store does not enforce it.

**RECOMMENDATION.** Either (a) make the claim CAS include the evidence, e.g. `WHERE order_id=? AND status=? AND compensated=0 AND (proof_hash IS NULL OR proof_hash = ?)`, so a claim cannot bind a row already bound to a different digest; or (b) show me `gate()` and demonstrate that it verifies the proof and passes the *verified* hash into `claim` on every path. Until one of those is in evidence, this is the single most important money-safety question and it is **unresolved**.

---

## FINDING 2 — BLOCKING: `put()`'s "refuse to record settled" guard is a *post-hoc* throw, not a prevention — the action already ran

**EVIDENCE** (`gate-store.ts`, `put`):
```
WHERE gate_orders.compensated = 0 OR excluded.status <> 'settled'
...
if (order.status === "settled" && Number(res.changes ?? 0) !== 1) {
  throw new Error(`order ${order.orderId} was compensated by an operator; refusing to record it as settled`);
}
```
The comment says "the action DID run, and the operator must reconcile by hand." That is honest, but it means the guard does **not** prevent the double-spend — it only prevents the *record* of it. The sequence is: operator compensates (refunds) → a caller with a still-valid proof reaches `gate()` → `gate()` runs the action → `put()` throws. The customer got the refund **and** the service.

**WHY IT MATTERS.** This is exactly the "can the action ever run twice / can an unpaid call reach the action" class. The `compensated` flag is checked in `claim` (`AND compensated = 0`), so *if* `gate()` calls `claim` before `run`, the compensated row would be refused at claim time and the action would not run. But the `put()` guard existing at all implies the author believes a settled write can arrive on a compensated row — i.e. that the claim-time check is not sufficient or not always on the path. **I cannot see `gate()` to tell which.** If `gate()` always claims first, the `put()` guard is dead code and harmless; if it does not, this is a live double-spend.

**RECOMMENDATION.** Show the `gate()` control flow. If `claim` is always the gate before `run`, delete the misleading "the action DID run" comment or downgrade it. If not, the compensated check must be *before* `run`, not in `put`.

---

## FINDING 3 — BLOCKING: `putResolution` is two statements with no transaction; the window is fail-*open* for the audit, and the comment's fail-safe claim is only half true

**EVIDENCE** (`gate-store.ts`, `putResolution`):
```
const claimed = this.db.run(`UPDATE gate_orders SET compensated = 1, rev = rev + 1
   WHERE order_id = ? AND status = ? AND rev = ?`, ...);
if (Number(claimed.changes ?? 0) !== 1) return false;
this.db.run(`INSERT INTO gate_recovery (...) VALUES (...)`, ...);
return true;
```
The comment claims: "if the process dies between them the row is left `compensated` with a missing note — fail-SAFE (releases stay blocked)."

**WHY IT MATTERS.** The *release* direction is indeed fail-safe (compensated blocks release). But the *audit* direction is fail-open: a crash between the two statements leaves a compensated order with **no recovery record**, and `listResolutions()` will not show it. An operator reading the log sees no compensation for an order that is in fact compensated and un-releasable. The comment acknowledges this ("the operator sees `compensated` with no note and appends one") but there is no code path that surfaces "compensated with no note" — `listResolutions()` only reads `gate_recovery`. So the recovery is manual and undocumented in the tooling.

**RECOMMENDATION.** Wrap both statements in a `BEGIN IMMEDIATE … COMMIT` (SQLite supports it; the guarded UPDATE is still the mutual exclusion, the transaction just makes the pair atomic). Or add a `listCompensatedWithoutNote()` query so the operator can find the gap. The current shape is *safe* for money but *lossy* for audit, and the comment overstates the safety.

---

## FINDING 4 — MINOR: `IS_NEW_GENERATION` interpolates `TERMINAL_STATUS_SQL`, and the empty-list fallback `NULL` produces a predicate that is *always false*, silently disabling the new-generation reset

**EVIDENCE** (`gate-store.ts`):
```
const TERMINAL_STATUS_SQL = TERMINAL_STATUSES.length
  ? TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ")
  : "NULL";
const IS_NEW_GENERATION = `excluded.status = 'awaiting_payment' AND gate_orders.status IN (${TERMINAL_STATUS_SQL})`;
```
When `TERMINAL_STATUSES` is empty, `IS_NEW_GENERATION` becomes `... AND gate_orders.status IN (NULL)`. In SQLite, `x IN (NULL)` is `NULL` (not true), so the whole `CASE WHEN` falls to the `ELSE` branch — meaning **a reused orderId would inherit the previous generation's identity, proof, and compensation**. The comment says the empty list "must degrade to 'matches nothing', not break every `put`" — but "matches nothing" here means the *new-generation reset never fires*, which is the exact bug H3/H4 were fixing.

**WHY IT MATTERS.** `TERMINAL_STATUSES` is a constant in `payment.ts` (not shown in this diff), so in practice it is non-empty. But the fallback is a foot-gun: if anyone ever empties that list, the store silently reverts to the pre-fix behavior instead of failing loudly. The `NULL` choice trades a syntax error for a silent correctness regression.

**RECOMMENDATION.** Use `IN (SELECT NULL WHERE 0)` or `1=0` for the empty case, so the predicate is explicitly false and the reset is *disabled by intent* rather than by SQL three-valued-logic accident. Better: assert `TERMINAL_STATUSES.length > 0` at module load.

---

## FINDING 5 — MINOR: `releaseIfUnchanged` doc says "same `updated_at`" but the code CASes on `rev`

**EVIDENCE** (`gate-store.ts`):
```
/**
 * ... `settlement_reserved` AND the same `updated_at`.
 * ... requiring it makes a stale read lose ...
 */
releaseIfUnchanged(orderId: string, expectedRev: number): boolean {
  const res = this.db.run(
    `UPDATE gate_orders SET status = 'awaiting_payment', updated_at = ?, rev = rev + 1
     WHERE order_id = ? AND status = 'settlement_reserved' AND rev = ? AND compensated = 0`,
    [Date.now(), orderId, expectedRev],
  );
```
The doc comment (carried from round 4) says the CAS is on `updated_at`; the code CASes on `rev`. The `rev` approach is *better* (the comment in `payment.ts` explains why `updated_at` collides within a millisecond), but the stale doc now describes a different mechanism than the code.

**WHY IT MATTERS.** Not a money bug — the code is correct and the `rev` CAS is the right one. But a future maintainer reading the doc will believe `updated_at` is load-bearing and may "optimize" `rev` away. Doc/code drift on a money path is how regressions get reintroduced.

**RECOMMENDATION.** Update the doc to say `rev`, and note that `updated_at` is only the lease-age hint.

---

## FINDING 6 — MINOR: `put()`'s `updated_at=MAX(excluded.updated_at, gate_orders.updated_at)` can mask a genuine clock regression but also hides a real ordering signal

**EVIDENCE** (`gate-store.ts`, `put`):
```
updated_at=MAX(excluded.updated_at, gate_orders.updated_at)
```
**WHY IT MATTERS.** This is defensible (the comment says the lease-age hint must not run backwards). But `list()` orders by `updated_at ASC`, and `releaseIfUnchanged`/`claim` write `Date.now()`. If the system clock steps backwards, `MAX` keeps the old (larger) value, so `list()` ordering and any operator logic keyed on `updated_at` will not reflect the true write order. `rev` is the real version; `updated_at` is now a monotonic-but-not-truthful timestamp. That is fine as long as nothing treats `updated_at` as "when did this actually happen."

**RECOMMENDATION.** Confirm no operator tooling uses `updated_at` as a wall-clock fact (e.g. "compensated at"). If it does, it should use `gate_recovery.at` (which is *not* MAX-clamped) instead.

---

## FINDING 7 — MINOR: migration of `gate_recovery` rebuilds the table but does not preserve `seq` ordering guarantees across the rename

**EVIDENCE** (`gate-store.ts`, `ensureSchema`):
```
if (!cols.some((c) => c.name === "seq")) {
  this.db.run(`ALTER TABLE gate_recovery RENAME TO gate_recovery_legacy`);
  this.db.run(`CREATE TABLE gate_recovery (seq INTEGER PRIMARY KEY AUTOINCREMENT, ...)`);
  this.db.run(`INSERT INTO gate_recovery (order_id, outcome, note, at)
               SELECT order_id, outcome, note, at FROM gate_recovery_legacy ORDER BY at ASC`);
  this.db.run(`DROP TABLE gate_recovery_legacy`);
}
```
**WHY IT MATTERS.** The legacy table had `order_id` as PRIMARY KEY (per the comment), so it held at most one row per order — the migration cannot lose history that was never there. The `ORDER BY at ASC` assigns new `seq` values in `at` order, which is the best available reconstruction. This is correct. But: the migration runs **outside a transaction**. If the process dies after `RENAME` and before `DROP`, the next startup sees a `gate_recovery` with `seq` (the new one) and a leftover `gate_recovery_legacy` — the `if (!cols.some(seq))` guard is now false, so the legacy table is orphaned and never cleaned up. Not a money bug, but a schema-hygiene hazard on an already-deployed table.

**RECOMMENDATION.** Wrap the four statements in a transaction. Also add a `DROP TABLE IF EXISTS gate_recovery_legacy` at the top of `ensureSchema` to clean up a half-migrated state.

---

## FINDING 8 — MINOR: `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT 0` on an already-deployed table is safe in SQLite, but the `proof_hash` column is added *without* a default and the code treats `NULL` as "unbound"

**EVIDENCE** (`gate-store.ts`):
```
if (!columns.some((c) => c.name === "proof_hash")) {
  this.db.run(`ALTER TABLE gate_orders ADD COLUMN proof_hash TEXT`);
}
...
if (!columns.some((c) => c.name === "rev")) {
  this.db.run(`ALTER TABLE gate_orders ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`);
}
```
**WHY IT MATTERS.** SQLite allows `ADD COLUMN ... NOT NULL DEFAULT 0` on a populated table (the default backfills), so `rev` and `compensated` are safe. `proof_hash TEXT` (nullable) is also safe. **However**: pre-existing rows get `rev = 0` and `compensated = 0`. A pre-existing row that was already `settled` before this migration now has `rev = 0`. If any operator tooling holds a `rev` from before the migration (it can't — the column didn't exist), fine. But a pre-existing `settlement_reserved` row with `rev = 0` is now releasable by `releaseIfUnchanged(orderId, 0)` — which is correct behavior, just worth noting that `rev = 0` is a valid expected value, not a sentinel.

**RECOMMENDATION.** None required; this is a note. The migration is safe. Confirm no code treats `rev === 0` as "unset."

---

## FINDING 9 — MINOR: `list()` is not on the `GateOrderStore` interface, so the gate cannot use it — but `putResolution`/`releaseIfUnchanged`/`listResolutions` are also not on the interface

**EVIDENCE** (`gate-store.ts`):
```
/**
 * Deliberately NOT part of the `GateOrderStore` interface: the gate itself only
 * ever needs point reads ...
 */
list(statuses?: GateOrderStatus | GateOrderStatus[]): GateOrder[] { ... }
```
**WHY IT MATTERS.** The comment justifies `list` being off-interface. But `releaseIfUnchanged`, `putResolution`, and `listResolutions` are *also* off-interface (they are not in the `GateOrderStore` interface shown in `payment.ts`). That means the operator/recovery tooling must downcast to `SqliteGateStore` to use them. If the gate ever needs to check `compensated` (Finding 2), it cannot do so through the interface — it must either read the `GateOrder.compensated` field (which *is* on the interface, good) or downcast. The `compensated` field being on `GateOrder` is the right call; just confirm `gate()` reads it.

**RECOMMENDATION.** Confirm `gate()` reads `order.compensated` from the `GateOrder` returned by `get()`/`claim()` and refuses to run if true. If it does, Finding 2 is mitigated at claim time.

---

## Summary of what I could and could not verify

| Question | Verdict from this diff |
|---|---|
| Action twice against one payment? | **Cannot confirm.** Depends on `gate()` calling `claim` before `run`. The store's `claim` CAS is atomic and `compensated`-guarded, but `put()`'s guard implies a settled write can arrive post-compensation. |
| Unpaid call reaches action? | **Cannot confirm.** Verification is in `gate()`, not shown. |
| CAS genuinely atomic? | **Yes** for `claim`, `releaseIfUnchanged`, `putResolution`'s UPDATE — each is a single conditional `UPDATE`. `putResolution`'s *pair* is not atomic (Finding 3). |
| Status handling exhaustive? | **Cannot confirm.** `TERMINAL_STATUSES` is imported, not shown. The `NULL` fallback (Finding 4) is a silent-regression hazard. |
| Store write error fail-open/closed? | `put()` on a compensated row **throws** (fail-closed for the record, but the action already ran — Finding 2). `putResolution` crash window is fail-safe for release, fail-open for audit (Finding 3). |
| Claim binds evidence? | **No** — `COALESCE(?, proof_hash)` preserves the old hash and the CAS does not test the incoming proof (Finding 1). |
| SQL/migration hazard? | `ADD COLUMN NOT NULL DEFAULT 0` is safe in SQLite. `gate_recovery` rebuild is not transactional (Finding 7). |

The author's evidence (20 pass, 0 unexplained mutants, typecheck clean) is real but **does not cover the `gate()` control flow** — every mutant listed is in `gate-store.ts` or the recovery suite. No mutant tests "gate runs action without claiming" or "gate runs action on a compensated row." That is the gap.

`reviewer_model: deepseek/deepseek-v4-flash`

VERDICT: REQUEST_CHANGES
