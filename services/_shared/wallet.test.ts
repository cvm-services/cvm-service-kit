import { describe, expect, test } from "bun:test";
import { CashuLnWallet, FakeLnWallet, NwcLnWallet } from "../../src/index.ts";
import { makeWallet } from "./wallet.ts";

describe("makeWallet", () => {
  test("auto-selects fake when nothing is configured", () => {
    const { wallet, backend } = makeWallet({});
    expect(backend).toBe("fake");
    expect(wallet).toBeInstanceOf(FakeLnWallet);
  });

  test("auto-selects nwc from NWC_URL", () => {
    const url =
      "nostr+walletconnect://abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789?relay=wss://r.example&secret=" +
      "11".repeat(32);
    const { wallet, backend } = makeWallet({ NWC_URL: url });
    expect(backend).toBe("nwc");
    expect(wallet).toBeInstanceOf(NwcLnWallet);
  });

  test("auto-selects cashu from mint + seed", () => {
    const { wallet, backend } = makeWallet({
      CASHU_MINT_URL: "https://mint.test",
      CASHU_WALLET_SEED: "ab".repeat(32),
      CASHU_WALLET_DB: ":memory:",
    });
    expect(backend).toBe("cashu");
    expect(wallet).toBeInstanceOf(CashuLnWallet);
  });

  test("explicit backend validates required secrets", () => {
    expect(() => makeWallet({ TREASURY_BACKEND: "nwc" })).toThrow(/NWC_URL/);
    expect(() => makeWallet({ TREASURY_BACKEND: "cashu", CASHU_MINT_URL: "https://m" })).toThrow(/CASHU_WALLET_SEED/);
    expect(() =>
      makeWallet({ TREASURY_BACKEND: "cashu", CASHU_MINT_URL: "https://m", CASHU_WALLET_SEED: "zz" }),
    ).toThrow(/hex/);
  });

  test("unknown backend throws", () => {
    expect(() => makeWallet({ TREASURY_BACKEND: "wat" })).toThrow(/unknown TREASURY_BACKEND/);
  });
});
