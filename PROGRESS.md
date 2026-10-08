# PROGRESS — t_0f29f58f (pr/cashu-ts-v4-rebased)

Branch: pr/cashu-ts-v4-rebased = pr/cashu-ts-v4 (34445cd, PR #3) rebased onto
main (117366c). Deliverable: PR #3 green on current main + the treasury wallet
ported to cashu-ts v4.

## Why
PR #3 (cashu-ts ^2.1 → ^4, settlement path) was returned CHANGES REQUIRED:
main gained `src/cashu-wallet.ts` (the treasury `CashuLnWallet`) after the
branch forked, and it still used the removed v2 API — merging broke tsc
(TS2305 CashuMint/CashuWallet, TS2308 CashuWalletLike collision) and the suite
(8× `Export named 'CashuMint' not found`).

## Done
1. Rebase: cherry-pick of 34445cd onto main — textually clean (merge-tree
   exit 0), same patch-id, 6 files 268+/39-.
2. RED (reproduced blocker on the rebased branch, before the port):
   tsc exit 2 with exactly the 3 review errors; bun suite 91 pass / 10 fail
   (8 SyntaxError import failures). `.artifacts/RED-{typecheck,bun-test}.txt`.
   New treasury tests vs the v2 code: compile-RED (module cannot load under
   v4 — seam absent). `.artifacts/RED-new-tests.txt`.
3. Port `src/cashu-wallet.ts` to v4: `CashuWallet`/`CashuMint` → `Wallet`;
   `createMintQuote`/`checkMintQuote`/`mintProofs` → the `*Bolt11` variants;
   `createMeltQuote`/`meltProofs` → `*Bolt11`; NUT-07 `checkProofsStates`
   added to the melt path (advisory, fail-open, by-index zip, short-answer
   guard — the melt stays authoritative); `Amount.toNumber()` boundary at
   every proof-store entry (v4 `Amount.toJSON()` is a string — a leak would
   corrupt SQLite `SUM(amount)` into concatenation).
   Interface rename: `CashuWalletLike` → `CashuTreasuryWalletLike`
   (resolves the TS2308 star-export collision; `src/cashu.ts`'s reviewed
   `CashuWalletLike` is untouched — no other importer existed).
4. GREEN: tsc exit 0; bun 150 pass / 0 fail (151 tests, 28 files); deno
   check exit 0; deno test 24 passed / 0 failed; `deno install` shows
   `+ npm:@cashu/cashu-ts 4.11.0` and NO obsolete-package warning.
   `.artifacts/GREEN-*.txt`.
5. Mutation matrix on the new guard tests (`.artifacts/mutation-matrix.txt`):
   A no-NUT-07-precheck, B PENDING-as-spent, C fail-closed NUT-07,
   D Amount-leak-into-store, E melted-not-consumed, F short-NUT-07-answer —
   all 6 caught by named tests in `src/cashu-wallet.test.ts`.
6. Live probe: v4 loads mint.orangesync.tech (cdk-mintd) + testnut — the v2
   cdk-keyset limitation in TREASURY.md is resolved; docs updated.
7. PR #3 body: the "only other caller" sentence corrected; merged --merge;
   ngit mirror synced and verified.

## Behaviour changes (treasury)
- New: NUT-07 advisory prune before melt (mint-spent proofs never fed to a
  melt nor counted in the melt-time balance); fail-open, PENDING not spent.
- Amount boundary: v4 change proofs are stored as numeric amounts (invisible
  externally; prevents store corruption).
- None: invoice/preimage/balance/fund contracts identical.
