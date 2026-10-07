# Evidence report — caller-supplied tier regression in cvm-service-kit announce.ts

Task t_9c37cf49 · 2026-10-07 · verdict: **CLAIM TRUE, fixed in PR #7**

## STEP 1 — verification (read-only on vps2)

The consultant claim (deleg_bd544a6a): the deployed kit's announce.ts ~74-75
allows a caller-supplied tier, violating the computed-tier invariant that
commit 7bf4be6's lane enforces.

Every copy was read directly (no stale clones):

| Copy | file:line | Shape | Verdict |
|---|---|---|---|
| **deployed** vps2 cvm-service-kit | src/announce.ts:74-75, src/types.ts:77 | `if (opts.tier) return opts.tier;` + `tier?: string` | **WRONG** |
| github/main @ b523c9c | src/announce.ts:90, src/types.ts:77 | identical hole (line shifted by the merged emitter block) | **WRONG** |
| github pr/real-wallet @ 90c3248 | src/announce.ts:90 | identical | WRONG (predates fix) |
| github pr/cvm-2fiat @ c6cc3f3 | src/announce.ts:90 | identical | WRONG (predates fix) |
| github pr/transport-hardening @ 7935588 | src/announce.ts:90 | identical | WRONG (predates fix) |
| github pr/cashu-ts-v4 @ 34445cd8 | src/announce.ts:90 | identical | WRONG (predates fix) |
| the AnnounceInput/emitAnnouncement API (PR #1, 7bf4be6) | src/announce.ts:172-176, 297-298 | "the caller cannot supply the tier" — computes via recomputeTier | CLEAN |

Deployed-copy provenance: the deployed src/announce.ts blob hashes to
145a026d28922f5544352a5147a5140ea5d5c72e == commit **21d943c** (feat(cvm-lambda)),
i.e. the copy predates PR #1's merge; it is not a git checkout (no .git), which
is why it never moved with main.

Exploitation check: every .ts on every ref greped for a caller passing `tier:` —
none does. `_shared/start.ts` (used by all three deployed services) and the
per-service servers pass only requiredInputs/optionalInputs. **Latent hole, on
the exact API the deployed services call (publishAnnouncement).**

7bf4be6 is a red herring for this claim: it fixed the geohash guard
(emitted-tag-set visibility) in the NEW emitter; it never touched resolveTier.

## STEP 2 — RED/GREEN fix

Branch base: github/main b523c9c.

RED (pre-fix, `bun test src/announce.test.ts`):

    (fail) the tier is COMPUTED, never supplied > a caller-supplied tier is
    ignored: the recomputed tier is emitted
      expect(has("t", "cvm:tier:contact")).toBe(true)
      Expected: true   Received: false
    6 pass / 1 fail

GREEN changes:
- src/announce.ts: resolveTier no longer reads opts.tier (comment cites P15)
- src/types.ts: AnnounceOptions drops `tier?: string` (NOTE comment: deliberate)
- src/announce.test.ts: tripwire test retained + @ts-expect-error asserts the
  type cannot express it
- computeTier unknown-field error message no longer points at the removed hatch

Full gate output (local worktree, bun 1.4.2 / deno 2.9.0):

    bun test src/announce.test.ts   → 7 pass / 0 fail
    bun run test                    → 81 pass / 0 fail (20 files)
    bun run typecheck               → rc=0
    deno task check                 → rc=0
    deno task test                  → 24 pass / 0 failed

## Publication (the push saga)

- Local commit e26f9e4 (branch worker-base/t_9c37cf49).
- git-receive-pack to github.com began failing ~17:10Z for this repo only:
  objects upload ("unpack ok") but every ref update 500s — including a
  pre-existing commit to a fresh branch name (tmp canary) — Request ID
  07B5:1A139B:2598993:243FA83:6AC661C4. githubstatus.com: all operational.
  Not auth (felixfelix-bot has push:true), not hooks (remote-side reject).
- ngit mirror: pushed + verified (git ls-remote ngit → e26f9e4; ngit proposal
  abd4f5fd open as pr/tier-computed).
- GitHub via Git Data REST API (worked throughout): uploaded the 4 blobs + 2
  trees + commit → API commit 709862a4 (tree fde70492 == local e26f9e4 tree —
  content-identical; the API commit serializes differently so its sha differs),
  created branch pr/tier-computed by REST ref-create, verified with
  git ls-remote + raw.githubusercontent read of the fixed resolveTier.
- **PR #7**: https://github.com/cvm-services/cvm-service-kit/pull/7
  (OPEN, MERGEABLE; CI: bun PASS, deno PASS — run 37643113340).

## Residual risk / handoff

- The deployed vps2 copy is unchanged (read-only per card). It carries the
  latent hole at 21d943c; no service passes a tier today, so no announcement
  is currently lying — but the next deploy must pull a fixed ref.
- The four open PR branches still carry the hole; they merge into main after
  this fix and will conflict-trivially or auto-resolve — re-check announce.ts
  after each merge (the resolveTier line is the marker).
