/**
 * The money invariants of the fiat settlement state machine (card t_89dcb160).
 *
 * These are the RED-first tests named in the card: concurrent calls cannot both
 * pass; a failed downstream action cannot be retried into a second attempt; a
 * restart does not restore a consumed intent; a replayed/captured request cannot
 * re-enter the adapter; one sats payment can produce at most one fiat attempt.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IntentConflictError,
  IntentTerminalError,
  MemoryIntentStore,
  orderHashOf,
  ProofReuseError,
  SqliteIntentStore,
  sha256Hex,
  type IntentBinding,
} from "./intent-store.ts";
import {
  assertFinalReceipt,
  cashuFinalReceipt,
  FiatSettlementMachine,
  lightningFinalReceipt,
  ReceiptMismatchError,
  verifyPreimage,
} from "./settlement.ts";
import {
  PaymentRequiredError,
  SettlementFailedError,
  SettlementInProgressError,
} from "./payment.ts";

const BINDING: IntentBinding = {
  tool: "card.pay_checkout",
  caller: "npub1owner",
  orderHash: orderHashOf({ url: "https://merchant.example/checkout", amount: "12.50" }),
  amountSats: 500,
  pmi: "bitcoin-cashu",
  quote: "cashu:https://mint.example:500",
  fiatCap: 12.5,
  fiatCurrency: "EUR",
};

/** A processor-final receipt for the binding above. */
const baseReceipt = () => ({
  pmi: BINDING.pmi,
  proofRef: "redeemed-proof-hash",
  amountSats: BINDING.amountSats,
  settledAt: 1,
});
const receipt = (over: Partial<ReturnType<typeof baseReceipt>> = {}) => ({
  ...baseReceipt(),
  ...over,
});

function mkStore(): { store: SqliteIntentStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "intent-machine-")), "intents.sqlite");
  return { store: new SqliteIntentStore(path), path };
}

const T = { timeout: 30_000 } as const;

/** Counts fiat attempts; can be told to fail like a real 3DS/decline would. */
class FiatLeg {
  attempts = 0;
  constructor(private readonly fail = false) {}
  async run(): Promise<string> {
    this.attempts++;
    if (this.fail) throw new Error("fiat leg declined by the merchant");
    return "fiat-ok";
  }
}

describe("exactly-once settlement", () => {
  test("one sats payment produces exactly one fiat attempt, and a replay re-runs nothing", async () => {
    const { store } = mkStore();
    const m = new FiatSettlementMachine(store);
    const leg = new FiatLeg();
    const args = {
      intentId: "i-1",
      binding: BINDING,
      proof: "cashu-token-A",
      settle: async () => receipt(),
      run: () => leg.run(),
    };
    expect(await m.run(args)).toBe("fiat-ok");
    // replayed/captured request with the same id: cached result, no second attempt
    expect(await m.run(args)).toBe("fiat-ok");
    expect(leg.attempts).toBe(1);
    expect(store.get("i-1")!.status).toBe("settled");
    store.close();
  }, T);

  test("concurrent callers: exactly one runs, the rest get settlement_in_progress", async () => {
    const store = new MemoryIntentStore();
    const m = new FiatSettlementMachine(store);
    const leg = new FiatLeg();
    const call = () =>
      m.run({
        intentId: "i-2",
        binding: BINDING,
        proof: "cashu-token-A",
        settle: async () => receipt(),
        run: () => leg.run(),
      });
    const results = await Promise.allSettled(Array.from({ length: 20 }, call));
    const ok = results.filter((r) => r.status === "fulfilled");
    const inProgress = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof SettlementInProgressError,
    );
    expect(ok.length).toBe(1);
    expect(inProgress.length).toBe(19);
    expect(leg.attempts).toBe(1);
  }, T);

  test("a downstream failure is TERMINAL: a retry re-throws and never re-runs", async () => {
    const { store } = mkStore();
    const escalations: string[] = [];
    const m = new FiatSettlementMachine(store, {
      escalate: ({ reason }) => {
        escalations.push(reason);
      },
    });
    const leg = new FiatLeg(true);
    const args = {
      intentId: "i-3",
      binding: BINDING,
      proof: "cashu-token-A",
      settle: async () => receipt(),
      run: () => leg.run(),
    };
    await expect(m.run(args)).rejects.toThrow("declined");
    expect(store.get("i-3")!.status).toBe("settlement_failed");
    // the sats are final, so a retry is refused before settle() is even called
    await expect(m.run(args)).rejects.toBeInstanceOf(SettlementFailedError);
    expect(leg.attempts).toBe(1);
    // and the failure escalated exactly once
    expect(escalations.length).toBe(1);
    store.close();
  }, T);
});

describe("binding: a replayed request may not re-enter the adapter", () => {
  test("same intent id, different caller/tool/amount/order: refused, no attempt", async () => {
    const { store } = mkStore();
    const m = new FiatSettlementMachine(store);
    const leg = new FiatLeg();
    await m.run({
      intentId: "i-4",
      binding: BINDING,
      proof: "cashu-token-A",
      settle: async () => receipt(),
      run: () => leg.run(),
    });
    expect(leg.attempts).toBe(1);

    for (const [field, bad] of [
      ["caller", { caller: "npub1mallory" }],
      ["tool", { tool: "card.pay" }],
      ["amountSats", { amountSats: 5 }],
      ["orderHash", { orderHash: orderHashOf({ url: "https://evil.example" }) }],
      ["fiatCap", { fiatCap: 999 }],
    ] as const) {
      await expect(
        m.run({
          intentId: "i-4",
          binding: { ...BINDING, ...bad },
          settle: async () => receipt(),
          run: () => leg.run(),
        }),
      ).rejects.toBeInstanceOf(IntentConflictError);
    }
    expect(leg.attempts).toBe(1);
    store.close();
  }, T);

  test("a smaller payment cannot fund a bigger intent (the amount is bound)", async () => {
    const { store } = mkStore();
    const m = new FiatSettlementMachine(store);
    const leg = new FiatLeg();
    // 100-sat intent created and left awaiting payment
    await expect(
      m.run({
        intentId: "i-5",
        binding: { ...BINDING, amountSats: 100 },
        settle: async () => undefined,
        run: () => leg.run(),
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    // The attack: same intent id, 500 sats requested. Refused, never attempted.
    await expect(
      m.run({
        intentId: "i-5",
        binding: BINDING,
        settle: async () => receipt(),
        run: () => leg.run(),
      }),
    ).rejects.toBeInstanceOf(IntentConflictError);
    expect(leg.attempts).toBe(0);
    expect(store.get("i-5")!.status).toBe("awaiting_payment");
    store.close();
  }, T);

  test("the same proof cannot settle two intents", async () => {
    const { store } = mkStore();
    const m = new FiatSettlementMachine(store);
    const leg = new FiatLeg();
    await m.run({
      intentId: "i-6a",
      binding: BINDING,
      proof: "cashu-token-A",
      settle: async () => receipt(),
      run: () => leg.run(),
    });
    await expect(
      m.run({
        intentId: "i-6b",
        binding: BINDING,
        proof: "cashu-token-A",
        settle: async () => receipt(),
        run: () => leg.run(),
      }),
    ).rejects.toBeInstanceOf(ProofReuseError);
    expect(leg.attempts).toBe(1);
    expect(store.get("i-6b")!.status).toBe("awaiting_payment");
    // the refusal rolled back the claim, so the proof was not double-consumed
    expect(store.proofSpentBy(sha256Hex("cashu-token-A"))).toBe("i-6a");
    store.close();
  }, T);

  test("a refused proof does not leak the proof itself into the intent table", async () => {
    const { store } = mkStore();
    const m = new FiatSettlementMachine(store);
    await m.run({
      intentId: "i-7",
      binding: BINDING,
      proof: "cashu-token-A",
      settle: async () => receipt(),
      run: async () => "ok",
    });
    expect(store.get("i-7")!.proofHash).toBe(sha256Hex("cashu-token-A"));
    expect(JSON.stringify(store.all())).not.toContain("cashu-token-A");
    store.close();
  }, T);
});

describe("restart safety", () => {
  test("a restart does not restore a consumed intent", async () => {
    const { store, path } = mkStore();
    const m = new FiatSettlementMachine(store);
    const leg = new FiatLeg();
    const args = {
      intentId: "i-8",
      binding: BINDING,
      proof: "cashu-token-A",
      settle: async () => receipt(),
      run: () => leg.run(),
    };
    expect(await m.run(args)).toBe("fiat-ok");
    store.close();

    const reopened = new SqliteIntentStore(path);
    const m2 = new FiatSettlementMachine(reopened);
    expect(await m2.run(args)).toBe("fiat-ok"); // cached result survives the restart
    expect(leg.attempts).toBe(1);
    reopened.close();
  }, T);

  test("a crash mid-action leaves a reserved intent that is NOT retryable", async () => {
    const { store, path } = mkStore();
    const m = new FiatSettlementMachine(store);
    const leg = new FiatLeg();
    // model a crash: claim the intent and reserve the proof, then never finish
    await expect(
      m.run({
        intentId: "i-9",
        binding: BINDING,
        proof: "cashu-token-A",
        settle: async () => receipt(),
        run: async () => {
          throw new Error("process died here");
        },
      }),
    ).rejects.toThrow("process died here");
    expect(store.get("i-9")!.status).toBe("settlement_failed");
    store.close();

    const reopened = new SqliteIntentStore(path);
    const m2 = new FiatSettlementMachine(reopened, {});
    await expect(
      m2.run({
        intentId: "i-9",
        binding: BINDING,
        proof: "cashu-token-A",
        settle: async () => receipt(),
        run: () => leg.run(),
      }),
    ).rejects.toBeInstanceOf(SettlementFailedError);
    expect(leg.attempts).toBe(0);

    // and even a hard crash (reserved, never finished) is non-retryable
    reopened.create({
      intentId: "i-10",
      ...BINDING,
      status: "settled_reserved",
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(
      m2.run({
        intentId: "i-10",
        binding: BINDING,
        settle: async () => receipt(),
        run: () => leg.run(),
      }),
    ).rejects.toBeInstanceOf(SettlementInProgressError);
    expect(leg.attempts).toBe(0);
    reopened.close();
  }, T);
});

describe("settled means a processor-confirmed FINAL receipt", () => {
  test("a cashu token that was only DECODED is not settled", async () => {
    const { store } = mkStore();
    const m = new FiatSettlementMachine(store);
    const leg = new FiatLeg();
    const token = "cashuB-localdecode-only";
    const proofHash = sha256Hex(token);
    // decode-only: the mint still reports the proofs UNSPENT
    const decoded = cashuFinalReceipt({
      amountSats: BINDING.amountSats,
      proofHash,
      mintReportedSpent: false,
    });
    expect(decoded).toBeUndefined();
    await expect(
      m.run({
        intentId: "i-11",
        binding: BINDING,
        proof: token,
        settle: async () => decoded,
        run: () => leg.run(),
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(leg.attempts).toBe(0);
    // ... and the proof was not consumed by the refused attempt
    expect(store.proofSpentBy(proofHash)).toBeUndefined();
    store.close();
  }, T);

  test("a cashu token the mint reports SPENT is settled", () => {
    const r = cashuFinalReceipt({
      amountSats: 500,
      proofHash: "h",
      mintReportedSpent: true,
      redeemedSats: 500,
    });
    expect(r?.amountSats).toBe(500);
    expect(r?.proofRef).toBe("h");
  }, T);

  test("lightning needs the preimage that hashes to the payment hash", () => {
    const preimage = "11".repeat(32);
    const paymentHash = sha256Hex(preimage);
    expect(verifyPreimage(preimage, paymentHash)).toBe(true);
    expect(verifyPreimage("22".repeat(32), paymentHash)).toBe(false);
    // decoding a BOLT11 gives the hash but not the preimage: no receipt
    expect(lightningFinalReceipt({ paymentHash, amountSats: 500 }, undefined)).toBeUndefined();
    // a forged preimage is refused too
    expect(
      lightningFinalReceipt({ paymentHash, amountSats: 500 }, { preimage: "22".repeat(32) }),
    ).toBeUndefined();
    const ok = lightningFinalReceipt({ paymentHash, amountSats: 500 }, { preimage });
    expect(ok?.proofRef).toBe(preimage);
  }, T);

  test("an underpaid or wrong-processor receipt is refused, not rounded", () => {
    expect(() => assertFinalReceipt(receipt({ amountSats: 499 }), BINDING)).toThrow(
      ReceiptMismatchError,
    );
    expect(() => assertFinalReceipt(receipt({ pmi: "lightning" }), BINDING)).toThrow(
      ReceiptMismatchError,
    );
    expect(() => assertFinalReceipt(receipt({ proofRef: "" }), BINDING)).toThrow(
      ReceiptMismatchError,
    );
    expect(() => assertFinalReceipt(receipt(), BINDING)).not.toThrow();
  }, T);

  test("a terminal refund is never re-run", async () => {
    const { store } = mkStore();
    const m = new FiatSettlementMachine(store);
    const leg = new FiatLeg();
    store.create({
      intentId: "i-12",
      ...BINDING,
      status: "refunded",
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(
      m.run({
        intentId: "i-12",
        binding: BINDING,
        settle: async () => receipt(),
        run: () => leg.run(),
      }),
    ).rejects.toBeInstanceOf(IntentTerminalError);
    expect(leg.attempts).toBe(0);
    store.close();
  }, T);
});
