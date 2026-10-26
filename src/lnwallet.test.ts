import { describe, expect, test } from "bun:test";
import { FakeLnWallet, invoiceAmountSats, mapLookupResult } from "./lnwallet.ts";

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

describe("mapLookupResult", () => {
  test("a nested transaction is unwrapped", () => {
    const r = mapLookupResult({ transaction: { state: "paid", preimage: "abc" } });
    expect(r).toEqual({ state: "settled", preimage: "abc" });
  });

  test("a top-level payload is also accepted", () => {
    expect(mapLookupResult({ state: "settled", preimage: "abc" })).toEqual({ state: "settled", preimage: "abc" });
  });

  test("failed and expired are failed", () => {
    expect(mapLookupResult({ state: "failed" }).state).toBe("failed");
    expect(mapLookupResult({ transaction: { state: "expired" } }).state).toBe("failed");
  });

  test("an UNRECOGNISED state stays pending, never settled", () => {
    // This is the dangerous direction: a parsing surprise must not read as paid.
    for (const s of ["", "unknown", "processing", "weird-new-state", undefined]) {
      expect(mapLookupResult({ state: s }).state).toBe("pending");
    }
    expect(mapLookupResult({}).state).toBe("pending");
    expect(mapLookupResult(null).state).toBe("pending");
  });

  test("garbage input does not throw", () => {
    expect(mapLookupResult("not an object").state).toBe("pending");
    expect(mapLookupResult(42).state).toBe("pending");
  });
});

describe("FakeLnWallet lookup", () => {
  test("a paid invoice reports settled with its preimage", async () => {
    const w = new FakeLnWallet(100);
    const r = await w.payInvoice("lnbc50n1x");
    const status = await w.lookupInvoice("lnbc50n1x");
    expect(status.state).toBe("settled");
    expect(status.preimage).toBe(r.preimage);
  });

  test("an invoice never paid reports pending, not failed", async () => {
    const w = new FakeLnWallet(100);
    expect((await w.lookupInvoice("lnbc1u1never")).state).toBe("pending");
  });
});
