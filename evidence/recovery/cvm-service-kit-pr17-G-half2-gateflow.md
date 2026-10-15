reviewer_model: deepseek/deepseek-v4-flash
elapsed=44.6s usage={'prompt_tokens': 10226, 'total_tokens': 13808, 'completion_tokens': 3582, 'estimated_cost': 0.0029360799999999998, 'prompt_tokens_details': {'cached_tokens': 0, 'cache_write_tokens': None}, 'completion_tokens_details': {'reasoning_tokens': 0}}
======================================================================
# Adjudication — money path, with `gate()` and recovery now in evidence

I now have the two bodies I was missing. I will go finding by finding, then answer your eight questions with quotes, then verdict.

---

## Finding 1 (BLOCKING) — "claim can bind a different/absent proof"

**RESOLVED.** The store's `COALESCE(?, proof_hash)` is not the whole story; `gate()` decides what is passed and *when*.

Order of operations in `gate()`:

```
const paid = await this.processor.verify(order.invoice, proof);
if (!paid) { throw new PaymentRequiredError(...); }
const evidence = proofDigest(proof);
const won = this.store.claim(order.orderId, "awaiting_payment", "settlement_reserved", evidence);
if (!won) throw new SettlementInProgressError(order.orderId);
```

So `claim` is called **only after** `verify` returned true, and it is passed `evidence = proofDigest(proof)` — the digest of the *normalised, verified* proof, not the raw client string. The `COALESCE` in the store is therefore not reachable with a "different proof than the one that paid": the only proof that reaches `claim` is one `verify` accepted for *this* invoice.

The residual concern I raised — "the CAS does not test the incoming proof against the stored one" — is real but **not exploitable on this path**, because a row that is already `settlement_reserved`/`settled` never reaches `claim` (the switch denies it), and a row at `awaiting_payment` has no prior `proof_hash` to conflict with. The `COALESCE` is defensive, not load-bearing. **Downgraded from BLOCKING to a note**: the store's `claim` is not self-defending, but `gate()` is the only caller and it defends. If a second caller of `claim` is ever added, this becomes live again.

---

## Finding 2 (BLOCKING) — "`put()`'s compensated guard is post-hoc; action already ran"

**RESOLVED.** `gate()` checks `compensated` at claim time, before `run`:

```
const won = this.store.claim(
  order.orderId,
  "awaiting_payment",
  "settlement_reserved",
  evidence,
);
if (!won) throw new SettlementInProgressError(order.orderId);
```

and the store's `claim` CAS carries `AND compensated = 0` (per my own Finding 1 evidence). So a compensated order **cannot win the claim**, and `run()` is never reached. The `put()` guard is therefore a *second* line of defence for the narrow race where a compensation lands *between* a successful `claim` and the `put(settled)` — in that window the action has already run, and `put()` correctly refuses to record it as settled. That is the honest reading of the comment "the action DID run, and the operator must reconcile by hand": it is not claiming to prevent the double-spend, it is preventing the *record* of a settled order on a compensated row. **Downgraded from BLOCKING to correct-as-designed.**

One thing I want to be explicit about, because it is the only money-relevant residue: in that narrow race the customer *can* get both the refund and the service. The window is `claim` → `run` → `put`, and a compensation recorded inside it is not seen by the already-won claim. This is inherent to "compensation is an operator action against a row the gate already owns" and is not fixable without a lease the gate itself honours — which the recovery module deliberately refuses to add. I accept it as a documented, bounded residual, not a defect.

---

## Finding 3 (BLOCKING) — "`putResolution` is two statements, no transaction"

**STILL STANDS, downgraded to MINOR.** Nothing in `gate()` or the recovery module changes this. The recovery module's own comment confirms the shape:

> "`putResolution` now also advances `rev`, so the CAS loses as `raced`."

The pair is still `UPDATE gate_orders SET compensated=1, rev=rev+1 ...` then `INSERT INTO gate_recovery ...`, with no `BEGIN IMMEDIATE`. My original analysis holds: fail-safe for *release* (compensated blocks it), fail-open for *audit* (a crash between the two leaves a compensated row with no `gate_recovery` row, and `listResolutions()` reads only `gate_recovery`). The recovery module does not add a `listCompensatedWithoutNote()` surface, so the gap is still invisible to tooling. **Not money-unsafe; still a real audit hole.** I keep it as MINOR, not blocking.

---

## Finding 4 (MINOR) — `IS_NEW_GENERATION` empty-list `NULL` fallback

**STILL STANDS as written, but I now consider it non-actionable.** `TERMINAL_STATUSES` is a module constant in `payment.ts`; nothing in `gate()` or the recovery module can empty it at runtime. The `NULL` fallback is a foot-gun for a future editor, not a live bug. I withdraw the "silent correctness regression" framing — it is a latent hazard, not a present one. Keep the recommendation (use `1=0` or assert non-empty), drop the severity.

---

## Finding 5 (MINOR) — `releaseIfUnchanged` doc says `updated_at`, code CASes on `rev`

**STILL STANDS.** The recovery module's `releaseReservation` calls `store.releaseIfUnchanged(orderId, order.rev ?? 0)` and its own comment is now correct:

> "Version-predicated CAS on the monotonic `rev`: the row must still be the exact revision inspected above."

So the *caller* documents `rev` correctly; the *store method's* doc comment is the stale one. Doc/code drift on a money path, unchanged. MINOR.

---

## Finding 6 (MINOR) — `updated_at=MAX(...)` masks clock regression

**STILL STANDS, and the recovery module makes it slightly more relevant.** `classify()` computes `ageMs = now - order.updatedAt` and `releaseReservation` gates on `ageMs <= leaseMs`. Because `put()` clamps `updated_at` to `MAX(excluded, existing)`, a backwards clock step makes the row look *younger* than it is, which makes `releaseReservation` **refuse** (lease_active) rather than release. That is the fail-closed direction, so the clamp is safe for money. But `findStuckOrders` reports `ageMs` to the operator as "how long the order has been in this state," and that number can be wrong after a clock step. MINOR, unchanged, and now with a concrete consumer (`StuckOrder.ageMs`) that should be read as a hint, not a fact.

---

## Finding 7 (MINOR) — `gate_recovery` migration not transactional

**STILL STANDS.** Nothing in the recovery module touches `ensureSchema`. The four-statement rebuild (`RENAME` / `CREATE` / `INSERT ... SELECT` / `DROP`) is still outside a transaction, and a crash after `RENAME` orphans `gate_recovery_legacy` because the `if (!cols.some(seq))` guard is then false. MINOR, unchanged.

---

## Finding 8 (MINOR) — `proof_hash` nullable, `rev`/`compensated` defaulted

**RESOLVED as a non-issue, and now positively confirmed.** `gate()` treats `proofHash === undefined` as "unbound" and the replay path handles it explicitly:

```
if (done.proofHash === undefined && evidence !== undefined) done.proofHash = evidence;
```

and `assertReplayedEvidence` compares `digestEquals(presented, order.proofHash)`, which is false for `undefined` vs a real digest. So a legacy row with `proof_hash = NULL` is *not* replayable by a proof-bearing caller. The migration is safe. No action.

---

## Finding 9 (MINOR) — `list`/`releaseIfUnchanged`/`putResolution` off-interface

**RESOLVED.** `gate()` reads `order.compensated` only indirectly — it does not read the field at all; it relies on `claim`'s `AND compensated = 0`. That is sufficient (see Finding 2). The recovery module downcasts to `SqliteGateStore` by design, which is fine for operator tooling. No action.

---

## Your eight explicit questions

**1. Does `gate()` VERIFY before claiming? Quote the order.**

Yes. Exact order:

```
const paid = await this.processor.verify(order.invoice, proof);
if (!paid) { throw new PaymentRequiredError(...); }
const evidence = proofDigest(proof);
const won = this.store.claim(order.orderId, "awaiting_payment", "settlement_reserved", evidence);
if (!won) throw new SettlementInProgressError(order.orderId);
try { const result = await args.run(); ... }
```

`verify` → `claim` → `run`. Verification is strictly before the claim, and the claim is strictly before the action.

**2. Does `gate()` CLAIM before running? Can the action run twice against one payment?**

Yes, `claim` is before `run` (quote above). The action cannot run twice against one payment on this path: the second caller finds the row at `settlement_reserved` (or `settled`) and the switch throws `SettlementInProgressError` / returns the cached result. The only way two `run()`s happen is if `claim` returns true twice for the same `(orderId, status)`, which the store's single conditional `UPDATE ... WHERE status = 'awaiting_payment' AND compensated = 0` prevents. **No double-run.**

**3. Does `gate()` re-read or check `compensated` before running?**

It does not read `order.compensated` directly. It relies on `claim`'s CAS predicate `AND compensated = 0`. A compensated order therefore cannot win the claim, and `run()` is not reached. **A compensated order cannot run** (modulo the narrow claim→run→put race in Finding 2, which is a refund-and-service window, not a double-run).

**4. Does `gate()` pass the VERIFIED proof hash into claim?**

Yes: `const evidence = proofDigest(proof);` then `this.store.claim(..., evidence)`. `proof` is the normalised client proof that `verify` just accepted for this invoice. The digest of the verified proof is what is bound. Finding 1 resolved.

**5. Does `gate()` treat an unrecognised/terminal status by falling through to `run()`, or deny?**

Deny. The switch is exhaustive with an explicit `default`:

```
switch (order.status) {
  case "awaiting_payment": break;
  case "settlement_reserved": throw new SettlementInProgressError(...);
  case "settlement_failed": throw new SettlementFailedError(...);
  case "paid": throw new GateOrderStateError(..., "legacy row written before the action ran: settlement outcome unknown");
  case "refused": throw new GateOrderStateError(..., "order is refused; the action must not run");
  default: throw new GateOrderStateError(..., "unrecognised order status; refusing to run");
}
```

Only `awaiting_payment` reaches the code below the switch. Every other status throws. This is the fix for the fall-through I could not previously adjudicate, and it is correct.

**6. Is `gate()`'s store-write error handling fail-open or fail-closed at each point?**

- **claim:** fail-closed. `if (!won) throw new SettlementInProgressError(...)`. A lost CAS never runs the action.
- **put settled:** fail-closed for the *record*, with a deliberate exception. The inner `try { ... this.store.put(done); } catch { persisted = false; }` swallows a store error and returns the result — but only when the store *rejected* the write. When the store *accepted* the write and dropped the digest, the F4 check throws:
  ```
  if (persisted && evidence !== undefined && this.store.get(order.orderId)?.proofHash !== evidence) {
    throw new SettlementBindingNotPersistedError(order.orderId);
  }
  ```
  So a settled row that would be replayable by `orderId` alone is withheld. Correct.
- **put failed:** fail-closed. The `catch` around the terminal write swallows the store error and re-throws the *original* error (`throw err`), leaving the row at `settlement_reserved`, which the next retry reports as `SettlementInProgressError`. Never re-runs.

**7. Can an operator release a reservation a live caller still holds, or release a compensated order?**

- **Live caller:** `releaseReservation` refuses while the lease is live (`if (!Number.isFinite(ageMs) || ageMs <= leaseMs) { if (!opts.force) return { released: false, refusal: "lease_active", ... } }`), and `--force` is an explicit operator override. The CAS is `store.releaseIfUnchanged(orderId, order.rev ?? 0)`, which is version-predicated on the monotonic `rev`, so a stale operator read cannot cancel a live re-claim even within one millisecond. Correct.
- **Compensated order:** refused twice — once by the early check `if (order.compensated) return { released: false, refusal: "compensated", order };` and again inside the CAS, because `putResolution` advances `rev` and the store's `releaseIfUnchanged` carries `AND compensated = 0`. A compensation landing between the check and the CAS makes the CAS lose as `raced`. Correct.

**8. Migration/schema hazards from the new columns on an already-deployed table?**

`ADD COLUMN ... NOT NULL DEFAULT 0` for `rev`/`compensated` is safe in SQLite (backfills). `proof_hash TEXT` nullable is safe and treated as "unbound" by `gate()` (Finding 8). The one real hazard is the non-transactional `gate_recovery` rebuild (Finding 7), which is pre-existing and unrelated to the new columns. No new hazard from the columns themselves.

---

## What I could not check

- I still do not have `TERMINAL_STATUSES` or the `GateOrderStore` interface body; my Finding 4 and Finding 9 conclusions rest on the comments and on `gate()`'s usage, not on the constant's definition.
- I have not seen `processor.verify` for the pmi/Lightning path, so I cannot independently confirm that a no-proof invoice-polling settlement is genuinely un-replayable by a proof-bearing caller beyond what `assertReplayedEvidence` shows. The gate's logic is correct *given* `verify` behaves as documented.
- The author's mutation evidence covers `gate-store.ts` and the recovery suite. It still does not include a mutant for "gate runs action without claiming" or "gate runs action on a compensated row" — but the code now shows those paths are guarded, so the absence of a mutant is a test-coverage gap, not an unresolved correctness question.

---

## FINAL VERDICT on head e7a39d6

The two blocking findings I could not adjudicate last pass are **resolved by the code now in evidence**: `gate()` verifies before claiming, claims before running, denies every non-`awaiting_payment` status including unrecognised ones, binds the verified proof digest, and fails closed at every store-write point. The recovery module's release path is correctly double-guarded against live callers and compensated orders. The remaining findings are MINOR: a non-transactional `putResolution` pair (audit hole, not money), a non-transactional migration, a stale doc comment, a `MAX(updated_at)` hint that can mislead an operator, and a latent empty-list foot-gun. None of these is a money-safety defect on this head.

I am approving. The residual refund-and-service window in the claim→run→put race is inherent to the design and is correctly documented rather than papered over.

reviewer_model: deepseek/deepseek-v4-flash

VERDICT: APPROVED
