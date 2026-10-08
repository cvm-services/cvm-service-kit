import { describe, expect, test } from "bun:test";
import { Amount, CheckStateEnum, type Proof, type ProofState } from "@cashu/cashu-ts";
import {
  CashuLnWallet,
  type CashuTreasuryWalletLike,
  type TreasuryMeltQuote,
} from "./cashu-wallet.ts";
import { MemoryProofStore, type StoredProof } from "./proof-store.ts";

const proof = (amount: number, i: number): StoredProof => ({ amount, secret: `s${i}`, id: "kid", C: "c" });

/** A v4-shaped proof: `amount` is an `Amount` value object, toJSON is a string. */
const v4proof = (amount: number, i: number): Proof => ({
  amount: Amount.from(amount),
  secret: `s${i}`,
  id: "kid",
  C: "c",
});

/** A v4-shaped melt quote: `amount`/`fee_reserve` are `Amount` values. */
const v4melt = (amount: number, fee: number): TreasuryMeltQuote => ({
  quote: "mq",
  amount: Amount.from(amount),
  fee_reserve: Amount.from(fee),
  state: "UNPAID",
  payment_preimage: null,
  unit: "sat",
  request: "lnbc100n1x",
});

interface FakeOpts {
  /** NUT-07 verdict per proof, by secret suffix; default UNSPENT. */
  states?: Record<string, "UNSPENT" | "SPENT" | "PENDING">;
  statesUnavailable?: boolean;
  /** Return fewer states than proofs (malformed mint answer). */
  shortStates?: boolean;
  meltFails?: boolean;
  preimage?: string | null;
  change?: Proof[];
}

/**
 * Stand-in for the v4 `Wallet` on the treasury path: no network, every step
 * observable. Method names follow v4 (`*Bolt11` variants); quote/proof
 * amounts are `Amount` value objects exactly as the real client returns them.
 */
class FakeWallet implements CashuTreasuryWalletLike {
  loadCalls = 0;
  stateCalls = 0;
  meltCalls = 0;
  mintQuoteCalls = 0;
  /** Proofs actually handed to the melt, by the wallet under test. */
  melted: Array<Array<Pick<Proof, "secret" | "id">>> = [];

  constructor(private readonly opts: FakeOpts = {}) {}

  async loadMint(): Promise<void> {
    this.loadCalls++;
  }

  async createMeltQuoteBolt11(invoice: string): Promise<TreasuryMeltQuote> {
    return { ...v4melt(100, 2), request: invoice };
  }

  async meltProofsBolt11(
    quote: TreasuryMeltQuote,
    proofs: Proof[],
  ): Promise<{ quote: TreasuryMeltQuote; change: Proof[] }> {
    this.meltCalls++;
    this.melted.push(proofs.map((p) => ({ secret: p.secret, id: p.id })));
    if (this.opts.meltFails) throw new Error("mint error: inputs already spent");
    return {
      quote: {
        ...quote,
        state: "PAID",
        payment_preimage: this.opts.preimage === undefined ? "pre-1" : this.opts.preimage,
      },
      change: this.opts.change ?? [v4proof(300, 99)],
    };
  }

  async createMintQuoteBolt11(amount: number, description?: string): Promise<{
    quote: string;
    request: string;
    state: string;
  }> {
    this.mintQuoteCalls++;
    return { quote: `mq${this.mintQuoteCalls}`, request: `lnbc${amount}n1fake`, state: "UNPAID", ...(description ? { description } : {}) };
  }

  async checkMintQuoteBolt11(quote: string): Promise<{ quote: string; request: string; state: string }> {
    return { quote, request: "lnbc-fake", state: "PAID" };
  }

  async mintProofsBolt11(amount: number): Promise<Proof[]> {
    return [v4proof(amount, 900 + this.mintQuoteCalls)];
  }

  async checkProofsStates(
    proofs: Array<Pick<Proof, "secret" | "id">>,
  ): Promise<ProofState[]> {
    this.stateCalls++;
    if (this.opts.statesUnavailable) throw new Error("mint does not support NUT-07");
    const answer = proofs.map((p) => {
      const st = this.opts.states?.[p.secret] ?? "UNSPENT";
      return { Y: `Y-${p.secret}`, state: st as ProofState["state"], witness: null };
    });
    return this.opts.shortStates ? answer.slice(1) : answer;
  }
}

function mk(
  opts: FakeOpts = {},
  storeProofs: StoredProof[] = [proof(128, 1), proof(128, 2), proof(128, 3), proof(64, 4), proof(32, 5), proof(16, 6), proof(4, 7)],
) {
  const store = new MemoryProofStore();
  store.add(storeProofs);
  const wallet = new FakeWallet(opts);
  const w = new CashuLnWallet(
    { mintUrl: "https://mint.test", seed: new Uint8Array(32), dbPath: ":memory:" },
    { store, wallet },
  );
  return { w, store, wallet };
}

describe("CashuLnWallet on the v4 Wallet API", () => {
  test("balanceSats sums stored proofs", async () => {
    const { w } = mk();
    expect(await w.balanceSats()).toBe(500);
  });

  test("payInvoice melts and returns the preimage", async () => {
    const { w, store } = mk();
    const r = await w.payInvoice("lnbc100n1x");
    expect(r.preimage).toBe("pre-1");
    // All 500 submitted; the mint returns 300 change.
    expect(store.sum()).toBe(300);
  });

  test("payInvoice refuses when balance is short", async () => {
    const { w, store } = mk();
    store.removeBySecrets(store.all().map((p) => p.secret));
    store.add([proof(10, 99)]);
    await expect(w.payInvoice("lnbc100n1x")).rejects.toThrow(/insufficient cashu balance/);
  });

  test("payInvoice errors when the mint returns no preimage", async () => {
    const { w } = mk({ preimage: null });
    await expect(w.payInvoice("lnbc100n1x")).rejects.toThrow(/preimage/);
  });

  test("payInvoice stores v4 change with numeric amounts (no Amount objects in the store)", async () => {
    const { w, store } = mk({ change: [v4proof(300, 99)] });
    await w.payInvoice("lnbc100n1x");
    // If the Amount object leaked into the store, JSON round-trip (toJSON is a
    // string) would corrupt sum() into string concatenation.
    expect(store.sum()).toBe(300);
    expect(typeof store.all()[0].amount).toBe("number");
  });

  test("makeInvoice returns a BOLT11 and payment hash", async () => {
    const { w } = mk();
    const inv = await w.makeInvoice(42);
    expect(inv.bolt11).toBe("lnbc42n1fake");
    expect(inv.paymentHash).toBe("mq1");
  });

  test("fund mints and credits numeric-amount proofs", async () => {
    const { w, store } = mk();
    const r = await w.fund(200);
    expect(r.balanceSats).toBe(700); // 500 + 200
    expect(await w.balanceSats()).toBe(700);
    expect(typeof store.all()[0].amount).toBe("number");
  });

  test("payInvoice prunes mint-reported SPENT proofs before melting", async () => {
    const { w, store, wallet } = mk({ states: { s1: "SPENT", s4: "SPENT" } });
    const r = await w.payInvoice("lnbc100n1x");
    expect(r.preimage).toBe("pre-1");
    // The melt never sees s1/s4.
    const melted = wallet.melted[0].map((p) => p.secret);
    expect(melted).not.toContain("s1");
    expect(melted).not.toContain("s4");
    // ...and they are gone from the store (not spendable again).
    expect(store.all().map((p) => p.secret)).not.toContain("s1");
    expect(store.sum()).toBe(300); // 500 - 128(s1) - 64(s4) + 300 change - 108 melted
    expect(wallet.meltCalls).toBe(1);
    expect(wallet.stateCalls).toBeGreaterThanOrEqual(1);
  });

  test("payInvoice ignores a short NUT-07 answer (nothing pruned from bad evidence)", async () => {
    // slice(1) drops s1's UNSPENT; without the length guard, s2's SPENT would
    // be zipped onto s1 — pruning the wrong proof and keeping the dead one.
    const { w, store, wallet } = mk({ shortStates: true, states: { s2: "SPENT" } });
    const r = await w.payInvoice("lnbc100n1x");
    expect(r.preimage).toBe("pre-1");
    const melted = wallet.melted[0].map((p) => p.secret);
    expect(melted).toHaveLength(7); // nothing pruned from a malformed answer
    expect(melted).toContain("s1");
    expect(melted).toContain("s2");
    expect(store.sum()).toBe(300); // all 7 consumed, 300 change
  });

  test("payInvoice still melts when the NUT-07 check is unavailable (advisory, fail-open)", async () => {
    const { w, wallet } = mk({ statesUnavailable: true });
    const r = await w.payInvoice("lnbc100n1x");
    expect(r.preimage).toBe("pre-1");
    expect(wallet.meltCalls).toBe(1);
  });

  test("payInvoice does not treat NUT-07 PENDING as spent", async () => {
    const { w, wallet } = mk({ states: { s1: "PENDING" } });
    const r = await w.payInvoice("lnbc100n1x");
    expect(r.preimage).toBe("pre-1");
    expect(wallet.melted[0].map((p) => p.secret)).toContain("s1");
  });

  test("payInvoice refuses when everything is mint-reported SPENT (no melt attempted)", async () => {
    const { w, wallet } = mk({
      states: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`s${i}`, "SPENT"])),
    });
    await expect(w.payInvoice("lnbc100n1x")).rejects.toThrow(/insufficient cashu balance/);
    expect(wallet.meltCalls).toBe(0);
  });

  test("a melt failure (double spend at the mint) leaves the store intact", async () => {
    const { w, store, wallet } = mk({ meltFails: true });
    await expect(w.payInvoice("lnbc100n1x")).rejects.toThrow("already spent");
    expect(wallet.meltCalls).toBe(1);
    // Nothing removed: the melt is authoritative, and it said NO.
    expect(store.sum()).toBe(500);
    expect(store.all()).toHaveLength(7);
  });

  test("fund waits for the mint quote to be PAID", async () => {
    const { w } = mk();
    const r = await w.fund(200, { attempts: 2, intervalMs: 1 });
    expect(r.balanceSats).toBe(700);
  });
});
