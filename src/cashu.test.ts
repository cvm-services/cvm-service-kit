import { describe, expect, test } from "bun:test";
import { CashuProcessor, type CashuRedeemer } from "./cashu.ts";

class FakeRedeemer implements CashuRedeemer {
  calls = 0;
  constructor(private amount: number, private fail = false) {}
  async redeem(_token: string): Promise<number> {
    this.calls++;
    if (this.fail) throw new Error("already spent");
    return this.amount;
  }
}

const cfg = { mintUrl: "https://testnut.cashu.exchange" };

describe("CashuProcessor", () => {
  test("invoice names the mint and amount", async () => {
    const p = new CashuProcessor(cfg, new FakeRedeemer(0));
    const inv = await p.createInvoice({ orderId: "o1", amountSats: 10 });
    expect(inv.pmi).toBe("bitcoin-cashu");
    expect(inv.request).toBe("cashu:https://testnut.cashu.exchange:10");
  });

  test("verify is false without a proof", async () => {
    const p = new CashuProcessor(cfg, new FakeRedeemer(100));
    const inv = await p.createInvoice({ orderId: "o1", amountSats: 10 });
    expect(await p.verify(inv)).toBe(false);
  });

  test("verify true when redeemed >= price", async () => {
    const r = new FakeRedeemer(10);
    const p = new CashuProcessor(cfg, r);
    const inv = await p.createInvoice({ orderId: "o1", amountSats: 10 });
    expect(await p.verify(inv, "cashuB...")).toBe(true);
    expect(r.calls).toBe(1);
  });

  test("verify false when underpaid", async () => {
    const p = new CashuProcessor(cfg, new FakeRedeemer(5));
    const inv = await p.createInvoice({ orderId: "o1", amountSats: 10 });
    expect(await p.verify(inv, "cashuB...")).toBe(false);
  });

  test("verify false when redemption fails (double spend)", async () => {
    const p = new CashuProcessor(cfg, new FakeRedeemer(10, true));
    const inv = await p.createInvoice({ orderId: "o1", amountSats: 10 });
    expect(await p.verify(inv, "cashuB...")).toBe(false);
  });
});
