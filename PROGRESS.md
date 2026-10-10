# t_89dcb160 — Fiat settlement state machine (durable intents, exactly-once settled_reserved, restart-safe replay + ADR-0012 escalation)

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
