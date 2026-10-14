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

## t_7233c336 — PR #13 money gate: consumer audit (BLOCKING) + recovery path + test hardening (2026-10-10)

Branch `fix/gate-consumer-audit` (base `github/main` @ `e2a7065`; PR #13 itself is MERGED).
Report: `REPORT.md` section "t_7233c336 (2026-10-10)". Audit doc: `docs/gate-consumer-audit.md`.
Runbook: `docs/gate-recovery-runbook.md`. Evidence: `evidence/recovery/`.

- finding: the audit premise was FALSE - the five "consumers" are directories in THIS repo, not
  repositories; all are compiled by the same `tsc --noEmit`, none owns a GateOrderStore and none
  branches on a gate status | status: AUDITED (F1-F4, F7) - no cross-repo break is possible
- finding: the ONE real consumer defect - `cvm-sms4sats` passed NO store, so the gate kept its
  settled-memory in an in-process Map lost on every `Restart=always` | status: FIXED (64daf9e),
  falsification control in services/cvm-sms4sats/src/gate-durability.test.ts
- finding (HIGH): no escape hatch for settlement_reserved / settlement_failed | status: FIXED
  (operator recovery: src/gate-recovery.ts + gate-recovery-cli.ts + runbook + 6 tests);
  deliberately NOT automatic - a lease only flags, it never moves a row
- finding (MED): the concurrency comment claimed ~99% detection at 4 rounds while the mutation row
  said "not caught"; evidence/README.md claimed 6 of 6, refuted by its own log | status: FIXED
  (claim removed; both stale REPORT.md rows + the README row carry the correction)
- other MEDs (status fall-through, unguarded terminal write, bare rejects.toThrow, failure DDL,
  deno.lock split, void-tool replay guard) were already fixed by the MERGED gate or the earlier
  commit on this branch; each now carries a named test or a correction - table F8.2
- green: bun test src/gate-recovery.test.ts 6/6; bun run test 231 pass/1 skip/0 fail (37 files);
  bun run typecheck rc=0; deno task check + deno check <4 files> rc=0; CLI usage rc=2, list rc=0
- pushed: github + ngit `fix/gate-consumer-audit` = `c27a2d6` (both read back via ls-remote); PR #17
  opened (base `main` @ e2a7065), GitHub Actions run 38069241558 jobs bun+deno = pass,
  MERGEABLE/CLEAN; PR #13 updated with a pointer (comment 6099902729) and the re-review request
  posted on #17 (comment 6099903603). Re-review is still OUTSTANDING - the BLOCKED verdict on
  PR #13 stands until a different-family reviewer clears #17, so this card goes to review.
- re-verified at head 263bed1 after the workspace flagged stale evidence: `bun run typecheck` rc=0;
  `bun run test` 231 pass / 1 skip / 0 fail (37 files) rc=0; `bun test src/gate-recovery.test.ts`
  6/6. One unrelated PRE-EXISTING test (services/cvm-sms4sats/src/tools.test.ts, untouched by this
  branch, 5/5 alone in 2.98s) hit bun's 5s DEFAULT timeout once at load 29.5 - the documented
  oversubscription flake; noted in evidence/recovery/suite_bun.txt.

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

## Round 3 (2026-10-10) — the re-review of round 2 returned REQUEST_CHANGES again, 3 findings

Artifact: ~/reports/reviews/contextvm-services-t_5b30bdec-Kimi-K3-TEE-review-r2.md (reviewed 2829a37).
Two of the three were real defects in round 2's work; all are fixed or conceded. REPORT §10/§11.

- R2-1 (major): my round-2 F3 dismissal ("needs a processor defect") was WRONG and is withdrawn.
  Two distinct valid proofs for one invoice is ordinary bearer behaviour (the suite's own
  ProofProcessor cannot see the concurrent redemption). F3 is now recorded as an accepted residual
  risk in REPORT §5, with the trace, a recovery note and two candidate durable fixes; the hazard is
  also documented on `PaymentProcessor.verify` (JSDoc) so the next processor author cannot miss it.
- R2-2 (minor, real): the settle-time backfill was an uncaught mutant - dead under the bundled
  stores and indistinguishable under LossyStore, so deleting it left the suite green. Added
  LegacyClaimStore (pre-binding 3-arg `claim`, full-object put/get) which asserts the order settles
  BOUND. Mutation M7 (delete the backfill) -> 1 fail.
- R2-3 (minor, real, conditional): the F1 merge inherited a stale digest across orderId reuse (a
  write taking a terminal row back to awaiting_payment), so the new order would settle bound to the
  previous payer's digest. Fixed in BOTH stores (`startsNewGeneration` + a sqlite CASE). New test
  covers both stores end to end. Mutations M5/M6 -> 1 fail each.
- nits: no duplicated error message (`super(reason)`); comment on the deliberate result-withholding
  exception; recorded that F7's constant-time compare is NOT mutation-pinnable (do not over-read
  the mutation count).
- round-3 green: 25/25 src/replay_binding.test.ts (92 expect); `bun run test` 246 pass / 1 skip /
  0 fail; `bun run typecheck` rc=0; `deno task check` rc=0; `deno task test` 24 passed/0 failed.
- round-3 mutation: evidence/replay_proof_binding.mutation_round3.txt - M1..M7 all caught, source
  restored byte-identical. This supersedes the round-2 transcript (M1-M4 same, M5-M7 new).

## Round 4 (cross-family re-review of the R3-1 delta) - done
- r3 review (chutes moonshotai/Kimi-K3-TEE, reviewed cd1225f): APPROVE + 1 non-blocking finding
  R3-1 (only `settled` was pinned; deleting a single entry from either terminal-status list
  survived the suite). Accepted and closed: c41b528 parameterises the reuse test over all four
  statuses on both stores (settled/settlement_failed via the REAL gate path), docs both sites.
- r4 review (same lane, head c41b528): APPROVE + F4-1 (minor) + F4-2 (nit).
  F4-1 was RIGHT and about my own prose: the comment claimed the test loops over TERMINAL_STATUSES;
  it looped over a local mirror, so an ADDED entry stayed unpinned. Fixed in the strong direction
  in 0b9c4a7: TERMINAL_STATUSES is exported, the sqlite CASE IN-list is interpolated from it (the
  two stores can no longer drift), the explicit mirror stays (pins deletions) plus a set-equality
  assertion against the exported list (pins additions).
  F4-2: the mutation transcript header named the committed HEAD while its baseline was the dirty
  tree; regenerated so the header prints the commit AND the working-tree status.
- round-4 green: 27/27 src/replay_binding.test.ts (145 expect); `bun run test` 248 pass / 1 skip /
  0 fail (249 tests); `bun run typecheck` rc=0; `deno task check` rc=0; `deno check
  src/payment.ts src/gate-store.ts` rc=0; `deno task test` 24 passed/0 failed.
- round-4 mutation: evidence/replay_proof_binding.mutation_round4.txt - M8..M12 caught;
  M13 (equality assertion deleted first, then settle_failed removed) also caught -> proves the
  behavioural loop has teeth on its own; source restored byte-identical.
- report: REPORT-t_5b30bdec.md sections 7 (all four rounds), 12, 13 updated.

---

## t_7233c336 — verification + merge pass (2026-10-14, offload worker)

**Arrival state, and why this is a verification pass rather than a redo.** The dispatch prose was
stale in two ways: (1) PR #13 is **MERGED** (`mergedAt=2026-10-10T13:48:58Z`, merge commit
`220cb21`; the reviewed head `b35b916` was superseded by `4949736` before merge), so "update PR #13
and request a re-review" is not an available action; (2) the blocker work already exists on this
branch as **PR #17** (OPEN). The durable card `t_7233c336` is not on board `contextvm-services`
(`hermes kanban show t_7233c336` -> "no such task").

**What was actually wrong and is now fixed.**

- finding: `fix/gate-consumer-audit` was based on `e2a7065` while `main` had reached `0dc9b71` — 9
  commits behind, including PR #19's settled-replay proof binding (`GateOrder.proofHash`,
  `TERMINAL_STATUSES`, the new-generation `CASE`, 2 new error classes). A stale PR cannot be
  merged. | status: FIXED — `main` merged into the branch (`cb01506`), never rebased; conflicts
  resolved as a union in `src/gate-store.ts` (main's `proof_hash` migration + `TERMINAL_STATUSES`
  SQL + 4-arg `claim()` KEPT alongside this branch's `gate_recovery` table / `list()` /
  `putResolution()` / `listResolutions()`) and in `PROGRESS.md` (both sections kept). | files:
  src/gate-store.ts, PROGRESS.md
- finding: the audit doc's printed grep evidence was pinned to `e2a7065`; PR #19 shifted
  `payment.ts` by ~275 lines, so a reviewer re-running the greps would get different line numbers
  (and F2's grep now also matches two test doubles in `src/replay_binding.test.ts`). | status:
  FIXED — every grep re-run on the merged tree; F2/F2b/F4 citations updated (`payment.ts:195` ->
  `:394`), F2 now carries the `grep -v '\.test\.ts'` filter and an explicit note on the two test
  doubles; F8's test count corrected 5 -> 6; a merge note added. | files:
  docs/gate-consumer-audit.md, REPORT.md
- verified (all on the merge result `cb01506`): `bun run typecheck` rc=0; `bun test src services`
  -> **258 pass / 1 skip / 0 fail** (259 tests, 38 files) rc=0; `bun test src/gate-recovery.test.ts`
  6/6; `bun test services/cvm-sms4sats/src/gate-durability.test.ts` 3/3; `bun test
  src/money_safety.test.ts` 14/14; recovery CLI exit codes measured honestly (usage rc=2, bad
  subcommand rc=2, refusal rc=1); `ansible-playbook --syntax-check playbook-wrappers.yml` rc=0.
- independently re-ran the audit's own greps (F2/F2b/F3/F4a/F4b) and the F1 tsconfig and F6 deploy
  claims on the merged tree: the *substance* of every one of F1-F7 holds unchanged.
- pushed: `github` `fix/gate-consumer-audit` = `cb01506` (read back via `git ls-remote`). **ngit
  push FAILED** — this host has no ngit account (`ngit account list` -> "no accounts available";
  `failed to get or find signer info`). GitHub-only on this host; stated, not hidden.
- NOT verified (stated, not hidden): the `GATE_DB:` line added to
  `deploy/ansible/playbook-wrappers.yml` is an **IaC change** and the fleet working agreement
  requires IaC to be executed against a live node and read back from the node. This host has no
  managed target and no fleet credentials, so it is unexecuted. Syntax-check only.
- still open: the cross-family **re-review of PR #17**. The BLOCKED verdict on PR #13 stands as a
  historical record; PR #17's own review is what gates a merge.
- cross-family review COULD NOT be obtained from this host: every non-flash lane returned
  `HTTP 503 "all providers exhausted (flat router)"` (kimi-k3, kimi-k2.7-code, kimi-k3:cloud,
  minimax-m3:cloud, deepseek/deepseek-v4-pro). The re-review request is published on the PR
  (comment 6165452917) instead. A SAME-family independent-context self-check
  (`deepseek/deepseek-v4-flash` — the dispatching agent's own family, so it does NOT satisfy
  D-115 and is not a review of record) was run anyway; findings and dispositions are tabulated in
  `docs/gate-consumer-audit.md` § "Independent self-check".
- finding (from that self-check, LOW): `SqliteGateStore.list([])` returned **ALL** orders,
  contradicting its own doc ("all orders when omitted"). Latent — no caller passes `[]` today, but
  a config-driven status set that came out empty would have scanned the whole table. | status:
  FIXED, TDD (RED test `src/gate-store.test.ts` "list([]) is an EMPTY filter, not 'no filter'"
  failed with the full table, then `list([])` returns `[]`; `list()` / `list("x")` /
  `list(["x","y"])` unchanged). | files: src/gate-store.ts, src/gate-store.test.ts
- green after that fix: `bun run typecheck` rc=0; `bun test src services` **259 pass / 1 skip /
  0 fail** (260 tests, 38 files) rc=0.


## t_7233c336 — offload verification pass 2 (2026-10-14, offload worker)

**Arrival state.** The card's work was already complete and pushed as PR #17 (OPEN,
head `d450a1c`, CI bun+deno pass). PR #13 is MERGED. This pass therefore verified rather
than redid, and closed the two things that were actually stale.

- verified the audit's own evidence reproduces on the merged tree: re-ran every F2/F2b/F3/F4
  grep and the F1 tsconfig / F6 deploy claims independently. All reproduce; F1–F7 hold.
- verified the recovery path has real teeth by MUTATION, not by reading it:
  M-R1 (drop the live-lease guard) -> 4 pass/2 fail CAUGHT; M-R3 (remove the not_reserved
  guard) -> 4 pass/2 fail CAUGHT; M-R2 (CAS source `"settlement_reserved"` -> `order.status`)
  SURVIVES but is a provable EQUIVALENT mutant (the line-116 guard + snapshot pre-read make
  the substitution a no-op), so it is not a coverage gap. Source restored byte-identical.
  | evidence/recovery/mutation_gate_recovery.txt
- verified the sms4sats durability fix's control has teeth: M-S1 (revert `buildGate` to
  `new ExplicitGate(processor)`) -> 2 pass/1 fail CAUGHT.
- **finding: the branch was 12 commits behind again** (`main` `0dc9b71` -> `b9a50bf`, PRs
  #20–#22). | status: FIXED — merged (never rebased); `6b69d08`; no conflicts (the only
  both-sides file is `deploy/ansible/playbook-wrappers.yml`, hunks in different regions).
- **finding: `main` added a SIXTH gate consumer** — `services/cvm-deepinfra/src/server.ts:26`
  — which the audit's F3 table did not cover. | status: FIXED — F3 table + a "Merge note 2"
  section added. The new consumer already passes a durable `SqliteGateStore`, i.e. it has
  the required `claim`; had it not, the in-tree typecheck would have failed on `main` the
  moment it landed. This *confirms* F1/F2 and shows the durable control is the typecheck,
  not a prose checklist of five names.
- **finding (honesty):** `bun test src services tests` = 3 fail / 3 errors, all
  `ReferenceError: Deno is not defined` from the `Deno.test`-native files `main` added under
  `tests/`. | status: NOT a regression — a detached worktree at pristine `github/main`
  (`b9a50bf`) reports the identical `0 pass/3 fail/3 errors` for `bun test tests`. They are
  green in their own lane (`deno task test` 29/0). Recorded in the audit doc so a reviewer
  does not mistake it for a branch defect.
- green on `6b69d08`: `bun run typecheck` rc=0; `bun test src services` **328 pass / 1 skip /
  0 fail** (329 tests, 43 files); `deno task test` **29 passed / 0 failed**;
  `deno check src/{payment,gate-store,gate-recovery,gate-recovery-cli}.ts` rc=0.
- pushed: `github` `fix/gate-consumer-audit` = `74b5fad` (read back via `git ls-remote`).
  **ngit push FAILED** — `authentication required; run 'ngit account login'`; this host has
  no ngit account. GitHub-only here, stated not hidden.
- cross-family re-review: **still unobtainable from this host.** Probed every non-glm lane
  directly: `kimi-k3` and `deepseek/deepseek-v4-pro` return `all providers exhausted`;
  `minimax-m3:cloud` and `qwen3.6-35b` likewise; and — the important one —
  `kimi-k2.7-code` and `kimi-k3:cloud` **silently return `model: deepseek-flash`**, i.e. the
  flat router substitutes a SAME-FAMILY lane for an exhausted one. A "cross-family" review
  taken at face value from those ids would have been deepseek reviewing deepseek. Not
  accepted. Requested on the PR instead.
