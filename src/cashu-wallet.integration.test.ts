/**
 * Opt-in integration test against a live Cashu mint. Run with:
 *   MINT_INTEGRATION=1 CASHU_TEST_MINT=https://mint.orangesync.tech \
 *     bun test src/cashu-wallet.integration.test.ts
 *
 * Skipped by default so CI (no network) stays green. The default mint
 * (mint.orangesync.tech, cdk-mintd/fakewallet) funds quotes for free.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CashuLnWallet } from "./cashu-wallet.ts";

const ENABLED = !!process.env.MINT_INTEGRATION;
// NB: v4 verifies cdk-mintd keysets, so cdk mints (mint.orangesync.tech) work
// too; testnut (Nutshell fakewallet) remains the default because its quotes
// auto-pay, which the fund() path relies on.
const MINT = process.env.CASHU_TEST_MINT ?? "https://testnut.cashu.exchange";
const d = ENABLED ? describe : describe.skip;

d("CashuLnWallet live integration", () => {
  test(
    "fund, makeInvoice, melt (payInvoice)",
    async () => {
      const dbPath = join(mkdtempSync(join(tmpdir(), "cashu-int-")), "w.sqlite");
      const seed = new Uint8Array(32).fill(7);
      const w = new CashuLnWallet({ mintUrl: MINT, seed, dbPath });

      // Fund for free (fakewallet auto-pays the mint quote).
      const funded = await w.fund(200, { intervalMs: 1500, attempts: 20 });
      expect(funded.balanceSats).toBeGreaterThanOrEqual(200);
      const before = funded.balanceSats;

      // Mint a real BOLT11 from the same mint, then melt it back.
      const inv = await w.makeInvoice(50);
      expect(inv.bolt11.startsWith("lnbc")).toBe(true);

      let preimage: string | null = null;
      let error: string | null = null;
      try {
        preimage = (await w.payInvoice(inv.bolt11)).preimage;
      } catch (e: any) {
        error = e?.message ?? String(e);
      }
      // Record whether this mint exposes a melt preimage (needed for L402).
      console.error(`[cashu-int] mint=${MINT} preimage=${preimage} error=${error}`);
      expect(preimage !== null || /preimage/.test(error ?? "")).toBe(true);
    },
    120_000,
  );
});
