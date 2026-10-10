# REPORT — card t_5b30bdec

**cvm-service-kit: a settled replay returns the cached result without re-binding the
presented payment proof to the order**

| | |
|---|---|
| Board / card | `contextvm-services` / `t_5b30bdec` |
| Origin | cross-family review of `t_e19ad2e9`, finding **F4** (`moonshotai/Kimi-K3-TEE`, artifact `~/reports/reviews/contextvm-services-t_e19ad2e9-Kimi-K3-TEE-review-r2.md:22`) |
| Branch | `worker-base/t_5b30bdec-replay-proof-binding` |
| Base | `e2a7065` (`github/main`, "Merge pull request #15") |
| Worktree | `/home/c03rad0r/worktrees/t_5b30bdec` |
| Commits | `3c65009` (fix + tests + evidence), plus the evidence/report commit for this file |
| Toolchain | Bun `1.4.2`; `bun test`, `bun run typecheck` |

> This file is a **sibling** to the repo's `REPORT.md` (which documents
> `fix/gate-money-safety` = PR #13) and to `REPORT-t_89dcb160.md` (the fiat settlement
> state machine). Neither was touched by this card.

---

## 1. The finding

`ExplicitGate.gate` (`src/payment.ts`) has a settled-replay branch:

```ts
if (order.status === "settled") {
  // Replay: return the cached result, never re-run the tool.
  return order.result as T;
}
```

`order` is resolved from `orderId`, which is **client-supplied** (`order_id` is the
CEP-8 idempotency key). The branch returns the cached result without looking at
`args.proof` at all, so the *only* thing standing between a caller and somebody
else's paid result was knowledge of an order id. Nothing re-established a
server-side fact about who paid.

## 2. Reproduce (not refute) — F4 CONFIRMED

`evidence/replay_proof_binding.red.ts` drives a CEP-8-shaped processor (the order
settles only when a valid, unspent proof is presented — same shape as
`src/cashu.ts`) and **prints what the gate returns**. It asserts nothing, so the
same script is valid on both sides of the change.

Run against `e2a7065` in a **detached worktree** (`git worktree add --detach … e2a7065`):

```
scenario 1: order o-1 settled with proof token-A
  first call (token-A): RETURNED "paid-result"
  replay with a DIFFERENT proof (token-B)          -> RETURNED "paid-result"
  replay with NO proof at all                      -> RETURNED "paid-result"
  replay with a VALID proof that paid ANOTHER order (token-C) -> RETURNED "paid-result"
scenario 2: replay of o-2 with token-C (valid, but paid o-3)    -> RETURNED "paid-result"
scenario 3: replay of a no-proof order WITH a proof attached    -> RETURNED "paid-result"
```

So the finding is **real, not a code-reading artifact**: a different proof, no proof,
and a valid proof that paid a *different* order all collected the cached success.
Transcript: `evidence/replay_proof_binding.red.rerun.txt` (reproduced by the
resuming run) and `evidence/replay_proof_binding.red.txt` (authoring run, identical).

## 3. The fix

The digest of the proof that settled the order is recorded and a replay must present
matching evidence.

- `GateOrder.proofHash` (sha256 hex) mirrors the fiat intent store's
  `PaymentIntent.proofHash` rule: **only the digest is stored, never the bearer
  token** — a stolen gate database is not replayable against the mint.
- The digest is written **in the same atomic claim** that reserves settlement:
  `GateOrderStore.claim(orderId, from, to, proofHash?)` →
  `UPDATE gate_orders SET status=?, updated_at=?, proof_hash=COALESCE(?, proof_hash)
  WHERE order_id=? AND status=?`. An order can never be claimed without the evidence
  that paid for it, not even across a crash.
- `SqliteGateStore` adds the `proof_hash` column **plus an `ALTER TABLE` migration**
  (the same `CREATE TABLE IF NOT EXISTS` trap `failure_json` had: the `CREATE` is a
  no-op on a deployed file), and `put()` uses `COALESCE(excluded.proof_hash,
  gate_orders.proof_hash)` so a later write without evidence cannot erase a recorded
  binding.
- The settled branch calls `assertReplayedEvidence(order, args.proof)` **before**
  returning the cached result; a mismatch throws
  `SettlementEvidenceMismatchError` (**-32006**), which deliberately carries **no
  invoice** in `data` — the order is already paid, and re-presenting its invoice would
  invite a second payment for work already done.

Contract enforced:

| order settled by | replay with same proof | replay with a different/no proof |
|---|---|---|
| client proof (CEP-8 Cashu) | cached result (idempotent) | `SettlementEvidenceMismatchError` |
| no client proof (invoice-polling pmi, or a legacy row) | cached result (documented idempotency) | `SettlementEvidenceMismatchError` (a proof that demonstrably did not pay this order) |

## 4. Scope decision (and its rationale)

The no-proof idempotency row above is a deliberate boundary, not an oversight:

- **Why a no-proof replay of a proof-settled order must fail**: a proof is the
  identifer of the payer. If it were not required, the *only* handle on the order
  would be the client-supplied `orderId` — the original hole, merely narrowed.
- **Why a no-proof replay of a no-proof order must keep working**: an
  invoice-polling pmi (Lightning bolt11) settles without the client ever handing the
  server a bearer token, and the pre-existing contract (`docs/cvm-lambda/PLAN.md:101`
  — idempotency key = order id; `services/cvm-lambda/deploy/ansible/README.md:94` — "a
  replay returns the cached result") promises the cached result. There is no
  client-held evidence to bind, so refusing here would strand a result the customer
  already paid for. Legacy rows settled before this change are in the same position
  and keep the same semantics.
- **Why a proof attached to a no-proof order must fail**: that proof demonstrably did
  not pay this order (the order was settled by polling, not by redeeming it), so
  honouring it would be exactly the unauthorised-success class the card is about.

## 5. Residual / honest gaps

- **`orderId` is still the only handle for a poll-settled order.** A caller who learns
  such an order id still gets its cached result. Binding that would require the
  client to hold a secret from the start (e.g. an order-bound nonce or the invoice's
  preimage), which is a wire-protocol change for the CEP-8 consumers, not a kit fix.
  Recorded here rather than silently widening this card.
- **Out-of-repo `ExplicitGate` consumers were not audited.** `services/cvm-ppq` and
  `services/cvm-nanogpt` construct the gate in this repo, but any consumer *outside*
  this repo that replays an order while presenting different payment evidence will now
  receive `-32006` instead of a cached result. That is the intended fail-closed
  behaviour, but it is a behaviour change on the wire and needs the same treatment as
  the in-repo consumers.
- **`SqliteGateStore` still has no reaper** for a row stuck at `settlement_reserved`
  (finding F2 of the same review) — untouched by this card.
- **The refusal is keyed on the digest, not on a verified re-redemption.** That is
  deliberate: the token was already redeemed at settle time, so re-redeeming it would
  fail (double-spend) and could never prove anything.

## 6. Verification

All items below were **re-executed by the resuming run** after the authoring run
crashed; `evidence/independent_verification.md` records the commands.

| item | result |
|---|---|
| RED on `e2a7065` (detached worktree) | F4 reproduced — every replay returns the cached result |
| GREEN on this branch | mismatched replays refused; same-proof replay still cached |
| Mutation (`assertReplayedEvidence` removed) | **8 pass / 6 fail** — the guard is load-bearing; source restored byte-identical |
| `bun run test` | **235 pass / 1 skip / 0 fail** (236 tests / 36 files; was 216/1/0 on `e2a7065`) |
| `bun run typecheck` | `tsc --noEmit` exit **0** |

New tests: `src/replay_binding.test.ts` (14) — A different proof refused; B no proof
(and empty string) refused; C a valid proof that paid another order refused;
C2 the same token cannot fund a second order; D same proof still replays (non-vacuous
control); refusal carries no invoice; E/F the invoice-polling and legacy contracts;
F2 the binding survives a store restart; F3 the binding is written atomically and is
never erased by a later transition or a losing claim; G the unpaid path is unchanged.

## 7. Cross-family review

See the section appended below by the review run (reviewer: chutes
`moonshotai/Kimi-K3-TEE`, per the card's instruction — the local router's
`kimi-k3`/`glm-5.3` are served by DeepSeek and satisfy no cross-family gate).
