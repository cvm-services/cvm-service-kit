/**
 * Reseller pricing.
 *
 * IMPORTANT (measured fleet pitfall): `markup` is applied on the COST, so the
 * *displayed* margin is `markup / (1 + markup)`. To show a target margin X%,
 * set `markup = X / (100 - X)`.
 */
export interface PricingConfig {
  /** Fractional markup on cost, e.g. 0.25 = 25% on top of cost. */
  markup: number;
  /** Client-price floor in sats. */
  minSats: number;
  /** Optional client-price ceiling in sats (safety valve). */
  maxSats?: number;
  /** Round the client price up to a multiple of this. Default 1. */
  roundingSats?: number;
}

export interface Priced {
  costSats: number;
  priceSats: number;
  markupSats: number;
  margin: number;
}

/** Convert a desired displayed margin into the markup that produces it. */
export function markupForMargin(displayedMargin: number): number {
  if (displayedMargin < 0 || displayedMargin >= 1) {
    throw new Error("displayedMargin must be in [0,1)");
  }
  return displayedMargin / (1 - displayedMargin);
}

/** The displayed margin a given markup yields. */
export function marginForMarkup(markup: number): number {
  return markup / (1 + markup);
}

export function costToClient(costSats: number, cfg: PricingConfig): Priced {
  if (costSats < 0) throw new Error("costSats must be >= 0");
  const rounding = cfg.roundingSats && cfg.roundingSats > 0 ? cfg.roundingSats : 1;
  let price = costSats * (1 + cfg.markup);
  price = Math.ceil(price / rounding) * rounding;
  price = Math.max(price, cfg.minSats);
  if (cfg.maxSats !== undefined) price = Math.min(price, cfg.maxSats);
  return {
    costSats,
    priceSats: price,
    markupSats: price - costSats,
    margin: marginForMarkup(cfg.markup),
  };
}
