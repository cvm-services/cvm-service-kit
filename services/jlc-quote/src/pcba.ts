/**
 * pcba.ts — deterministic, browser-free PCBA quantity sweep.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * "What does this board cost per-unit at qty N?" used to be answered by driving
 * a quote page N times. But LCSC/JLC publishes per-part PRICE-BREAK tables via an
 * unauthenticated API, so the entire curve is exact integer arithmetic over
 * published bands. Cross-validated: deriving the hub v9 parts cost from break
 * tables at qty 5 gives $145.53 vs the page-measured $146.51 (0.7%).
 *
 * Every honesty invariant is a property of the returned SHAPE, not a convention:
 *
 *  - UNPRICED IS NULL, NEVER A GUESS — `unitPriceAt` returns null when no band
 *    covers the quantity, and any null anywhere makes the affected total null.
 *    No interpolation, no extrapolation, no nearest-band snapping.
 *  - NO INVENTED PCB LADDER — pcbUsd comes only from a caller-supplied MEASURED
 *    map {qty -> usd}. Missing entry => that qty is not complete.
 *  - MONOTONICITY IS A VERDICT, NOT A REPAIR — bad input data returns
 *    {ok:false, violations}, it is never silently reordered.
 *  - PERMANENT PROVENANCE — every result carries isPageQuote:false and
 *    source:"derived_from_lcsc_breaks". A derived number can never be mistaken
 *    for a page quote (see the $4.00 "Special Offer" trap in JLCPCB-QUOTE-FINDINGS).
 */
import type { Tool } from "../../../src/index.ts";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One price band: covers merchandise quantities [start, end]; end = -1 means +inf. */
export type BreakBand = readonly [number, number, number];

export interface PartLine {
  /** LCSC C-number, e.g. "C2980300". */
  lcsc: string;
  /** Count of this part per board (e.g. 4 for the U.FL connectors). */
  perBoard: number;
  /** Published price-break bands for the part. */
  breaks: readonly BreakBand[];
}

export interface SweepPoint {
  qty: number;
  /** Σ perBoard × unitPriceAt(breaks, qty). Always finite. */
  partsCostUsd: number;
  /** From the caller's measured map; null when this qty was never measured. */
  pcbUsd: number | null;
  fixedFeesUsd: number;
  /** null whenever ANY component is unknown — parts, pcb, or otherwise. */
  totalUsd: number | null;
  unitUsd: number | null;
  complete: boolean;
  /** LCSC codes with no published price at this qty (empty when complete). */
  unpricedParts: string[];
}

export interface CliffTrigger {
  lcsc: string;
  fromUsd: number;
  toUsd: number;
}

export interface Cliff {
  /** Board quantity at which the break takes effect. */
  qty: number;
  /** The part bands that break at this qty, with their price deltas. */
  perBoardTriggered: CliffTrigger[];
  /** Unit-price delta from qty-1 to this qty (negative = price drop). */
  unitDeltaUsd: number;
  /** true when |unitDeltaUsd| >= MATERIAL_UNIT_DELTA_USD. */
  material: boolean;
}

export interface MonotonicityVerdict {
  ok: boolean;
  reason?: "monotonicity_violated";
  violations: string[];
}

/** Tunable: a cliff "matters" when it moves the unit price by >= this many USD. */
export const MATERIAL_UNIT_DELTA_USD = 0.5;

export const SWEEP_SOURCE = "derived_from_lcsc_breaks" as const;

// ---------------------------------------------------------------------------
// Core arithmetic — pure, total on well-formed input, honest on gaps
// ---------------------------------------------------------------------------

/**
 * The exact band price covering `qty`, or null when NO published band covers it.
 *
 * INVARIANT: null means "no published price at this quantity". Callers MUST NOT
 * substitute a neighbouring band, interpolate or extrapolate. A nearest-band
 * answer here is how a fabricated price enters a real order decision.
 */
export function unitPriceAt(breaks: readonly BreakBand[], qty: number): number | null {
  for (const [start, end, price] of breaks) {
    if (qty >= start && (end === -1 || qty <= end)) return price;
  }
  return null;
}

/** All distinct board quantities at which some part band boundary lands. */
export function bandBoundaryQtys(parts: readonly PartLine[]): Set<number> {
  const s = new Set<number>();
  for (const p of parts) {
    for (const band of p.breaks) {
      const trigger = Math.ceil(band[0] / Math.max(1, p.perBoard));
      if (trigger >= 1) s.add(trigger);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

export interface SweepInput {
  parts: readonly PartLine[];
  /** Fixed order-level fees (setup/tooling/stencil), e.g. 25 for one side. */
  fixedFeesUsd: number;
  /** MEASURED pcb prices by qty. No entry => that qty is incomplete. Never invented. */
  pcbUsdByQty: Readonly<Record<number, number>>;
  qtys: readonly number[];
}

export function sweep(input: SweepInput): { points: SweepPoint[]; provenance: SweepProvenance } {
  const { parts, fixedFeesUsd, pcbUsdByQty, qtys } = input;

  const points: SweepPoint[] = qtys.map((qty) => {
    const unpricedParts: string[] = [];
    let partsCost = 0;
    for (const p of parts) {
      const unit = unitPriceAt(p.breaks, qty * p.perBoard);
      if (unit === null) {
        unpricedParts.push(p.lcsc);
        continue;
      }
      partsCost += p.perBoard * unit;
    }
    // partsCostUsd is the ORDER cost at this qty: merchandiseQty x unit price.
    const orderPartsCost = partsCost * qty;
    const partsKnown = unpricedParts.length === 0;
    const pcbUsd = Object.prototype.hasOwnProperty.call(pcbUsdByQty, qty)
      ? pcbUsdByQty[qty]
      : null;
    const complete = partsKnown && pcbUsd !== null;
    const totalUsd = complete ? orderPartsCost + pcbUsd! + fixedFeesUsd : null;
    return {
      qty,
      partsCostUsd: orderPartsCost,
      pcbUsd,
      fixedFeesUsd: fixedFeesUsd,
      totalUsd,
      unitUsd: complete ? totalUsd! / qty : null,
      complete,
      unpricedParts,
    };
  });

  return { points, provenance: sweepProvenance(input) };
}

// ---------------------------------------------------------------------------
// findCliffs — exact integer arithmetic over the break boundaries
// ---------------------------------------------------------------------------

export interface CliffInput {
  parts: readonly PartLine[];
  /** Ordered requested quantity range (min used as the comparison baseline). */
  qtys: readonly number[];
}

/**
 * Candidate quantity breakpoints with the measured unit-price delta at each.
 *
 * A part band starting at merchandise quantity M triggers at board qty
 * ceil(M / perBoard). Only qty within the requested range and > min(qtys) are
 * reported. No smoothing, no fitting — the deltas are exact band prices.
 */
export function findCliffs(input: CliffInput): Cliff[] {
  const { parts, qtys } = input;
  if (qtys.length < 2) return [];
  const qmin = Math.min(...qtys);
  const qmax = Math.max(...qtys);

  // qty -> triggers at that qty
  const byQty = new Map<number, CliffTrigger[]>();
  for (const p of parts) {
    const sorted = [...p.breaks].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const band = sorted[i];
      const triggerQty = Math.ceil(band[0] / Math.max(1, p.perBoard));
      if (triggerQty > qmin && triggerQty <= qmax) {
        const list = byQty.get(triggerQty) ?? [];
        list.push({ lcsc: p.lcsc, fromUsd: prev[2], toUsd: band[2] });
        byQty.set(triggerQty, list);
      }
  }
  }

  const cliffs: Cliff[] = [];
  for (const [qty, triggers] of byQty) {
    // Exact per-board parts delta: Σ perBoard × (to − from) for each trigger.
    let delta = 0;
    for (const t of triggers) {
      const p = parts.find((x) => x.lcsc === t.lcsc)!;
      delta += p.perBoard * (t.toUsd - t.fromUsd);
    }
    cliffs.push({
      qty,
      perBoardTriggered: triggers,
      unitDeltaUsd: round4(delta),
      material: Math.abs(delta) >= MATERIAL_UNIT_DELTA_USD,
    });
  }
  cliffs.sort((a, b) => a.qty - b.qty);
  return cliffs;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Monotonicity verdict — assert, never repair
// ---------------------------------------------------------------------------

/**
 * Totals must be non-decreasing in qty AND unit price non-increasing.
 * A violation is bad INPUT DATA and is reported as such, never silently fixed.
 */
export function assertMonotonic(points: readonly SweepPoint[]): MonotonicityVerdict {
  const violations: string[] = [];
  const complete = points.filter((p) => p.complete);
  for (let i = 1; i < complete.length; i++) {
    const a = complete[i - 1];
    const b = complete[i];
    if (b.qty <= a.qty) continue; // unordered input; ignore
    if (b.totalUsd! < a.totalUsd!) {
      violations.push(
        `total not non-decreasing: qty ${a.qty}=$${a.totalUsd} > qty ${b.qty}=$${b.totalUsd}`,
      );
    }
    if (b.unitUsd! > a.unitUsd! + 1e-9) {
      violations.push(
        `unit not non-increasing: qty ${a.qty}=$${a.unitUsd}/bd < qty ${b.qty}=$${b.unitUsd}/bd`,
      );
    }
  }
  return violations.length === 0
    ? { ok: true, violations: [] }
    : { ok: false, reason: "monotonicity_violated", violations };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export interface SweepProvenance {
  isPageQuote: false;
  source: typeof SWEEP_SOURCE;
  /** Human-readable basis: which fees and PCB prices were used. */
  basis: string;
}

export function sweepProvenance(input: SweepInput): SweepProvenance {
  const pcbQtys = Object.keys(input.pcbUsdByQty).map(Number).sort((a, b) => a - b);
  const pcbPart =
    pcbQtys.length === 0
      ? "no measured PCB prices supplied (all totals null)"
      : `measured PCB prices at qty ${pcbQtys.join(", ")}`;
  return {
    isPageQuote: false,
    source: SWEEP_SOURCE,
    basis: `Derived from published LCSC price-break tables. Parts: ${input.parts.length} lines. `
      + `Fixed fees: $${input.fixedFeesUsd.toFixed(2)}. ${pcbPart}. `
      + `NOT a page quote: excludes per-placement assembly fee and shipping unless stated.`,
  };
}

// ---------------------------------------------------------------------------
// Tool wiring
// ---------------------------------------------------------------------------

/**
 * The `quote_pcba_sweep` MCP tool. Pure: no browser, no network, no clock.
 */
export function buildQuotePcbaSweepTool(
  loadBreaks: () => Record<string, { breaks: BreakBand[]; stock: number }>,
  loadPerBoard: () => Record<string, number>,
  defaults: { fixedFeesUsd: number; pcbUsdByQty: Record<number, number> },
): Tool {
  return {
    definition: {
      name: "quote_pcba_sweep",
      description:
        "Deterministic PCBA quantity sweep from published LCSC price-break tables. "
        + "Pure arithmetic: no browser, no page quote. Returns per-qty parts/pcb/total "
        + "(null when any component is unpriced), cliff list with exact deltas, a "
        + "monotonicity verdict, and permanent provenance (isPageQuote:false).",
      inputSchema: {
        type: "Object",
        properties: {
          qtys: { type: "Array", items: { type: "number" } },
          fixedFeesUsd: { type: "number" },
          pcbUsdByQty: { type: "Object", additionalProperties: { type: "number" } },
        },
      },
    },
    handler: (args: Record<string, unknown>) => {
      const qtys = Array.isArray(args.qtys) && args.qtys.length
        ? (args.qtys as number[])
        : DEFAULT_QTYS;
      const fixedFeesUsd = typeof args.fixedFeesUsd === "number"
        ? args.fixedFeesUsd
        : defaults.fixedFeesUsd;
      const pcbUsdByQty = isRecord(args.pcbUsdByQty)
        ? (args.pcbUsdByQty as Record<string, unknown>)
        : defaults.pcbUsdByQty;
      const normalisedPcb: Record<number, number> = {};
      for (const [k, v] of Object.entries(pcbUsdByQty)) {
        if (typeof v === "number") normalisedPcb[Number(k)] = v;
      }

      const breaks = loadBreaks();
      const perBoard = loadPerBoard();
      const parts: PartLine[] = Object.keys(breaks).map((lcsc) => ({
        lcsc,
        perBoard: perBoard[lcsc] ?? 1,
        breaks: breaks[lcsc].breaks,
      }));

      const { points, provenance } = sweep({ parts, fixedFeesUsd, pcbUsdByQty: normalisedPcb, qtys });
      const cliffs = findCliffs({ parts, qtys });
      const monotonicity = assertMonotonic(points);
      return { points, cliffs, monotonicity, provenance };
    },
  };
}

const DEFAULT_QTYS = [5, 10, 15, 20];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
