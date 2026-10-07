import {
  CashuLnWallet,
  FakeLnWallet,
  NwcLnWallet,
  type LnWallet,
} from "../../src/index.ts";

export type TreasuryBackend = "nwc" | "cashu" | "fake";

export interface WalletEnv {
  TREASURY_BACKEND?: string;
  NWC_URL?: string;
  CASHU_MINT_URL?: string;
  CASHU_WALLET_SEED?: string;
  CASHU_WALLET_DB?: string;
  [k: string]: string | undefined;
}

export interface ResolvedWallet {
  wallet: LnWallet;
  backend: TreasuryBackend;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  if (clean.length < 32 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error("CASHU_WALLET_SEED must be an even-length hex string (>= 16 bytes)");
  }
  return new Uint8Array(clean.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

/**
 * Select the treasury wallet. Explicit `TREASURY_BACKEND` wins; otherwise auto:
 * NWC_URL → nwc, CASHU_MINT_URL+seed → cashu, else fake (dev). Real backends
 * validate their secrets so a misconfigured prod deploy fails loud.
 */
export function makeWallet(env: WalletEnv): ResolvedWallet {
  const auto: TreasuryBackend = env.NWC_URL
    ? "nwc"
    : env.CASHU_MINT_URL && env.CASHU_WALLET_SEED
      ? "cashu"
      : "fake";
  const backend = (env.TREASURY_BACKEND as TreasuryBackend) ?? auto;

  switch (backend) {
    case "nwc": {
      if (!env.NWC_URL) throw new Error("TREASURY_BACKEND=nwc requires NWC_URL");
      return { wallet: new NwcLnWallet(env.NWC_URL), backend };
    }
    case "cashu": {
      if (!env.CASHU_MINT_URL) throw new Error("TREASURY_BACKEND=cashu requires CASHU_MINT_URL");
      if (!env.CASHU_WALLET_SEED) throw new Error("TREASURY_BACKEND=cashu requires CASHU_WALLET_SEED");
      return {
        wallet: new CashuLnWallet({
          mintUrl: env.CASHU_MINT_URL,
          seed: hexToBytes(env.CASHU_WALLET_SEED),
          dbPath: env.CASHU_WALLET_DB ?? "/var/lib/loom/cvm-treasury/cashu.sqlite",
        }),
        backend,
      };
    }
    case "fake":
      return { wallet: new FakeLnWallet(), backend: "fake" };
    default:
      throw new Error(`unknown TREASURY_BACKEND=${backend}`);
  }
}
