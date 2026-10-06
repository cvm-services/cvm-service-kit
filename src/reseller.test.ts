import { describe, expect, test } from "bun:test";
import { FakeLnWallet } from "./lnwallet.ts";
import { InsufficientTreasuryError, Treasury } from "./reseller.ts";

describe("Treasury", () => {
  test("allows spend above the floor", async () => {
    const t = new Treasury(new FakeLnWallet(1000), { floorSats: 100 });
    expect(await t.canSpend(800)).toBe(true);
    await t.assertCanSpend(800);
  });

  test("refuses spend that would breach the floor", async () => {
    const t = new Treasury(new FakeLnWallet(1000), { floorSats: 500 });
    expect(await t.canSpend(600)).toBe(false);
    await expect(t.assertCanSpend(600)).rejects.toBeInstanceOf(InsufficientTreasuryError);
  });

  test("reconciliation counters", () => {
    const t = new Treasury(new FakeLnWallet(), { floorSats: 0 });
    t.recordSpend(100);
    t.recordEarn(130);
    expect(t.reconciliation()).toEqual({ spentSats: 100, earnedSats: 130, netSats: 30 });
  });
});
