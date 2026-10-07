import { describe, expect, test } from "bun:test";
import { CashuLnWallet, type CashuMeltQuote, type CashuWalletLike } from "./cashu-wallet.ts";
import { MemoryProofStore, type StoredProof } from "./proof-store.ts";

const proof = (amount: number, i: number): StoredProof => ({ amount, secret: `s${i}`, id: "kid", C: "c" });

class FakeWallet implements CashuWalletLike {
  calls: string[] = [];
  preimage: string | null = "pre-1";
  async loadMint(): Promise<void> {
    this.calls.push("loadMint");
  }
  async createMeltQuote(invoice: string): Promise<CashuMeltQuote> {
    return { quote: "mq", amount: 100, fee_reserve: 2, state: "UNPAID", payment_preimage: null, request: invoice };
  }
  async send(amount: number, proofs: any[]): Promise<{ send: any[]; keep: any[] }> {
    const sorted = [...proofs].sort((a, b) => b.amount - a.amount);
    const send: any[] = [];
    let total = 0;
    for (const p of sorted) {
      if (total >= amount) break;
      send.push(p);
      total += p.amount;
    }
    const sendSecrets = new Set(send.map((p) => p.secret));
    return { send, keep: proofs.filter((p) => !sendSecrets.has(p.secret)) };
  }
  async meltProofs(quote: CashuMeltQuote): Promise<{ quote: CashuMeltQuote; change: any[] }> {
    return { quote: { ...quote, state: "PAID", payment_preimage: this.preimage }, change: [] };
  }
  async createMintQuote(amount: number): Promise<{ quote: string; request: string; state: string }> {
    return { quote: "mq1", request: `lnbc${amount}n1fake`, state: "UNPAID" };
  }
}

function mk(preimage: string | null = "pre-1") {
  const store = new MemoryProofStore();
  store.add([proof(128, 1), proof(128, 2), proof(128, 3), proof(64, 4), proof(32, 5), proof(16, 6), proof(4, 7)]);
  const wallet = new FakeWallet();
  wallet.preimage = preimage;
  const w = new CashuLnWallet(
    { mintUrl: "https://mint.test", seed: new Uint8Array(32), dbPath: ":memory:" },
    { store, wallet },
  );
  return { w, store, wallet };
}

describe("CashuLnWallet", () => {
  test("balanceSats sums stored proofs", async () => {
    const { w } = mk();
    expect(await w.balanceSats()).toBe(500);
  });

  test("payInvoice melts and returns the preimage", async () => {
    const { w, store } = mk();
    const r = await w.payInvoice("lnbc100n1x");
    expect(r.preimage).toBe("pre-1");
    // 128 spent (needed 102), 372 remaining
    expect(store.sum()).toBe(372);
  });

  test("payInvoice refuses when balance is short", async () => {
    const { w, store } = mk();
    store.removeBySecrets(store.all().map((p) => p.secret));
    store.add([proof(10, 99)]);
    await expect(w.payInvoice("lnbc100n1x")).rejects.toThrow(/insufficient cashu balance/);
  });

  test("payInvoice errors when the mint returns no preimage", async () => {
    const { w } = mk(null);
    await expect(w.payInvoice("lnbc100n1x")).rejects.toThrow(/preimage/);
  });

  test("makeInvoice returns a BOLT11 and payment hash", async () => {
    const { w } = mk();
    const inv = await w.makeInvoice(42);
    expect(inv.bolt11).toBe("lnbc42n1fake");
    expect(inv.paymentHash).toBe("mq1");
  });
});
