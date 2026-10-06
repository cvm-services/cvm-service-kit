import type { LnWallet } from "./lnwallet.ts";

/** Thrown when the treasury cannot cover an upstream spend (fail closed). */
export class InsufficientTreasuryError extends Error {
  readonly code = -32003;
  constructor(message: string, readonly data: { balanceSats: number; requiredSats: number; floorSats: number }) {
    super(message);
    this.name = "InsufficientTreasuryError";
  }
}

export interface TreasuryConfig {
  /** Never let the balance fall below this (refuse rather than overdraft). */
  floorSats: number;
}

/**
 * Guards upstream spending so a reseller never sells a service it cannot pay
 * for. `assertCanSpend` must be called before creating an upstream order.
 */
export class Treasury {
  private spentSats = 0;
  private earnedSats = 0;

  constructor(
    private readonly wallet: LnWallet,
    private readonly cfg: TreasuryConfig,
  ) {}

  async balanceSats(): Promise<number> {
    return this.wallet.balanceSats();
  }

  async canSpend(amountSats: number): Promise<boolean> {
    const balance = await this.wallet.balanceSats();
    return balance - amountSats >= this.cfg.floorSats;
  }

  async assertCanSpend(amountSats: number): Promise<void> {
    const balance = await this.wallet.balanceSats();
    if (balance - amountSats < this.cfg.floorSats) {
      throw new InsufficientTreasuryError("treasury_insufficient", {
        balanceSats: balance,
        requiredSats: amountSats,
        floorSats: this.cfg.floorSats,
      });
    }
  }

  recordSpend(sats: number): void {
    this.spentSats += sats;
  }

  recordEarn(sats: number): void {
    this.earnedSats += sats;
  }

  reconciliation(): { spentSats: number; earnedSats: number; netSats: number } {
    return {
      spentSats: this.spentSats,
      earnedSats: this.earnedSats,
      netSats: this.earnedSats - this.spentSats,
    };
  }
}
