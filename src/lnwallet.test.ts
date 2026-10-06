import { describe, expect, test } from "bun:test";
import { FakeLnWallet, invoiceAmountSats } from "./lnwallet.ts";

describe("invoiceAmountSats", () => {
  test("parses multipliers", () => {
    expect(invoiceAmountSats("lnbc10n1...")).toBe(1);
    expect(invoiceAmountSats("lnbc1u1...")).toBe(100);
    expect(invoiceAmountSats("lnbc1m1...")).toBe(100_000);
    expect(invoiceAmountSats("lnbc1...")).toBe(100_000_000);
  });
  test("amountless returns null", () => {
    expect(invoiceAmountSats("lnbc1...")).not.toBeNull();
    expect(invoiceAmountSats("garbage")).toBeNull();
  });
});

describe("FakeLnWallet", () => {
  test("payInvoice debits balance and returns a preimage", async () => {
    const w = new FakeLnWallet(100);
    const r = await w.payInvoice("lnbc50n1x"); // 5 sats
    expect(r.preimage).toBeTruthy();
    expect(await w.balanceSats()).toBe(95);
  });
  test("insufficient balance throws", async () => {
    const w = new FakeLnWallet(1);
    await expect(w.payInvoice("lnbc10u1x")).rejects.toThrow(/insufficient/);
  });
});
