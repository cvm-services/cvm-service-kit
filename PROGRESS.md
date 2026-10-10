# PROGRESS

## t_e19ad2e9 — ExplicitGate money-safety gaps (2026-10-10)
- finding: gate() enumerated statuses as separate ifs; `refused`/unknown fell through to run() with
  no verify() and no claim() -> same double-spend class as the missing-CAS bug | status: FIXED
  (exhaustive switch + default -> GateOrderStateError -32005) | files: src/payment.ts
- finding: terminal settlement failure + reason were not durable; CREATE TABLE IF NOT EXISTS is a
  no-op on a deployed file so the column would never appear | status: FIXED (`failure_json` +
  ALTER TABLE migration, busy_timeout=5000) | files: src/gate-store.ts
- finding: a failing terminal store write could mask a completed action | status: FIXED (both
  terminal puts wrapped, fail closed) | files: src/payment.ts
- finding: consumer audit — 4 services pass a SqliteGateStore; cvm-sms4sats:94 passes NO store, so
  it keeps in-memory gate memory across restarts | status: REPORTED, not fixed (service-level, needs
  own card) | files: services/cvm-sms4sats/src/server.ts
- finding: deno.lock stale on b35b916 (`@cashu/cashu-ts@^2.1.0` vs package.json `^4.11.0`); any
  deno task rewrites it | status: REPORTED, reverted to keep diff focused
- red-before: github/main 7958fff -> 3 pass / 5 fail, incl. two `Received: 2` (action ran twice)
  | evidence/red_main.txt
- mutation: snapshot-cache claim -> 2 fail (caught); TOCTOU claim -> 4/6 with 1 round, 6/6 with 4
  rounds (test strengthened) | evidence/mutation_M1_snapshot_cache.txt, mutation_M2_strengthened.txt
- green: bun test src/money_safety.test.ts 13/13; bun run test 172 pass/1 skip/0 fail (31 files);
  bun run typecheck rc=0; deno task check rc=0; deno task test 24/24 | evidence/suite_bun.txt,
  suite_deno.txt
- deno scope: `deno task check` only checks src/mod.ts, which does NOT re-export payment.ts or
  gate-store.ts -> checked them explicitly (rc=0) WITH a negative control proving deno reports
  errors there (TS2322) | evidence/deno_scope.txt
- commit b4ecf58 + e8508b9; pushed github fix/gate-money-safety (PR #13, comment 6093496026) and ngit
  (refs/heads/fix/gate-money-safety = e8508b9, read back via ls-remote). GitHub Actions CI green on
  e8508b9 (run 38022113139, jobs bun+deno pass).
- gate: tier=code, cleared tests_green/pushed_or_consolidated/consolidated/secrets_clean/
  review_published. Still missing: ci_evidence (STRUCTURAL - gate reads ngit kind-9842 and this repo
  emits none at any commit; it is GitHub-Actions-routed), no_live_drift (unrelated systemd/fleet
  drift), pr_branch_naming (branch pre-dates the card as PR #13's head), cold_cross_family_review +
  review_artifact (review lane's job -> card sent to review).
- sent to review (no reviewer pinned: author is zai/tier/coding-worker, D-115 needs another family).
- REPORT.md section "t_e19ad2e9 (2026-10-10)" at the top carries the full write-up.

---


## t_89dcb160 — Fiat settlement state machine (durable intents, exactly-once settled_reserved, restart-safe replay + ADR-0012 escalation)

Branch: `worker-base/t_89dcb160` (stacked on `fix/gate-money-safety` = PR #13, the money-bug fix).
Worktree: `/home/c03rad0r/worktrees/t_89dcb160` (node_modules symlinked to the reference repo).
Report: `REPORT-t_89dcb160.md` (the sibling `REPORT.md` belongs to PR #13 and was NOT touched).

## Why this card exists
`ExplicitGate` (fixed by PR #13) claims exactly once and fails terminally, but it binds NOTHING:
one `orderId` reused with a different caller / tool / amount / order silently reuses the stored
invoice. A 100-sat invoice can therefore fund a 500-sat fiat attempt. This card adds the durable
intent table with a full binding, a durable proof-reuse barrier, processor-final receipt
verification, and the ADR-0012 escalation state machine.

## Log
- 2026-10-10 05:0x — oriented. Repo `~/repos/cvm-service-kit`; worktree created off PR #13.
  Baseline `bun test src services` = 167 pass / 1 skip / 0 fail. Read payment.ts, gate-store.ts,
  cashu.ts, proof-store.ts, transport.ts, lnwallet.ts, services/cvm-2fiat/*.
- 2026-10-10 05:1x — wrote RED tests (intent-store / settlement / escalation) + the RED-before probe.
- 2026-10-10 05:3x — crash of the prior run captured by the crash-wrapper (signal 15, 1978s).
  Savepoint committed FIRST so the ~2000 uncommitted lines could not be lost: `40d94a9`.
  Full suite already GREEN (205 pass), typecheck clean.
- 2026-10-10 05:5x — the multi-process demo was order-dependent (the duplicate-proof attacker won
  the race). Rewrote it with deterministic phases; 3 consecutive runs identical.
  `2cec663`. Then fixed `assertBindingMatches` (it was passing the TOOL as the intentId).
- 2026-10-10 06:0x — found the escalation DM was **undecryptable**: `NostrDmSink` encrypted with
  the CVM key but signed the gift wrap with a random key. Fixed + before/after evidence
  (`dm_delivery_before_after.ts`). Backed the fix with a test that DECRYPTS the real NIP-44 wrap.
- 2026-10-10 06:1x — service wiring: `escalation-wiring.ts`, `server.ts` (arm at boot from the
  existing `OWNER_NPUB_HEX`, bounded sweep, clean shutdown). The wiring test exposed a real hole:
  `applyReply` had NO author check, so a CUSTOMER reply could mark an intent `refunded` and
  silently resolve the operator's escalation. Now fail-closed (operator only). `b185038`.
- 2026-10-10 06:1x — mutation proof: disabling the binding check + the CAS claim → 20 pass / 5 fail;
  restored → 25 pass / 0 fail. Captured RED-before, suite (216 pass / 1 skip / 0 fail) and
  typecheck. `4c5a6fa` — boot probe shows the real service arming the escalation + creating both
  SQLite tables.
- 2026-10-10 06:2x — pushed to `ngit` AND `github`; PR opened for real CI (this repo's Actions
  only run on `main` push / `pull_request`; ngit CI has no kind-9842 results for ANY commit here).
  Reviewer lanes measured at handoff: glm-5.3 / kimi-k3 / qwen3.6-35b all HTTP 503
  ("all providers exhausted"); author lane resolved to deepseek-flash.
- BOUNDARY (also in REPORT-t_89dcb160.md §4): the live `card.balance` paid path still runs
  `ExplicitGate`, so no terminal-failure escalation fires on TODAY's request path. Substituting
  the machine needs the gated card path's binding fields — that is the follow-up card
  ("Substitute FiatSettlementMachine for ExplicitGate on the cvm-2fiat paid path").

## State
- Suite: 216 pass / 1 skip / 0 fail (217 tests / 35 files). `tsc --noEmit` exit 0.
- Evidence: `src/evidence/output/{red_before,run1,run2,run3,dm_delivery,mutation,suite,typecheck,armed}.txt`.
- Everything committed and pushed. No unpushed commits.

## t_5b30bdec — settled-replay must re-bind the presented proof to the order (2026-10-10)
- finding (cross-family review of t_e19ad2e9, F4): `ExplicitGate.gate` returned the cached
  result for `status === "settled"` keyed on `orderId` alone, never looking at `args.proof` |
  status: CONFIRMED on github/main e2a7065 (probe: different proof / no proof / valid-but-other-order
  proof all RETURN the cached result) | files: src/payment.ts
- fix: the digest of the proof that settled the order is recorded in the SAME atomic claim
  (`GateOrder.proofHash`, mirroring `PaymentIntent.proofHash` + the intent store's sha256 rule), and a
  replay must present matching evidence before the cached result is returned; otherwise
  `SettlementEvidenceMismatchError` (-32006, no invoice in `data`, so a client is not invited to pay a
  settled order twice) | files: src/payment.ts, src/gate-store.ts (proof_hash column + ALTER migration,
  COALESCE so a later write cannot erase the binding)
- scope decision: an order settled WITHOUT a client proof (invoice-polling pmi, or a legacy row) keeps
  the documented no-proof idempotency contract — there is no client-held evidence to bind — but a
  replay that attaches a proof to it is refused. Rationale + residual (orderId possession is still the
  only handle for a poll-verified pmi) in REPORT-t_5b30bdec.md §4/§5.
- red-before: e2a7065, probe returns the cached result on every replay (evidence/replay_proof_binding.red.txt)
- mutation: removing the single `assertReplayedEvidence` call -> 8 pass / 6 fail
  (evidence/replay_proof_binding.mutation.txt)
- green: 14/14 new tests (src/replay_binding.test.ts); `bun run test` 235 pass / 1 skip / 0 fail
  (36 files, was 216/1/0 on e2a7065); `bun run typecheck` rc=0 (evidence/replay_proof_binding.suite.txt)
- not fixed here (reported): out-of-repo consumers of `ExplicitGate` (cvm-ppq, cvm-nanogpt) must be
  audited for replays that present different payment evidence; `SqliteGateStore` still has no reaper
  for a row stuck at `settlement_reserved` (finding F2 of the same review).

## Round 2 (2026-10-10) — cross-family review of the fix returned REQUEST_CHANGES, 7 findings

Artifact: ~/reports/reviews/contextvm-services-t_5b30bdec-Kimi-K3-TEE-review.md (moonshotai/Kimi-K3-TEE,
chutes direct, reviewed head f8cbe15). All 7 adjudicated; 4 produced code/test changes:

- F1 (major, real): `MemoryOrderStore.put` was an unconditional set, so a write built from a stale
  pre-claim object erased the binding on the memory store while sqlite COALESCEd it. Fixed: `put` now
  merges a recorded digest. Mutation M1 (revert to unconditional set) -> 2 fail.
- F2 (major, accepted + now documented): a retry that no longer holds the exact same proof STRING
  (pruned or re-serialised token, v3<->v4 encoding) is refused. Binding on the presented proof is the
  point; the alternative is the hole. Recovery for the ordinary retry (same proof string) is pinned by
  test; the re-serialised case is pinned as a characterisation test; the residual gap and the proper
  fix (processor-supplied stable `evidenceKey`) are recorded in REPORT §6.
- F3 (conditional major, resolved): confirmed in code that `verify()` (L371) runs BEFORE `claim()`
  (L384), so the reviewer's premise held. The stranding branch needs two DISTINCT proofs accepted for
  one invoice (a processor-level double-payment). The reachable same-proof race is pinned by test: the
  loser gets SettlementInProgressError, exactly one action runs, and the loser's own proof then collects
  the cached result.
- F4 (minor, mitigated): `proofHash?` stays optional (a required param would not force implementors -
  TS bivariance), so the mitigation is runtime: the settle-path round-trip check fails closed with
  SettlementBindingNotPersistedError. Mutation M2 (drop the check) -> 1 fail.
- F5 (minor, fixed): `presentedProof()` normalises once; a non-string is never evidence. Mutation M3
  (coerce instead) -> 1 fail; the test uses a COERCING processor, because a processor that already
  rejects unknown strings cannot distinguish the mutant.
- F6 (nit, fixed): one uniform `settlement_evidence_mismatch` reason for every mismatch shape - the
  per-case reasons were a settlement-method oracle. Mutation M4 (re-differentiate) -> 1 fail.
- F7 (nit, fixed): digest compare is now constant-time (`digestEquals` via timingSafeEqual).
- considered + rejected: the -32006 code collision with refusals.ts `rail_unavailable`. The kit's
  convention is that the stable `reason` string discriminates (refusals.ts maps three reasons to
  -32602); codes are coarse buckets and collisions are pre-existing and endemic.
- round-2 green: 23/23 in src/replay_binding.test.ts (75 expect); `bun run test` 244 pass / 1 skip /
  0 fail; `bun run typecheck` rc=0; `deno task check` rc=0; `deno task test` 24 passed/0 failed.
- round-2 mutation: evidence/replay_proof_binding.mutation_round2.txt (M1/M2/M3/M4 all caught).
