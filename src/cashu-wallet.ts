import { CashuMint, CashuWallet, type Proof } from "@cashu/cashu-ts";
import type { LnWallet, MintedInvoice, PaymentReceipt } from "./lnwallet.ts";
import { SqliteProofStore, type ProofStore, type StoredProof } from "./proof-store.ts";

/** Minimal cashu-ts surface used here (injectable for tests). */
export interface CashuWalletLike {
  loadMint(): Promise<void>;
  createMeltQuote(invoice: string): Promise<CashuMeltQuote>;
  send(
    amount: number,
    proofs: Proof[],
  ): Promise<{ send: Proof[]; keep: Proof[] }>;
  meltProofs(
    quote: CashuMeltQuote,
    proofs: Proof[],
  ): Promise<{ quote: CashuMeltQuote; change: Proof[] }>;
  createMintQuote(amount: number, description?: string): Promise<{ quote: string; request: string; state: string }>;
}

export interface CashuMeltQuote {
  quote: string;
  amount: number;
  fee_reserve: number;
  state: string;
  payment_preimage: string | null;
  request?: string;
  unit?: string;
}

export interface CashuLnWalletConfig {
  mintUrl: string;
  /** 32/64-byte seed (Uint8Array) for deterministic secrets. Required in prod. */
  seed: Uint8Array;
  dbPath: string;
}

/**
 * Cashu-backed Lightning wallet: pays BOLT11 by melting ecash at the mint
 * (returning the preimage L402 needs), and mints BOLT11 quotes for refunds /
 * funding. Proofs persist in SQLite; use a dedicated wallet, single writer.
 */
export class CashuLnWallet implements LnWallet {
  private readonly store: ProofStore;
  private readonly wallet: CashuWalletLike;
  private loaded = false;

  constructor(
    private readonly cfg: CashuLnWalletConfig,
    deps: { store?: ProofStore; wallet?: CashuWalletLike } = {},
  ) {
    this.store = deps.store ?? new SqliteProofStore(cfg.dbPath);
    this.wallet =
      deps.wallet ??
      (new CashuWallet(new CashuMint(cfg.mintUrl), { bip39seed: cfg.seed } as any) as unknown as CashuWalletLike);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.wallet.loadMint();
      this.loaded = true;
    }
  }

  async payInvoice(bolt11: string): Promise<PaymentReceipt> {
    await this.ensureLoaded();
    const quote = await this.wallet.createMeltQuote(bolt11);
    const needed = quote.amount + quote.fee_reserve;
    const available = this.store.all() as unknown as Proof[];
    if (this.store.sum() < needed) {
      throw new Error(`insufficient cashu balance: have ${this.store.sum()}, need ${needed}`);
    }

    // Split the exact amount (low-level NUT-03 swap) and melt it.
    const { send, keep } = await this.wallet.send(needed, available);
    const res = await this.wallet.meltProofs(quote, send as unknown as Proof[]);
    const preimage = res.quote.payment_preimage;

    // All selected proofs were consumed by the swap; persist the remains.
    this.store.removeBySecrets(available.map((p) => p.secret));
    this.store.add(keep.map((p) => p as unknown as StoredProof));
    this.store.add((res.change ?? []).map((p) => p as unknown as StoredProof));

    if (!preimage) {
      throw new Error("mint did not return a preimage (backend cannot settle L402)");
    }
    return { preimage, feeSats: 0 };
  }

  async makeInvoice(sats: number, memo?: string): Promise<MintedInvoice> {
    await this.ensureLoaded();
    const q = await this.wallet.createMintQuote(sats, memo);
    return { bolt11: q.request, paymentHash: q.quote };
  }

  async balanceSats(): Promise<number> {
    return this.store.sum();
  }

  /** Credit proofs after a mint quote is paid (funding). */
  async creditMinted(proofs: Proof[]): Promise<void> {
    this.store.add(proofs.map((p) => p as unknown as StoredProof));
  }
}
