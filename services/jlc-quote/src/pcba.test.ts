/**
 * pcba.test.ts — the honesty invariants of the deterministic sweep.
 *
 * Each invariant is enforced by a TEST plus a COUNTER-TEST proving the
 * assertion has teeth (see the service's four-invariant shape): a null-path
 * that cannot fail is decoration, and so is a monotonicity check that cannot
 * trip. The fixture is the real, sanitized hub-v9 break data.
 */
import { describe, expect, test } from "bun:test";
import {
  assertMonotonic,
  bandBoundaryQtys,
  buildQuotePcbaSweepTool,
  findCliffs,
  MATERIAL_UNIT_DELTA_USD,
  sweep,
  SWEEP_SOURCE,
  unitPriceAt,
  type BreakBand,
  type PartLine,
} from "./pcba.ts";

const FIX = new URL("../fixtures/", import.meta.url).pathname;

// The real hub v9 break tables (sanitized: {breaks, stock} only).
const RAW = JSON.parse(await Bun.file(`${FIX}lcsc_breaks_hub_v9.json`).text()) as Record<
  string,
  { breaks: BreakBand[]; stock: number }
>;

// Per-board counts from docs/fab/hub-v9/hub_v9_bom_pcba.csv (16 lines).
// Counts verified against the committed BOM (designator list per line).
// SS24 uses the C50645 listing (verified cheaper + mass stock vs the page's
// C78573 proposal at $1.42) — reconciliation recorded in the BOM mapping report.
const PER_BOARD: Record<string, number> = {
  C2980300: 1, // ESP32-S3-WROOM-1U   [U1]
  C125969: 1, // SX1280               [U4]
  C4153167: 1, // MAX-M10S            [U5]
  C15639: 1, // MS5611               [U6]
  C5142805: 1, // TPS7A02 LDO          [U7]
  C434808: 4, // U.FL                 [ANT1..ANT4]
  C15525: 1, // 10uF                 [C4]
  C15008: 1, // 100uF                [C_BULK]
  C1525: 1, // 100nF                [C_HF]
  C15195: 1, // 10nF                 [C_MON]
  C699107: 1, // BAT54W               [D1]
  C50645: 6, // SS24                 [D_BP1..4, D_HUB1..2]
  C25744: 2, // 10k                  [R_BAL1..2]
  C26083: 2, // 1M                   [R_DIV1..2]
  C25076: 1, // 100R                 [R_F1]
  C11906: 2, // 4.7M                 [R_MON1..2]
};

function hubParts(): PartLine[] {
  return Object.keys(RAW).map((lcsc) => ({
    lcsc,
    perBoard: PER_BOARD[lcsc] ?? 1,
    breaks: RAW[lcsc].breaks,
  }));
}

// The MEASURED pcb map: only quantities actually quoted on the page.
const PCB_MEASURED: Record<number, number> = { 5: 32.3, 10: 45.0, 20: 62.0 };

describe("t1: unitPriceAt returns the exact band price at boundaries", () => {
  const esp = RAW.C2980300.breaks; // [[1,9,5.7607],[10,29,4.955],[30,99,4.4787],[100,649,3.9943],[650,1299,3.7709],[1300,-1,3.6698]]

  test("9/10, 29/30, 99/100 boundary pairs", () => {
    expect(unitPriceAt(esp, 9)).toBe(5.7607);
    expect(unitPriceAt(esp, 10)).toBe(4.955);
    expect(unitPriceAt(esp, 29)).toBe(4.955);
    expect(unitPriceAt(esp, 30)).toBe(4.4787);
    expect(unitPriceAt(esp, 99)).toBe(4.4787);
    expect(unitPriceAt(esp, 100)).toBe(3.9943);
  });

  test("end = -1 is +infinity", () => {
    expect(unitPriceAt(esp, 5000)).toBe(3.6698);
  });
});

describe("t2 COUNTER-TEST: null when no band covers the quantity", () => {
  // A part whose first band starts at 100 (e.g. a reel-only listing).
  const reelOnly: BreakBand[] = [[100, 499, 1.0]];

  test("returns null for qty 50 — and a nearest-band impl WOULD have answered", () => {
    const got = unitPriceAt(reelOnly, 50);
    expect(got).toBeNull();
    // The counter-test: implement the WRONG thing (snap to the nearest band by
    // start quantity) and prove it RETURNS A NUMBER where we demand null. If
    // this ever stops producing a number, the counter-test has lost its teeth.
    const naiveNearest = (bands: BreakBand[], q: number): number =>
      [...bands].sort(
        (a, b) => Math.abs(a[0] - q) - Math.abs(b[0] - q),
      )[0][2];
    expect(typeof naiveNearest(reelOnly, 50)).toBe("number");
    expect(naiveNearest(reelOnly, 50)).toBe(1.0); // the fabricated answer we forbid
  });
});

describe("t3: hub at qty 5 reproduces the validated parts cost", () => {
  test("partsCostUsd ≈ 145.53 (±0.5) — cross-check vs page-measured $146.51", () => {
    const { points } = sweep({
      parts: hubParts(),
      fixedFeesUsd: 25,
      pcbUsdByQty: PCB_MEASURED,
      qtys: [5],
    });
    const p = points[0];
    expect(p.complete).toBe(true);
    // BOM-corrected counts: 145.51 parts at qty 5 (BAT54W x1, SS24 x6 — the
    // committed curve's 145.53 used BAT54W x4, a 4-cent error). Cross-check
    // against the page-measured $146.51 = 0.7%.
    expect(p.partsCostUsd).toBeGreaterThan(145.0);
    expect(p.partsCostUsd).toBeLessThan(146.0);
    expect(p.totalUsd).toBeCloseTo(202.33, 1);
  });
});

describe("t4: missing pcbUsdByQty entry => null total, incomplete", () => {
  test("qty 7 was never measured => totalUsd null, complete false", () => {
    const { points } = sweep({
      parts: hubParts(),
      fixedFeesUsd: 25,
      pcbUsdByQty: PCB_MEASURED,
      qtys: [5, 7],
    });
    const seven = points.find((p) => p.qty === 7)!;
    expect(seven.pcbUsd).toBeNull();
    expect(seven.totalUsd).toBeNull();
    expect(seven.complete).toBe(false);
    // parts are still reported — they're known
    expect(seven.partsCostUsd).toBeGreaterThan(0);
  });
});

describe("t5: findCliffs on the hub in 5..20", () => {
  test("qty-10 cliff groups the FIVE IC breaks; qty-13 is U.FL", () => {
    const cliffs = findCliffs({ parts: hubParts(), qtys: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] });
    const ten = cliffs.find((c) => c.qty === 10)!;
    expect(ten).toBeDefined();
    // The five ICs all break at M=10 with perBoard=1
    const codes = ten.perBoardTriggered.map((t) => t.lcsc).sort();
    expect(codes).toEqual(["C125969", "C15639", "C2980300", "C4153167", "C5142805"]);
    // exact deltas from the fixture bands
    expect(ten.unitDeltaUsd).toBeCloseTo(
      (4.955 - 5.7607) + (3.1217 - 3.2848) + (10.5818 - 10.8395)
        + (5.9368 - 6.7262) + (0.4942 - 0.5856),
      3,
    );
    expect(ten.material).toBe(true);

    const thirteen = cliffs.find((c) => c.qty === 13)!;
    expect(thirteen).toBeDefined();
    expect(thirteen.perBoardTriggered.map((t) => t.lcsc)).toEqual(["C434808"]);
    // U.FL perBoard=4, from 0.3605 to 0.2923 => 4 × −0.0682 = −0.2728
    expect(thirteen.unitDeltaUsd).toBeCloseTo(4 * (0.2923 - 0.3605), 4);
    expect(thirteen.material).toBe(false); // below the 0.50 threshold
  });

  test("no cliff reported outside the requested range", () => {
    const cliffs = findCliffs({ parts: hubParts(), qtys: [5, 10] });
    expect(cliffs.every((c) => c.qty > 5 && c.qty <= 10)).toBe(true);
    expect(cliffs.some((c) => c.qty === 10)).toBe(true);
    expect(cliffs.some((c) => c.qty === 13)).toBe(false);
  });
});

describe("t6 COUNTER-TEST: monotonicity verdict fails on doctored input", () => {
  test("a part whose price goes UP with quantity trips the verdict", () => {
    const evil: PartLine[] = [
      { lcsc: "C999999", perBoard: 1, breaks: [[1, 9, 1.0], [10, -1, 5.0]] },
    ];
    const { points } = sweep({
      parts: evil,
      fixedFeesUsd: 0,
      pcbUsdByQty: { 5: 10, 10: 10 },
      qtys: [5, 10],
    });
    const v = assertMonotonic(points);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("monotonicity_violated");
    expect(v.violations.length).toBeGreaterThan(0);
  });

  test("the REAL hub data passes", () => {
    const { points } = sweep({
      parts: hubParts(),
      fixedFeesUsd: 25,
      pcbUsdByQty: PCB_MEASURED,
      qtys: [5, 10, 20],
    });
    expect(assertMonotonic(points).ok).toBe(true);
  });
});

describe("t7: provenance is permanent", () => {
  test("isPageQuote false, source derived, basis names the inputs", () => {
    const { provenance } = sweep({
      parts: hubParts(),
      fixedFeesUsd: 25,
      pcbUsdByQty: PCB_MEASURED,
 qtys: [5],
    });
    expect(provenance.isPageQuote).toBe(false);
    expect(provenance.source).toBe(SWEEP_SOURCE);
    expect(provenance.basis).toContain("$25.00");
    expect(provenance.basis).toContain("5, 10, 20");
  });
});

describe("t8: the announce tag set is unchanged (no new tier tag)", () => {
  test("MATERIAL_UNIT_DELTA_USD is the documented tunable, not a magic number", () => {
    expect(MATERIAL_UNIT_DELTA_USD).toBe(0.5);
  });

  test("the tool's response shape carries no price when incomplete — end-to-end", () => {
    const tool = buildQuotePcbaSweepTool(
      () => RAW,
      () => PER_BOARD,
      { fixedFeesUsd: 25, pcbUsdByQty: PCB_MEASURED },
    );
    const out = tool.handler({ qtys: [5, 11] }, { caller: "test" }) as {
      points: { qty: number; totalUsd: number | null }[];
    };
    const five = out.points.find((p) => p.qty === 5)!;
    const eleven = out.points.find((p) => p.qty === 11)!;
    expect(five.totalUsd).not.toBeNull();
    expect(eleven.totalUsd).toBeNull(); // 11 has no measured pcb price
  });
});
