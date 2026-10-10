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
- commit b4ecf58; pushed github fix/gate-money-safety (PR #13); pushed ngit
- REPORT.md section "t_e19ad2e9 (2026-10-10)" at the top carries the full write-up.

---



## Findings (STEP 1, verified 2026-10-07)
- CLAIM TRUE. Deployed vps2:cvm-service-kit (blob == commit 21d943c,
  pre-PR#1): src/announce.ts:74-75 `if (opts.tier) return opts.tier;` +
  src/types.ts:77 `tier?: string`.
- github/main b523c9c: same hole at src/announce.ts:90 + types.ts:77 (old
  AnnounceOptions API; the new AnnounceInput/emitAnnouncement API from PR #1 is clean).
- All 4 open PR branches (pr/real-wallet, pr/cvm-2fiat, pr/transport-hardening,
  pr/cashu-ts-v4): same hole at announce.ts:90.
- No caller passes tier: today — latent hole, not an exploited one.
- 7bf4be6 fixed a DIFFERENT announce defect (geohash guard) in the new emitter.

## Fix (STEP 2) on branch worker-base/t_9c37cf49 (base github/main b523c9c)
- RED: src/announce.test.ts new describe "the tier is COMPUTED, never supplied"
  — failed pre-fix (cvm:tier:none emitted for email+"none").
- GREEN: removed `if (opts.tier) return opts.tier;` from resolveTier; removed
  `tier?: string` from AnnounceOptions; computeTier error message updated.
- bun test 81/0, bun typecheck rc=0, deno check rc=0, deno test 24/0.
- Files: src/announce.ts, src/types.ts, src/announce.test.ts

---

## Other PROGRESS entries brought in from main (unrelated to the tier task)

2026-10-09: identified both orphaned pin sites on origin/main → fixed to reachable squash merge SHA → deploy wrapper/defaults edited.
2026-10-09: ancestor and fresh clone checkout probes passed → commit 415ef51 pushed to GitHub branch.
