import { describe, expect, test } from "bun:test";
import { costToClient, marginForMarkup, markupForMargin } from "./pricing.ts";

describe("margin math", () => {
  test("markup 0.25 shows 20% margin", () => {
    expect(marginForMarkup(0.25)).toBeCloseTo(0.2, 6);
  });
  test("21% displayed margin requires markup ~0.2658", () => {
    const m = markupForMargin(0.21);
    expect(markupForMargin(0.21)).toBeCloseTo(0.2658, 3);
    expect(marginForMarkup(m)).toBeCloseTo(0.21, 6);
  });
  test("rejects out-of-range margin", () => {
    expect(() => markupForMargin(1)).toThrow();
    expect(() => markupForMargin(-0.1)).toThrow();
  });
});

describe("costToClient", () => {
  test("applies markup and rounds up", () => {
    const p = costToClient(1000, { markup: 0.25, minSats: 1 });
    expect(p.priceSats).toBe(1250);
    expect(p.markupSats).toBe(250);
  });
  test("honours the min price floor", () => {
    const p = costToClient(1, { markup: 0.2, minSats: 10 });
    expect(p.priceSats).toBe(10);
  });
  test("honours a ceiling", () => {
    const p = costToClient(1000, { markup: 1, minSats: 1, maxSats: 1500 });
    expect(p.priceSats).toBe(1500);
  });
  test("rounding to 5 sats", () => {
    const p = costToClient(101, { markup: 0.1, minSats: 1, roundingSats: 5 });
    expect(p.priceSats).toBe(115); // 111.1 -> 115
  });
});
