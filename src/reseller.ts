import type { LnWallet } from "./lnwallet.ts";
import { walletFromEnv } from "./treasury-env.ts";
import { refuse } from "./refusals.ts";

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
 *
 * Honesty contract: with no wallet configured (`wallet` undefined — the only
 * supported no-rail state in production), every balance/spend question
 * refuses with `rail_unavailable`. A number is returned only when a real
 * wallet answered it; a fabricated balance is never reported.
 */
export class Treasury {
  private spentSats = 0;
  private earnedSats = 0;

  constructor(
    private readonly wallet: LnWallet | undefined,
    private readonly cfg: TreasuryConfig,
  ) {}

  async balanceSats(): Promise<number> {
    this.assertRail();
    return this.wallet!.balanceSats();
  }

  async canSpend(amountSats: number): Promise<boolean> {
    this.assertRail();
    const balance = await this.wallet!.balanceSats();
    return balance - amountSats >= this.cfg.floorSats;
  }

  async assertCanSpend(amountSats: number): Promise<void> {
    this.assertRail();
    const balance = await this.wallet!.balanceSats();
    if (balance - amountSats < this.cfg.floorSats) {
      throw new InsufficientTreasuryError("treasury_insufficient", {
        balanceSats: balance,
        requiredSats: amountSats,
        floorSats: this.cfg.floorSats,
      });
    }
  }

  /** True iff a real wallet rail is configured on this host. */
  get railConfigured(): boolean {
    return this.wallet !== undefined;
  }

  /** Refuse (never fabricate) when the rail is missing. */
  private assertRail(): void {
    if (!this.wallet) {
      refuse("rail_unavailable", { rail: "nwc" });
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
