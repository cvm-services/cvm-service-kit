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
- **The binding is on the proof STRING the processor was handed, not on the payment it
  represents** (finding F2 of the round-1 review of this fix — accepted, tested). A retry that
  no longer holds that exact string is refused with `-32006`: a wallet that pruned the redeemed
  token, or one that re-serialises it (Cashu v3↔v4 encoding of the same proofs hashes
  differently). The ordinary retry — the same string, the case a lost response produces — is
  pinned by test and still returns the cached result. Closing the re-serialised case properly
  needs a processor-supplied stable `evidenceKey` (the token's secret set, not its serialisation)
  via a `PaymentProcessor` interface change, because only the processor knows what identity it
  actually redeemed. Recorded as the follow-up rather than guessed at in the gate.
- **A second payer for the same invoice is refused, permanently** (finding F3 of the round-1
  review, conceded in round 3 — accepted residual risk). `ExplicitGate` calls `verify()` to learn
  whether a call was paid and only then serialises settlement on the store's atomic claim, so two
  concurrent first-calls both reach `verify()`. If a processor accepts a *second, distinct* valid
  proof for an invoice it has already been paid for — ordinary bearer behaviour, not a processor
  bug: `ProofProcessor` cannot see the concurrent redemption — the claim winner binds its own
  digest and the loser is stuck: `SettlementInProgressError` now, `-32006` on every retry with its
  own (already redeemed, hence unusable elsewhere) proof. Pre-change, the loser recovered the
  cached result via the `orderId` replay that this fix removes. **Recovery:** the proof and the
  order row are both on hand (`gate_orders.proof_hash` plus the caller's token), so an operator
  can settle the second payment out of band. Candidate durable fixes (a first-class follow-up,
  not this card): reject a proof for an invoice that is already paid inside the processor, or
  bind an evidence **set** and record the losing caller's digest so any payer of that invoice can
  collect the result. The hazard is documented on `PaymentProcessor.verify` so it cannot be
  missed by the next processor author.
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

Round 1 — reviewer: chutes `moonshotai/Kimi-K3-TEE` (per the card's instruction: the local
router's `kimi-k3`/`glm-5.3` are served by DeepSeek and satisfy no cross-family gate), reviewed
head `f8cbe15`, verdict **REQUEST_CHANGES, 7 findings**:
`~/reports/reviews/contextvm-services-t_5b30bdec-Kimi-K3-TEE-review.md`.

## 8. Round 2 — adjudication of the 7 findings

Every finding was checked against the code before it was answered. Four produced changes; the
rest are answered with the evidence that makes them moot, or recorded as an accepted tradeoff
with the reason it is accepted.

| # | severity | disposition |
|---|---|---|
| F1 | major | **REAL, FIXED** — `MemoryOrderStore.put` was an unconditional set |
| F2 | major | **ACCEPTED + DOCUMENTED** — the false positive is inherent to binding on the presented proof |
| F3 | conditional major | **PREMISE CONFIRMED, NOT REACHABLE** — `verify()` does precede `claim()` (L371 < L384), but the stranding branch needs two distinct proofs accepted for one invoice |
| F4 | minor | **MITIGATED AT RUNTIME** — the settle-path round-trip check, not the interface |
| F5 | minor | **REAL, FIXED** — `presentedProof()` normalisation |
| F6 | nit | **FIXED** — one uniform refusal reason |
| F7 | nit | **FIXED** — constant-time digest compare |

**F1 (real, fixed).** The reviewer is right and the asymmetry was real: `SqliteGateStore.put`
COALESCEd a recorded digest, `MemoryOrderStore.put` did `this.m.set(o.orderId, o)`. A `put()`
built from a stale pre-claim object therefore erased the binding on the memory store only —
silently re-opening exactly the hole this card closes, on the store the tests blessed. Fixed
by merging a recorded digest in `put()` (only a `claim()`, or a write that carries evidence,
sets one). Mutation M1 (revert `put()` to the unconditional set) → **2 tests fail**, so the
new coverage is not decorative.

**F2 (accepted, now documented).** Correctly identified as the designed tradeoff, and the
reviewer's concrete trigger is exactly right: the binding is a digest of the *string the
processor was handed*, so a retry that no longer holds that string — a wallet that pruned the
redeemed token, or re-serialised it (Cashu v3↔v4) — is refused with `-32006`. This is the
direct cost of the fix: the only alternative that accepts it is trusting `orderId` alone,
which is the hole. What the round-2 change adds is that the tradeoff is now **explicit and
tested** rather than incidental:

- test *"a retry with the same proof after a lost response returns the cached result"* pins
  the ordinary retry (the case the reviewer asked to be sure still works): same result, action
  not re-run, one payment;
- test *"characterisation: a re-serialised proof is NOT the same evidence (accepted boundary)"*
  pins the refused case, so the boundary cannot move silently;
- the proper closure — a processor-supplied stable `evidenceKey` (the token's secret set, not
  its serialisation) — is recorded in §5 as the follow-up, because it is an interface change
  for every `PaymentProcessor`, not a gate-side guess.

**F3 (premise confirmed, branch not reachable).** The reviewer flagged it as *conditional* on
the ordering, and COULD_NOT_VERIFY'd the ordering because the hunk boundary hid it. Answer from
the source: `await this.processor.verify(order.invoice, proof)` is at `src/payment.ts:371`, the
`this.store.claim(...)` is at `:384` — **verify precedes claim**, so the reviewer's premise
holds. The stranding branch still needs a processor that returns `true` for two *distinct*
proofs on one invoice: that is a double payment accepted by the pmi, i.e. a processor defect
outside this diff. The reachable race — two concurrent first-calls paying with the *same* proof
— is now pinned deterministically (a rendezvous processor parks both callers inside `verify()`,
so the race is real rather than timing-dependent): one call settles, exactly one action runs,
the loser gets `SettlementInProgressError`, and the loser's own proof then collects the cached
result. Not stranded.

**F4 (mitigated at runtime).** Making `proofHash` a required parameter was tried and reverted:
TypeScript compares parameters bivariantly, so a required extra parameter does **not** force an
existing `implements GateOrderStore` to pass a digest — it would only look like it did. The
mitigation is therefore runtime and stronger: after the settle write, the gate re-reads the row
and fails closed with `SettlementBindingNotPersistedError` if the recorded digest did not land,
so a store that drops the field on `claim` *and* `put` cannot hand back an unbound settled
order — it throws. Mutation M2 (remove that round-trip check) → **1 test fails**.

**F5 (real, fixed).** `presentedProof()` now normalises the client value once in `gate()` and
the normalised value is what is used for `verify()`, for the binding and for the replay check;
a non-string or empty value is not evidence anywhere. The F5 test uses a **coercing** processor
(one that accepts any non-`undefined` proof — a `redeem(String(proof))` redeemer), because a
processor that already rejects unknown strings cannot distinguish the mutant; the first version
of this test used `ProofProcessor` and was therefore vacuous against M3, which the mutation run
caught. Mutation M3 (coerce instead of reject) → **1 test fails**.

**F6 (fixed).** All three mismatch shapes now throw one reason,
`settlement_evidence_mismatch`. The previous reasons distinguished "settled without a client
proof" from "a proof is required", which told a caller who presented nothing whether a guessed
`orderId` had been settled with a client proof — a settlement-method oracle — in exchange for
no caller-side benefit (the caller knows what it presented). Mutation M4 (re-differentiate the
reasons) → **1 test fails**.

**F7 (fixed).** Digests are compared with `digestEquals()` (`timingSafeEqual` over the encoded
digests, length-checked first). Defence in depth only: the digest is not a usable secret, as
the reviewer notes.

**Considered and rejected: the `-32006` collision with `refusals.ts` `rail_unavailable`.**
Raising it would be defensible in isolation, but this kit's convention is that the stable
`reason` string discriminates and the JSON-RPC code is a coarse bucket — `refusals.ts` maps
three distinct reasons (`unknown_tool`, `unsupported_language`, `amount_too_large`) to a single
`-32602`, and `-32005`/`-32003`/`-32007` are each reused across modules on `main`. Changing the
code here would be inconsistent with that convention and would not add a discriminating bit.
Recorded rather than silently ignored.

## 9. Round 2 — verification (re-executed)

| item | result |
|---|---|
| `bun test src/replay_binding.test.ts` | **23 pass / 0 fail** (75 `expect()` calls) |
| `bun run test` | **244 pass / 1 skip / 0 fail** (245 tests / 36 files) |
| `bun run typecheck` | `tsc --noEmit` exit **0** |
| `deno task check` | exit **0** |
| `deno task test` | **24 passed / 0 failed** |
| Mutation M1 (`put` unconditional) | 2 fail — caught |
| Mutation M2 (round-trip check removed) | 1 fail — caught |
| Mutation M3 (`presentedProof` coerces) | 1 fail — caught |
| Mutation M4 (re-differentiated reasons) | 1 fail — caught |
| source restored byte-identical after mutation | yes |

`evidence/replay_proof_binding.mutation_round2.txt` is the raw mutation transcript. Round 2 was
committed and pushed to **both** remotes as `f59412f` (github + ngit/`origin`, read back with
`git ls-remote`), on top of the round-1 commit `f8cbe15`.

## 10. Round 3 — the re-review of round 2 (`2829a37`)

Round 2's review (`~/reports/reviews/contextvm-services-t_5b30bdec-Kimi-K3-TEE-review-r2.md`)
also returned **REQUEST_CHANGES**: 3 findings, 2 of them real defects in what round 2 shipped.
All are fixed or conceded below. **One correction to §8: the F3 "not reachable" argument was
wrong** and is withdrawn — see R2-1.

**R2-1 (major) — the F3 dismissal is withdrawn and F3 is now recorded as an accepted residual
risk.** The reviewer's refutation is correct and I accept it: `verify()` accepting two *distinct*
valid tokens for one invoice is not a processor defect, it is ordinary bearer-instrument
behaviour. The suite's own `ProofProcessor` ("valid and unspent → true") has no way to see the
other concurrent redemption, so the trace is constructible with the repo's own shapes:

> caller1 `gate(o-X, token-A)` and caller2 `gate(o-X, token-B)` arrive concurrently → both
> `verify()` calls return true (two real payments) → caller1 wins the claim and binds
> `H(token-A)` → caller2 gets `SettlementInProgressError` → every later retry with `token-B`
> hits `assertReplayedEvidence` → `-32006`, permanently, and `token-B` is spent so it cannot
> fund a fresh order either. Pre-change, caller2 recovered via the `orderId` replay that this
> change removes.

The round-2 rendezvous test only covers the *same-proof* race (which recovered even on base), so
the reviewer is also right that it is a regression guard, not evidence for a dismissal. What
round 2 should have said — and what §5 now records — is: F3 is an **accepted residual risk**, of
the same family as F2, with a recovery note, not a bug that cannot happen. Two candidate durable
fixes are recorded for the follow-up (a per-invoice "already paid" rejection inside the
processor, or binding an evidence *set* and recording a losing caller's digest) — both are
interface/state changes this card does not own. The hazard is now documented on the interface
itself (`PaymentProcessor.verify` JSDoc), so a processor author cannot miss it.

**R2-2 (minor, real) — the settle-time backfill was an uncaught mutant.** Verified, and it was
worse than the reviewer could see: with the bundled stores the backfill never fires (the claim
already wrote the digest), and with `LossyStore` the F4 round-trip check throws either way, so
deleting the line left the suite green. Round 2's "every guard is mutation-pinned" claim was
therefore overstated. Fixed by adding the one store shape the backfill exists for: a
`LegacyClaimStore` whose `claim` has the pre-binding three-arg shape but whose `put`/`get`
round-trip the whole `GateOrder`. That test asserts the order settles **bound**, the payer's own
proof collects the result, and `token-B`/no-proof are refused. Mutation **M7** (delete the
backfill) → **1 fail**.

**R2-3 (minor, real, conditional) — the merge inherited a stale binding across orderId
reuse.** The consequence the reviewer describes is real: a write that takes a *terminal* row
back to `awaiting_payment` re-uses the orderId for a new order, and inheriting the old digest
would settle the new order bound to the previous payer's digest — refusing the new payer and
letting the old proof holder collect the new result. Fixed in **both** bundled stores: a write
that moves a terminal row (`settled`/`settlement_failed`/`refused`/`paid`) back to
`awaiting_payment` drops the digest instead of merging it (`startsNewGeneration` in
`payment.ts`, a `CASE` in the sqlite `ON CONFLICT` upsert). New test covers both stores
end-to-end: generation 2 settles with its own (absent) evidence, its own payer collects it, and
generation 1's proof is refused. Mutations **M5** (memory branch removed) and **M6** (sqlite
`CASE` reverted to plain `COALESCE`) → **1 fail each**.

**Nits.** (a) `SettlementEvidenceMismatchError`'s message no longer duplicates the reason
(`super(reason)`, matching `SettlementInProgressError`'s shape). (b) The comment above the F4
check now says explicitly that withholding the result there is a *deliberate* exception to "do
not mask a completed action". (c) Agreed and recorded: F7's `digestEquals` is behaviourally
identical to `===`, so no mutation can pin it — the defence-in-depth item must not be counted as
a mutation-pinned guard.

The round-2 review's "attacks that did not land" are also worth recording, because they are
independent confirmations: F2's disposition was judged adequate, the F4 bivariance argument was
confirmed correct, the F1 merge was traced not to regress legitimate updates, F6 was confirmed
to lose no recovery information, and the F1/F4/F5/F6 tests were each traced against `f8cbe15`
and judged genuinely non-vacuous (including the F5 coercing-processor rewrite).

## 11. Round 3 — verification (re-executed)

| item | result |
|---|---|
| `bun test src/replay_binding.test.ts` | **25 pass / 0 fail** (92 `expect()` calls) |
| `bun run test` | **246 pass / 1 skip / 0 fail** (247 tests / 36 files) |
| `bun run typecheck` | `tsc --noEmit` exit **0** |
| `deno task check` / `deno task test` | exit **0** / **24 passed, 0 failed** |
| mutations M1–M7 | all caught (M1 → 2 fail; M2–M7 → 1 fail each) |
| source restored byte-identical after mutation | yes |

Raw transcript: `evidence/replay_proof_binding.mutation_round3.txt` (supersedes the round-2
transcript; M1–M4 are the same mutants, M5–M7 are the three the round-2 review found uncovered).


