import { CashuMint, CashuWallet, getDecodedToken } from "@cashu/cashu-ts";
import type { Invoice, PaymentProcessor } from "./payment.ts";

/**
 * Redeems a Cashu token and returns the number of sats received. Abstracted so
 * the processor is unit-testable without a live mint.
 */
export interface CashuRedeemer {
  redeem(token: string): Promise<number>;
}

/** Redeems by swapping the token into a local wallet at the configured mint. */
export class CashuMintRedeemer implements CashuRedeemer {
  private wallet?: CashuWallet;

  constructor(
    private readonly mintUrl: string,
    private readonly unit = "sat",
  ) {}

  private async getWallet(): Promise<CashuWallet> {
    if (!this.wallet) {
      const wallet = new CashuWallet(new CashuMint(this.mintUrl), {
        unit: this.unit,
      } as any);
      await wallet.loadMint();
      this.wallet = wallet;
    }
    return this.wallet;
  }

  async redeem(token: string): Promise<number> {
    const decoded = getDecodedToken(token);
    if (decoded.mint && decoded.mint !== this.mintUrl) {
      throw new Error(`token mint ${decoded.mint} != configured ${this.mintUrl}`);
    }
    // Face value is what the token is worth; the mint's swap fee is the
    // server's cost, not a reason to under-credit the payer.
    const face = decoded.proofs.reduce(
      (s: number, p: { amount: number }) => s + p.amount,
      0,
    );
    const wallet = await this.getWallet();
    // `receive` swaps the token's proofs into the wallet: it spends them and
    // throws if they were already spent (double-spend / replay protection).
    await wallet.receive(token);
    return face;
  }
}

export interface CashuConfig {
  mintUrl: string;
  unit?: string;
}

/**
 * CEP-8 Cashu processor. The "invoice" tells the client which mint and amount
 * to pay; the client returns a Cashu token as the payment proof on the next
 * call, and `verify` redeems it.
 */
export class CashuProcessor implements PaymentProcessor {
  readonly pmi = "bitcoin-cashu";
  private readonly redeemer: CashuRedeemer;

  constructor(
    private readonly cfg: CashuConfig,
    redeemer?: CashuRedeemer,
  ) {
    this.redeemer =
      redeemer ?? new CashuMintRedeemer(cfg.mintUrl, cfg.unit ?? "sat");
  }

  async createInvoice(args: {
    orderId: string;
    amountSats: number;
  }): Promise<Invoice> {
    return {
      orderId: args.orderId,
      paymentHash: `cashu:${args.orderId}`,
      amountSats: args.amountSats,
      request: `cashu:${this.cfg.mintUrl}:${args.amountSats}`,
      pmi: this.pmi,
    };
  }

  async verify(invoice: Invoice, proof?: string): Promise<boolean> {
    if (!proof) return false;
    try {
      const sats = await this.redeemer.redeem(proof);
      console.error(`[cashu] redeemed ${sats} sats (need ${invoice.amountSats})`);
      return sats >= invoice.amountSats;
    } catch (e: any) {
      console.error(`[cashu] redeem failed: ${e?.message ?? e}`);
      return false;
    }
  }
}
