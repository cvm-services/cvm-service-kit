/**
 * CEP-8 Cashu processor, built on `@cashu/cashu-ts` v4.
 *
 * v4 replaced the v2 surface this module used (`CashuMint` / `CashuWallet` /
 * the free `getDecodedToken`): the client is now `Mint` + `Wallet`, token
 * decoding resolves short keyset ids against the wallet's own keychain
 * (`wallet.decodeToken`), proof amounts are `Amount` values and NUT-07 state
 * lives on `wallet.checkProofsStates`. The processor contract is unchanged:
 * `invoice()` names the mint and the amount, `verify()` is false without a
 * proof, underpaid, or on a double spend.
 */
import {
  CheckStateEnum,
  normalizeMintUrl,
  type Proof,
  type ProofState,
  sumProofs,
  type Token,
  Wallet,
} from "@cashu/cashu-ts";
import type { Invoice, PaymentProcessor } from "./payment.ts";

/**
 * Redeems a Cashu token and returns the number of sats received. Abstracted so
 * the processor is unit-testable without a live mint.
 */
export interface CashuRedeemer {
  redeem(token: string): Promise<number>;
}

/**
 * The slice of the v4 `Wallet` the redeemer actually uses. Declaring it here
 * keeps the redemption path (decode → NUT-07 state check → swap) testable
 * without a live mint; a real `Wallet` satisfies it structurally.
 */
export interface CashuWalletLike {
  loadMint(forceRefresh?: boolean): Promise<void>;
  decodeToken(token: string): Token;
  receive(token: string): Promise<Proof[]>;
  checkProofsStates(proofs: Array<Pick<Proof, "secret" | "id">>): Promise<ProofState[]>;
}

/** Opens and initialises a wallet (mint info + keysets) for the given mint. */
export type CashuWalletFactory = (mintUrl: string, unit: string) => Promise<CashuWalletLike>;

const connectWallet: CashuWalletFactory = async (mintUrl, unit) => {
  const wallet = new Wallet(mintUrl, { unit });
  await wallet.loadMint();
  return wallet;
};

/** Redeems by swapping the token into a local wallet at the configured mint. */
export class CashuMintRedeemer implements CashuRedeemer {
  private wallet?: Promise<CashuWalletLike>;

  constructor(
    private readonly mintUrl: string,
    private readonly unit = "sat",
    private readonly connect: CashuWalletFactory = connectWallet,
  ) {}

  private getWallet(): Promise<CashuWalletLike> {
    this.wallet ??= this.connect(this.mintUrl, this.unit);
    return this.wallet;
  }

  async redeem(token: string): Promise<number> {
    const wallet = await this.getWallet();
    // v4 resolves the token's short keyset ids against the wallet's keychain.
    const decoded = wallet.decodeToken(token);
    const tokenMint = normalizeMintUrl(decoded.mint);
    const configuredMint = normalizeMintUrl(this.mintUrl);
    if (tokenMint !== configuredMint) {
      throw new Error(`token mint ${tokenMint} != configured ${configuredMint}`);
    }
    // Face value is what the token is worth; the mint's swap fee is the
    // server's cost, not a reason to under-credit the payer.
    const face = sumProofs(decoded.proofs).toNumber();
    // NUT-07 pre-flight: a mint reporting SPENT has already had these proofs
    // swapped away, so a replay is refused before we spend a swap on it. The
    // swap below stays the authoritative guard — NUT-07 answers can be stale or
    // (per NUT-07) unreliable — so this check may refuse early, never accept.
    const spent = await this.findSpentProof(wallet, decoded.proofs);
    if (spent) throw new Error(`token already spent (NUT-07 SPENT for ${spent.Y})`);
    // `receive` swaps the token's proofs into the wallet: it spends them and
    // throws if they were already spent (double-spend / replay protection).
    await wallet.receive(token);
    return face;
  }

  /**
   * Best-effort NUT-07 state lookup. Mints that do not implement NUT-07 (or a
   * transient state error) must not fail a legitimate redemption, so an
   * unusable answer is logged and treated as "no evidence of a double spend".
   */
  private async findSpentProof(
    wallet: CashuWalletLike,
    proofs: Proof[],
  ): Promise<ProofState | undefined> {
    try {
      const states = await wallet.checkProofsStates(
        proofs.map((p) => ({ secret: p.secret, id: p.id })),
      );
      return states.find((s) => s.state === CheckStateEnum.SPENT);
    } catch (e: any) {
      console.error(`[cashu] NUT-07 state check unavailable: ${e?.message ?? e}`);
      return undefined;
    }
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
