# t_9c37cf49 — tier-computation regression in announce.ts

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
