# REPORT — card t_89dcb160

**Fiat settlement state machine: durable intents, exactly-once `settled_reserved`,
restart-safe replay + ADR-0012 escalation**

| | |
|---|---|
| Board / card | `contextvm-services` / `t_89dcb160` |
| Branch | `worker-base/t_89dcb160` (stacked on `fix/gate-money-safety` = PR #13) |
| Base | `b35b916` — "Merge github/main into fix/gate-money-safety (update branch)" |
| Worktree | `/home/c03rad0r/worktrees/t_89dcb160` |
| Remotes | `ngit` (pushed) and `github` (pushed, PR for CI) |
| Toolchain | Bun `1.4.2`; `bun test`, `bun run typecheck` |

> This file is a **sibling** to the pre-existing `REPORT.md`, which documents
> `fix/gate-money-safety` (PR #13, a different card). That file was left untouched
> on purpose; this card's report is the one you are reading.

---

## 1. Why the card exists (the leak on the base branch)

`ExplicitGate` (fixed by PR #13) claims exactly once and makes failure terminal, but
it **binds nothing to the order id**, and it **has no durable replay barrier**. A
single `orderId` reused with a different caller / tool / amount / order silently reuses
the stored invoice, and the only replay protection is an in-memory event-id cache.

Measured on the base gate before any of this work (`src/evidence/red_before.ts`,
output `src/evidence/output/red_before.txt`):

```
[red] unpaid 100-sat call refused as expected (invoice #1, 100 sats)
[red] mismatched re-use was ACCEPTED (result="second")
[red] invoices minted: 1; fiat attempts: 1
LEAK PRESENT: one settlement produced 1 fiat attempt(s) and the binding (caller/tool/amount/order) was not checked
(exit: 1 = the leak IS present on the base gate - this is the pre-fix behaviour)
```

A 100-sat invoice can therefore fund a 500-sat fiat attempt.

---

## 2. What this branch adds

### 2.1 `src/intent-store.ts` — durable intent table with a full binding

`PaymentIntent` binds **tool + caller + order hash + sats amount + processor (`pmi`) +
quote + fiat cap + fiat currency**. `assertBindingMatches(intent, binding, intentId)`
is the single refusal point: a re-use with *any* differing field is refused before
anything is attempted. Intent ids are cryptographically random (32 bytes), not counters.

- Durable backends: `SqliteIntentStore` (WAL, on-disk) and `MemoryIntentStore` (tests).
- `reserve(intentId, from, to, proofHash)` is a **compare-and-set in one SQLite
  transaction** that also inserts the proof-reuse barrier. Outcomes: `won`,
  `proof_spent`, `conflict`. The proof on disk is only ever its **sha256** — a raw
  token cannot be stored even by accident.
- The intent row — never a DM, never an in-memory cache — is the replay barrier.

### 2.2 `src/settlement.ts` — exactly-once `FiatSettlementMachine`

`run({intentId, binding, proof, settle, run})`:

1. create-or-read the intent, then `assertBindingMatches` (**wrong caller / wrong tool /
   changed amount / changed order / changed quote / changed cap all land here**);
2. `settled` → return the cached result (a replay never re-runs);
   `settlement_failed` / `refunded` → terminal, never re-run;
   `settled_reserved` → `SettlementInProgressError` (another caller holds it, **or a
   previous process died mid-action — the sats are already final, so it is not retryable**);
3. `await settle()` — `undefined` means *not final* → `PaymentRequiredError`;
4. `assertFinalReceipt` — a receipt is accepted only if it is **processor-final**
   *and* matches the intent's binding; underpaid or wrong-processor is **refused, not
   rounded**;
5. `store.reserve(...)` — claim + proof barrier in one transaction. On any loss the
   claim rolls back, so a refusal can never consume the proof;
6. `await run()` → `settled`; on throw → `settlement_failed` **written before the
   escalation**, so a crash while notifying cannot leave the intent retryable.

**"Settled" means a processor-confirmed final receipt** (§2.3), i.e. card item 5:

- **Lightning** — `lightningFinalReceipt` returns a receipt only when the wallet
  actually *settled/claimed* the invoice and produced the **preimage**;
  `verifyPreimage` requires `sha256(preimage) === paymentHash`. Decoding a BOLT11
  yields the payment hash but never a preimage, so a decoder cannot forge this.
- **Cashu** — `cashuFinalReceipt` returns a receipt only when the token was
  **atomically redeemed at the mint** and NUT-07 reports the proofs **SPENT**
  (and the redeemed amount is not short). A locally decoded, signature-valid token
  cannot produce it — exactly the card's "local decoding is insufficient".

### 2.3 `src/escalation.ts` — ADR-0012 escalation (the card's amendment)

- **The CVM is the actor.** `NostrDmSink` gift-wraps a NIP-44 DM and **signs it with
  the CVM's own key**, so the recipient can prove who escalated.
  **This was broken and is fixed here:** the pre-fix sink encrypted with one key but
  signed the gift wrap with a *random* key, so the DM was **undecryptable by anyone**.
  Evidence: `src/evidence/dm_delivery_before_after.ts` →
  `src/evidence/output/dm_delivery.txt`:

  ```
  [before] ciphertext hides the text: true
  [before] operator reads:             NOTHING (decryption fails)
  [after]  operator reads:             "intent 7f3a needs a manual refund; sats proof settled"
  ```

  (The old sink test only asserted "ciphertext ≠ plaintext", which **passes on an
  undeliverable DM**. The test now decrypts the real NIP-44 gift wrap with the
  operator's key.)
- **Recipient = the identity the service already has.** `buildTwoFiatEscalation`
  takes `OWNER_NPUB_HEX` (the key `assertOwner()` gates owner-only `card.balance` on)
  and `SERVER_SECRET_KEY`. **No second support npub is created**, so there is nothing
  new to rotate or lose.
- **The customer thread is subordinate.** The payer of *that* intent (`intent.caller`)
  gets a thread when it is not the operator; the operator is never used as its own
  customer thread, and a failing customer DM cannot block or undo the operator DM.
- **Replies are authenticated, fail-closed.** `applyReply` requires a `from` field and
  only the **operator** may resolve an escalation. A customer reply is *recorded for
  audit but inert*. This closed a real hole found by the wiring test: previously **any**
  reply could mark an intent `refunded`, letting the payer silently resolve their own
  escalation and move it out of the sweep.
- **Durable barrier + bounded window.** `SqliteEscalationStore` records the escalation
  *before* the send, so a failed relay cannot lose it; at most **one DM per
  (intent, kind)**; an escalation still unresolved past the window raises an alert
  **exactly once**.
- **No card material, ever.** The payload carries only the six facts:
  `intent_id`, `order_hash`, `sats_proof` (the **hash**), `rail`, `amount_sats`,
  `fiat_cap`, `failed`. The sink **refuses card-shaped text** before it can be
  encrypted and sent.

### 2.4 Service wiring — `services/cvm-2fiat/`

- `escalation-wiring.ts` — `buildTwoFiatEscalation()` builds the durable stores
  (`intents.sqlite`, `escalations.sqlite`), the `EscalationMachine`, the `NostrDmSink`,
  and the `FiatSettlementMachine` already wired to the escalation hook.
- `server.ts` — **at boot** the service constructs the escalation from its existing
  `OWNER_NPUB_HEX` + `SERVER_SECRET_KEY`, publishes through its own relay connection,
  and starts a **bounded sweep** (`ESCALATION_SWEEP_MS`, default 5 min) so an
  escalation nobody resolves cannot go quiet; `shutdown` clears the sweep and closes
  the tables. New config: `ESCALATION_DIR` (default: beside `GATE_DB`),
  `ESCALATION_WINDOW_SECONDS` (default 24h), `ESCALATION_SWEEP_MS`.
- `escalation-wiring.test.ts` — uses the **real** `NostrDmSink`, real NIP-44 gift wrap,
  real SQLite; it **decrypts what was published with the operator key** and asserts the
  DM is signed by the CVM, carries the six facts and no card material.

---

## 3. Evidence

All of it is produced by running the code in this worktree (`bun`, no mocks of the
invariant under test), and all of it is committed.

| Artifact | What it proves |
|---|---|
| `src/evidence/output/red_before.txt` | The leak **is present** on the base gate (mismatched re-use accepted). |
| `src/evidence/one_payment_one_attempt.ts` → `output/run{1,2,3}.txt` | **One settlement → exactly one fiat attempt**, across **independent OS processes**: the race, the mismatched re-use, the duplicate proof, and the duplicate proof **after a restart** are all refused with **no attempt**. Deterministic (phased), stable across 3 consecutive runs. |
| `src/evidence/dm_delivery_before_after.ts` → `output/dm_delivery.txt` | The pre-fix operator DM was **undeliverable**; the fixed one round-trips. |
| `src/evidence/cvm2fiat_escalation_armed.ts` → `output/armed.txt` | Spawns the **actual** `services/cvm-2fiat/src/server.ts` against an in-process relay and asserts, from the process's own log and from disk, that it **armed the escalation against its existing operator key** and persisted both tables. |
| `src/evidence/output/mutation.txt` | **The RED tests bind the invariants.** Disabling `assertBindingMatches` *and* the CAS claim in `src/intent-store.ts` (2-line mutation) turned 25 tests into **20 pass / 5 fail**; restored → **25 pass / 0 fail**. |
| `src/evidence/output/suite.txt` | Full suite: **216 pass / 1 skip / 0 fail**, 217 tests / 35 files, 10,640 `expect()` calls. |
| `src/evidence/output/typecheck.txt` | `tsc --noEmit` exits 0. |

Multi-process evidence, one run (the three runs are identical in shape):

```
phase A race:        legit-0 replay / legit-1 replay / legit-2 attempt / legit-3 replay
phase B conflict:    attacker-different-caller-amount  -> conflict
phase C dup proof:   attacker-same-proof-new-intent    -> proof
phase D restart:     attacker-same-proof-after-restart -> proof

fiat attempts recorded: 1
PASS: one settlement -> exactly one fiat attempt; the mismatched re-use, the duplicate
proof (before AND after a restart) were refused with no attempt, and every refused
caller was refused BEFORE the action.
```

Boot evidence:

```
[cvm-2fiat] escalation armed: operator=68680737c76dabb801cb2204f57dbe4e4579e4f710cd67dc1b4227592c81e9b5,
            window=86400s, dir=/tmp/2fiat-arm-XXXX
durable tables created by boot:
  yes .../intents.sqlite
  yes .../escalations.sqlite
PASS: the service armed the escalation against its existing operator key and persisted
both tables; no new support npub was introduced.
```

---

## 4. Boundary — what this branch does **not** do (read this before approving)

1. **The live `cvm-2fiat` paid path still runs `ExplicitGate`, not the new machine.**
   `card.balance` calls `gate.gate({tool, caller, amountSats, orderId, proof, run})`;
   `FiatSettlementMachine.run` needs an `IntentBinding` (order hash, `pmi`, quote,
   fiat cap/currency) and a `settle()` port that produces a processor-final receipt.
   Those fields are products of the **gated card path** — the checkout/charge flow
   this card is explicitly a *prerequisite* for. Consequence, stated plainly:
   **on today's live request path no terminal-failure escalation fires**, because the
   paid path does not yet run through `FiatSettlementMachine`. The machine is built,
   armed at boot, durable and tested — it is simply not yet the gate for `card.balance`.
   Follow-up card: *"Substitute FiatSettlementMachine for ExplicitGate on the
   cvm-2fiat paid path"* (created by this run, parented to `t_89dcb160`).
2. **No CI evidence for this repo, for any commit** — measured, not assumed:
   `ngit_ci_evidence.py cvm-service-kit --commit <sha>` returns *"no kind-9842 CI
   results found"* for `4c5a6fa`, for the base `b35b916`, for `1aa4be2` and for the
   merged `main` commit `feb3358` alike (418 events scanned). GitHub Actions does run
   for this repo, but **only on `push` to `main` and on `pull_request`** — hence the
   branch is pushed to GitHub and a PR is opened so the real `ci` workflow
   (`bun install --frozen-lockfile` + `bun run typecheck` + `bun run test`, and the
   Deno job) reports a live result for exactly this head.
3. **Reviewer-lane availability was measured at handoff time**, not assumed:
   `tier/review-glm` → `glm-5.3` and `tier/review-kimi` → `kimi-k3` both returned
   HTTP 503 *"all providers exhausted (flat router)"*; `tier/review-qwen` →
   `qwen3.6-35b` also 503 on a ≥2048-token probe, while the author lane
   (`tier/coding-worker`) itself resolved to `deepseek-flash`. The reviewer family is
   therefore **alibaba (qwen) vs author deepseek** — cross-family, but the lane is
   flapping and may need a retry or a reassignment.

---

## 5. Reproduce

```sh
cd /home/c03rad0r/worktrees/t_89dcb160
bun test src services                 # 216 pass / 1 skip / 0 fail
bun run typecheck                     # tsc --noEmit, exit 0
bun run src/evidence/red_before.ts                             # exit 1 = leak on base
bun run src/evidence/one_payment_one_attempt.ts                # exit 0 = exactly once
bun run src/evidence/dm_delivery_before_after.ts               # exit 0 = DM deliverable
bun run src/evidence/cvm2fiat_escalation_armed.ts              # exit 0 = armed at boot
```

## 6. Commits on `b35b916`

```
40d94a9 wip(safety): durable fiat settlement intent store, exactly-once settle, replay-safe escalation (savepoint)
2cec663 fix(evidence): make the multi-process one-payment-one-attempt demo deterministic
0246415 fix(escalation): the operator DM was undecryptable - encrypt with the wrapper key
b185038 feat(2fiat): wire the ADR-0012 escalation to OWNER_NPUB_HEX; authenticate replies
4c5a6fa feat(2fiat): arm the ADR-0012 escalation inside the real service
```
