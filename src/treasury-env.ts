import { NwcLnWallet, type LnWallet } from "./lnwallet.ts";

/**
 * Production wallet selection — one seam, no substitutes.
 *
 * A deployed CVM reseller either has a real Lightning rail configured
 * (NWC_URL, a NIP-47 connection URI from the fleet vault) or it has NO
 * wallet at all. FakeLnWallet is for tests and local development only and
 * must never be constructed as a stand-in for a missing rail: a fake
 * treasury balance is a lie about money the service can actually spend.
 *
 * The honest failure mode lives in `Treasury`: with no wallet, every money
 * question refuses with `rail_unavailable` (CEP-0001 P11) instead of
 * inventing an answer.
 */

export interface WalletSelection {
  /** The real wallet, or undefined when the rail is not configured. */
  wallet?: LnWallet;
  /** True iff a real wallet is configured. */
  real: boolean;
  /** Which rail this deployment expects (used in refusal data + health). */
  rail: "nwc";
}

export function walletFromEnv(env: Record<string, string | undefined>): WalletSelection {
  const nwcUrl = (env.NWC_URL ?? "").trim();
  if (!nwcUrl) {
    return { real: false, rail: "nwc" };
  }
  return { wallet: new NwcLnWallet(nwcUrl), real: true, rail: "nwc" };
}
