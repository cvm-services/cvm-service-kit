import {
  Amount,
  CheckStateEnum,
  type Proof,
  type ProofLike,
  type ProofState,
  Wallet,
} from "@cashu/cashu-ts";
import type { LnWallet, MintedInvoice, PaymentReceipt } from "./lnwallet.ts";
import { SqliteProofStore, type ProofStore, type StoredProof } from "./proof-store.ts";

/**
 * Minimal cashu-ts v4 `Wallet` surface used here (injectable for tests).
 *
 * v4 replaced the v2 client (`new CashuWallet(new CashuMint(...))`) with
 * `new Wallet(mintUrl, { unit, bip39seed })`, and the quote methods gained
 * per-method variants (`createMintQuoteBolt11` etc.). Quote `amount`s and
 * proof `amount`s are v4 `Amount` value objects, NOT numbers — the treasury
 * converts at the store boundary (see {@link toStoredProofs}).
 */
export interface CashuTreasuryWalletLike {
  loadMint(forceRefresh?: boolean): Promise<void>;
  createMeltQuoteBolt11(invoice: string): Promise<TreasuryMeltQuote>;
  meltProofsBolt11(
    quote: TreasuryMeltQuote,
    proofs: ProofLike[],
  ): Promise<{ quote: TreasuryMeltQuote; change: Proof[] }>;
  createMintQuoteBolt11(amount: number, description?: string): Promise<TreasuryMintQuote>;
  checkMintQuoteBolt11(quote: string): Promise<TreasuryMintQuote>;
  mintProofsBolt11(amount: number, quote: string | TreasuryMintQuote): Promise<Proof[]>;
  checkProofsStates(proofs: Array<Pick<ProofLike, "secret" | "id">>): Promise<ProofState[]>;
}

/** The v2 `CashuMintQuote`/`CashuMeltQuote` shapes, carried into v4 types. */
export interface TreasuryMintQuote {
  quote: string;
  request: string;
  state: string;
}

export interface TreasuryMeltQuote {
  quote: string;
  amount: Amount;
  fee_reserve: Amount;
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
 * v4 proof `amount` is an `Amount` value object whose JSON form is a *string*.
 * The proof store is numeric (SQLite `SUM(amount)`), so every proof entering
 * the store crosses this boundary. Proofs leaving the store for a melt need no
 * conversion: v4 accepts `ProofLike` (`AmountLike` amounts) and normalises
 * internally.
 */
function toStoredProofs(proofs: Proof[]): StoredProof[] {
  return proofs.map((p) => ({ ...p, amount: p.amount.toNumber() }));
}

/**
 * Cashu-backed Lightning wallet: pays BOLT11 by melting ecash at the mint
 * (returning the preimage L402 needs), and mints BOLT11 quotes for refunds /
 * funding. Proofs persist in SQLite; use a dedicated wallet, single writer.
 */
export class CashuLnWallet implements LnWallet {
  private readonly store: ProofStore;
  private readonly wallet: CashuTreasuryWalletLike;
  private loaded = false;

  constructor(
    private readonly cfg: CashuLnWalletConfig,
    deps: { store?: ProofStore; wallet?: CashuTreasuryWalletLike } = {},
  ) {
    this.store = deps.store ?? new SqliteProofStore(cfg.dbPath);
    this.wallet =
      deps.wallet ??
      (new Wallet(cfg.mintUrl, { unit: "sat", bip39seed: cfg.seed }) as unknown as CashuTreasuryWalletLike);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.wallet.loadMint();
      this.loaded = true;
    }
  }

  /**
   * Best-effort NUT-07 state lookup. Mints that do not implement NUT-07 (or a
   * transient state error) must not fail a legitimate melt, so an unusable
   * answer is logged and treated as "no evidence of a spend" — the melt below
   * stays the authoritative guard.
   *
   * v4 returns one state per input proof, in input order (the same zip
   * `groupProofsByState` performs), so states are paired with secrets by
   * index. A short answer (fewer states than proofs) is unusable evidence:
   * nothing is pruned from it.
   */
  private async findSpentSecrets(
    wallet: CashuTreasuryWalletLike,
    proofs: Array<Pick<ProofLike, "secret" | "id">>,
  ): Promise<Set<string>> {
    const spent = new Set<string>();
    try {
      const states = await wallet.checkProofsStates(proofs);
      if (states.length !== proofs.length) return spent;
      states.forEach((s, i) => {
        if (s.state === CheckStateEnum.SPENT) spent.add(proofs[i].secret);
      });
    } catch (e: any) {
      console.error(`[cashu] NUT-07 state check unavailable: ${e?.message ?? e}`);
    }
    return spent;
  }

  async payInvoice(bolt11: string): Promise<PaymentReceipt> {
    await this.ensureLoaded();
    const quote = await this.wallet.createMeltQuoteBolt11(bolt11);
    const needed = quote.amount.toNumber() + quote.fee_reserve.toNumber();
    // NUT-07 advisory: drop proofs the mint already reports as spent so the
    // melt is never fed (and the balance never counts) dead ecash. PENDING is
    // not a spend; an unavailable check melts with everything.
    const stored = this.store.all();
    const spentSecrets = await this.findSpentSecrets(this.wallet, stored as unknown as Array<Pick<ProofLike, "secret" | "id">>);
    const available = stored.filter((p) => !spentSecrets.has(p.secret));
    if (spentSecrets.size > 0) {
      this.store.removeBySecrets([...spentSecrets]);
    }
    console.error(
      `[cashu] melt quote: amount=${quote.amount} fee=${quote.fee_reserve} needed=${needed} have=${available.reduce((s, p) => s + p.amount, 0)} (pruned ${spentSecrets.size} mint-spent)`,
    );
    if (available.reduce((s, p) => s + p.amount, 0) < needed) {
      throw new Error(
        `insufficient cashu balance: have ${available.reduce((s, p) => s + p.amount, 0)}, need ${needed}`,
      );
    }

    // NUT-05: submit enough proofs and take the change. Passing a pre-split
    // exact sum fails when the input fee scales with proof count.
    const res = await this.wallet.meltProofsBolt11(quote, available as unknown as ProofLike[]);
    const preimage = res.quote.payment_preimage;
    console.error(`[cashu] melt: state=${res.quote.state} preimage=${preimage} change=${res.change?.length ?? 0}`);

    // All submitted proofs are consumed; persist the change.
    this.store.removeBySecrets(available.map((p) => p.secret));
    this.store.add(toStoredProofs(res.change ?? []));

    if (!preimage) {
      throw new Error("mint did not return a preimage (backend cannot settle L402)");
    }
    return { preimage, feeSats: 0 };
  }

  async makeInvoice(sats: number, memo?: string): Promise<MintedInvoice> {
    await this.ensureLoaded();
    const q = await this.wallet.createMintQuoteBolt11(sats, memo);
    return { bolt11: q.request, paymentHash: q.quote };
  }

  async balanceSats(): Promise<number> {
    return this.store.sum();
  }

  /** Credit proofs after a mint quote is paid (funding). */
  async creditMinted(proofs: Proof[]): Promise<void> {
    this.store.add(toStoredProofs(proofs));
  }

  /**
   * Create a mint quote, wait for it to be paid, mint the ecash and credit the
   * store. On a fakewallet mint the quote auto-pays, so this fully funds a
   * wallet without external Lightning. Returns the minted proofs.
   */
  async fund(
    amount: number,
    opts: { intervalMs?: number; attempts?: number } = {},
  ): Promise<{ proofs: Proof[]; balanceSats: number }> {
    await this.ensureLoaded();
    const q = await this.wallet.createMintQuoteBolt11(amount, "treasury funding");
    const interval = opts.intervalMs ?? 2000;
    const attempts = opts.attempts ?? 30;
    let last: TreasuryMintQuote = q;
    for (let i = 0; i < attempts; i++) {
      last = await this.wallet.checkMintQuoteBolt11(q.quote);
      if (last.state === "PAID" || last.state === "ISSUED") break;
      await new Promise((r) => setTimeout(r, interval));
    }
    if (last.state !== "PAID" && last.state !== "ISSUED") {
      throw new Error(`mint quote not paid (state=${last.state})`);
    }
    const proofs = await this.wallet.mintProofsBolt11(amount, last);
    this.creditMinted(proofs);
    return { proofs, balanceSats: this.store.sum() };
  }
}
