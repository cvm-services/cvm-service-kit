import { describe, expect, test } from "bun:test";
import { Amount, type Proof, type ProofState, type Token } from "@cashu/cashu-ts";
import {
  CashuMintRedeemer,
  CashuProcessor,
  type CashuRedeemer,
  type CashuWalletLike,
} from "./cashu.ts";

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

/** A token as `wallet.decodeToken` returns it in v4: amounts are `Amount`s. */
function token(mint: string, amounts: number[], memo?: string): string {
  return JSON.stringify({
    mint,
    ...(memo ? { memo } : {}),
    proofs: amounts.map((a, i) => ({
      id: "00ad268c4d1f5826",
      amount: Amount.from(a),
      secret: `secret-${i}`,
      C: `C-${i}`,
    })),
  });
}

/** Stand-in for the v4 `Wallet`: no network, and every step is observable. */
class FakeWallet implements CashuWalletLike {
  loadCalls = 0;
  stateCalls = 0;
  receiveCalls = 0;

  constructor(
    private readonly opts: {
      /** NUT-07 verdict per proof index; default UNSPENT. */
      states?: Array<"UNSPENT" | "SPENT" | "PENDING">;
      /** Throw instead of answering, e.g. a mint without NUT-07. */
      statesUnavailable?: boolean;
      /** Throw from the swap, e.g. already-spent inputs at /v1/swap. */
      swapFails?: boolean;
    } = {},
  ) {}

  async loadMint(): Promise<void> {
    this.loadCalls++;
  }

  decodeToken(tokenString: string): Token {
    const raw = JSON.parse(tokenString) as { mint: string; proofs: Proof[]; memo?: string };
    return {
      mint: raw.mint,
      proofs: raw.proofs.map((p) => ({ ...p, amount: Amount.from(p.amount) })),
      ...(raw.memo ? { memo: raw.memo } : {}),
      unit: "sat",
    };
  }

  async receive(_token: string): Promise<Proof[]> {
    this.receiveCalls++;
    if (this.opts.swapFails) throw new Error("mint error: Token already spent (11001)");
    return [];
  }

  async checkProofsStates(proofs: Array<Pick<Proof, "secret" | "id">>): Promise<ProofState[]> {
    this.stateCalls++;
    if (this.opts.statesUnavailable) throw new Error("mint does not support NUT-07");
    const states = this.opts.states ?? proofs.map(() => "UNSPENT" as const);
    return proofs.map((p, i) => ({
      Y: `Y-${p.secret}`,
      state: states[i] ?? "UNSPENT",
      witness: null,
    }));
  }
}

/**
 * Test double for the default connect (`new Wallet(...)` + `loadMint()`): the
 * wallet is opened once and every redemption reuses it.
 */
function redeemerWith(
  wallet: CashuWalletLike,
  mintUrl = cfg.mintUrl,
): CashuMintRedeemer {
  return new CashuMintRedeemer(mintUrl, "sat", async () => {
    await wallet.loadMint();
    return wallet;
  });
}

describe("CashuMintRedeemer on the v4 Wallet API", () => {
  test("credits the token face value after one swap", async () => {
    const wallet = new FakeWallet();
    const r = redeemerWith(wallet);
    await expect(r.redeem(token(cfg.mintUrl, [8, 4]))).resolves.toBe(12);
    expect(wallet.loadCalls).toBe(1);
    expect(wallet.stateCalls).toBe(1);
    expect(wallet.receiveCalls).toBe(1);
  });

  test("decodes once per redemption and reuses one wallet", async () => {
    const wallet = new FakeWallet();
    const r = redeemerWith(wallet);
    await r.redeem(token(cfg.mintUrl, [1]));
    await r.redeem(token(cfg.mintUrl, [2]));
    expect(wallet.loadCalls).toBe(1);
    expect(wallet.receiveCalls).toBe(2);
  });

  test("refuses a token from another mint without swapping", async () => {
    const wallet = new FakeWallet();
    const r = redeemerWith(wallet);
    await expect(r.redeem(token("https://other.mint", [10]))).rejects.toThrow(
      "token mint https://other.mint != configured https://testnut.cashu.exchange",
    );
    expect(wallet.receiveCalls).toBe(0);
  });

  test("normalises mint URLs before comparing (trailing slash, host case)", async () => {
    const wallet = new FakeWallet();
    const r = redeemerWith(wallet, "https://TESTNUT.cashu.exchange/");
    await expect(r.redeem(token("https://testnut.cashu.exchange", [10]))).resolves.toBe(10);
    expect(wallet.receiveCalls).toBe(1);
  });

  test("refuses a mint-reported spend (NUT-07 SPENT) before swapping", async () => {
    const wallet = new FakeWallet({ states: ["UNSPENT", "SPENT"] });
    const r = redeemerWith(wallet);
    await expect(r.redeem(token(cfg.mintUrl, [8, 4]))).rejects.toThrow(
      "token already spent (NUT-07 SPENT for Y-secret-1)",
    );
    expect(wallet.receiveCalls).toBe(0);
  });

  test("does not treat NUT-07 PENDING as a spend", async () => {
    const wallet = new FakeWallet({ states: ["PENDING"] });
    const r = redeemerWith(wallet);
    await expect(r.redeem(token(cfg.mintUrl, [1]))).resolves.toBe(1);
    expect(wallet.receiveCalls).toBe(1);
  });

  test("still swaps when the NUT-07 check is unavailable", async () => {
    const wallet = new FakeWallet({ statesUnavailable: true });
    const r = redeemerWith(wallet);
    await expect(r.redeem(token(cfg.mintUrl, [21]))).resolves.toBe(21);
    expect(wallet.receiveCalls).toBe(1);
  });

  test("propagates a swap failure (double spend at the mint)", async () => {
    const wallet = new FakeWallet({ swapFails: true });
    const r = redeemerWith(wallet);
    await expect(r.redeem(token(cfg.mintUrl, [10]))).rejects.toThrow("already spent");
  });

  test("verify() is false when the mint reports the proofs spent", async () => {
    const wallet = new FakeWallet({ states: ["SPENT"] });
    const p = new CashuProcessor(cfg, redeemerWith(wallet));
    const inv = await p.createInvoice({ orderId: "o1", amountSats: 10 });
    expect(await p.verify(inv, token(cfg.mintUrl, [10]))).toBe(false);
    expect(wallet.receiveCalls).toBe(0);
  });

  test("verify() is true when a valid token swaps at the mint", async () => {
    const wallet = new FakeWallet();
    const p = new CashuProcessor(cfg, redeemerWith(wallet));
    const inv = await p.createInvoice({ orderId: "o1", amountSats: 10 });
    expect(await p.verify(inv, token(cfg.mintUrl, [10]))).toBe(true);
  });
});
