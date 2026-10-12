import { describe, expect, test } from "bun:test";
import {
  CvmRefusalError,
  FakeLnWallet,
  NwcLnWallet,
  REFUSALS,
  SqliteOrderStore,
  Treasury,
  walletFromEnv,
  type LnWallet,
} from "./index.ts";

const NWC_URI =
  "nostr+walletconnect://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?relay=wss%3A%2F%2Fwallet.example&secret=000102030405060708090a0b0c0d0e0f&encryption=nip44";

describe("walletFromEnv — no substitute in production", () => {
  test("no NWC_URL -> no wallet at all, never a FakeLnWallet", () => {
    const sel = walletFromEnv({});
    expect(sel.wallet).toBeUndefined();
    expect(sel.real).toBe(false);
    expect(sel.rail).toBe("nwc");
  });

  test("empty-string NWC_URL is unconfigured, not a parse error", () => {
    const sel = walletFromEnv({ NWC_URL: "" });
    expect(sel.wallet).toBeUndefined();
    expect(sel.real).toBe(false);
  });

  test("whitespace NWC_URL is unconfigured", () => {
    const sel = walletFromEnv({ NWC_URL: "   " });
    expect(sel.wallet).toBeUndefined();
    expect(sel.real).toBe(false);
  });

  test("NWC_URL set -> NwcLnWallet, real=true", () => {
    const sel = walletFromEnv({ NWC_URL: NWC_URI });
    expect(sel.wallet).toBeInstanceOf(NwcLnWallet);
    expect(sel.real).toBe(true);
    expect(sel.rail).toBe("nwc");
  });
});

describe("unconfigured treasury — honest refusal, no fabricated numbers", () => {
  function unconfigured(): Treasury {
    // The production path under test: no wallet configured at all.
    return new Treasury(walletFromEnv({}).wallet, { floorSats: 1000 });
  }

  test("balanceSats refuses rail_unavailable instead of inventing a number", async () => {
    const t = unconfigured();
    try {
      await t.balanceSats();
      throw new Error("expected balanceSats to refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(CvmRefusalError);
      const r = e as CvmRefusalError;
      expect(r.reason).toBe("rail_unavailable");
      expect(r.code).toBe(REFUSALS.rail_unavailable.code);
      expect(r.data.rail).toBe("nwc");
    }
  });

  test("canSpend refuses rail_unavailable (never a false 'cannot afford')", async () => {
    const t = unconfigured();
    try {
      await t.canSpend(100);
      throw new Error("expected canSpend to refuse");
    } catch (e) {
      expect((e as CvmRefusalError).reason).toBe("rail_unavailable");
    }
  });

  test("assertCanSpend refuses rail_unavailable before any upstream order is paid", async () => {
    const t = unconfigured();
    try {
      await t.assertCanSpend(100);
      throw new Error("expected assertCanSpend to refuse");
    } catch (e) {
      expect((e as CvmRefusalError).reason).toBe("rail_unavailable");
    }
  });

  test("a configured treasury still behaves as before (regression guard)", async () => {
    const t = new Treasury(new FakeLnWallet(50_000), { floorSats: 1000 });
    expect(await t.balanceSats()).toBe(50_000);
    expect(await t.canSpend(100)).toBe(true);
    expect(await t.canSpend(60_000)).toBe(false);
    await t.assertCanSpend(100); // does not throw
    await expect(t.assertCanSpend(60_000)).rejects.toThrow();
  });
});
