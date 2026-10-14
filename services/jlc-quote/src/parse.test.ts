/**
 * parse.test.ts — the parsing layer, against REAL captures.
 *
 * The fixtures are verbatim captures of live quote pages (see fixtures/README.md
 * for provenance, SHA-256 and capture commands). Do NOT edit a fixture to make a
 * test pass: re-capture instead. An earlier project hand-wrote a fixture to match
 * its parser and the whole suite passed while the parser was wrong.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PAGE_QTY,
  detectedBoard,
  intAfterLabel,
  moneyAfterLabel,
  parseCapture,
  PRICE_LABEL,
  sessionRendered,
  SHIPPING_LABEL,
  soundnessViolation,
} from "./parse.ts";

const FIX = new URL("../fixtures/", import.meta.url).pathname;
const read = (n: string) => Bun.file(FIX + n).text();

/**
 * THE BUG, REIMPLEMENTED — the wrapped client's own rule: find the label, then
 * take the FIRST `$` figure anywhere after it. This is not a straw man; it is
 * the shipped reader in `jlcpcb_client/parse.py`, and it is what reported $4.00
 * for a $32.30 board. Every "the assertion has teeth" claim in this file is
 * anchored on it.
 */
function looseReader(text: string, label: string): number | null {
  const idx = text.indexOf(label);
  if (idx < 0) return null;
  const m = /\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)/.exec(text.slice(idx));
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

describe("fixtures are real captures", () => {
  test("the two measured boards are present and authenticated", async () => {
    for (const f of ["hub_v9_qty5.txt", "wing_v9_qty5.txt"]) {
      const t = await read(f);
      expect(sessionRendered(t)).toBe(true);
      expect(t).toContain(PRICE_LABEL);
      expect(t).toContain(SHIPPING_LABEL);
    }
  });
});

describe("parseCapture — the measured quotes", () => {
  test("hub v9: $32.30, 5, 4 layers, 115x103mm, $23.36 DHL, 0.33 kg", async () => {
    const out = parseCapture(await read("hub_v9_qty5.txt"));
    expect(out.refused).toBe(false);
    if (out.refused) throw new Error("unreachable");
    expect(out.fields).toEqual({
      pcb_price_usd: 32.3,
      shipping_usd: 23.36,
      qty: 5,
      layers: 4,
      dimensions_mm: "115x103mm",
      weight_kg: 0.33,
    });
  });

  test("wing v9: $6.40, 2 layers, 25x184mm, $23.36 DHL, 0.20 kg", async () => {
    const out = parseCapture(await read("wing_v9_qty5.txt"));
    expect(out.refused).toBe(false);
    if (out.refused) throw new Error("unreachable");
    expect(out.fields).toEqual({
      pcb_price_usd: 6.4,
      shipping_usd: 23.36,
      qty: DEFAULT_PAGE_QTY,
      layers: 2,
      dimensions_mm: "25x184mm",
      weight_kg: 0.2,
    });
  });
});

describe("INVARIANT 2 — a price the page did not render is never reported", () => {
  test("the $4.00 trap: 'Calculated Price' with no adjacent amount is REFUSED", async () => {
    const t = await read("hub_special_offer_trap.txt");
    // The page really does carry a $4.00 figure, and it really is not the price.
    expect(t).toContain("Special Offer");
    expect(t).toContain("$4.00");

    const out = parseCapture(t);
    expect(out.refused).toBe(true);
    if (!out.refused) throw new Error("unreachable");
    expect(out.reason).toBe("price_not_rendered");
    expect(out.message).toContain(PRICE_LABEL);
    expect(JSON.stringify(out)).not.toContain("4.00");
  });

  test("...and removing the Special Offer figure does NOT change the verdict", async () => {
    // If the verdict came from the fallback label instead of from anchoring, then
    // deleting the only nearby `$` figure would change it. It does not.
    const t = (await read("hub_special_offer_trap.txt")).replace(/Special Offer\n\$4\.00/g, "");
    expect(t).not.toContain("Special Offer");
    const out = parseCapture(t);
    expect(out.refused).toBe(true);
    if (!out.refused) throw new Error("unreachable");
    expect(out.reason).toBe("price_not_rendered");
  });

  test("COUNTER-TEST: the loose reader DOES return $4.00 on the same capture", async () => {
    // Teeth: the assertion above is not vacuous — a reader that does not anchor
    // reports the wrong number on this exact evidence.
    const t = await read("hub_special_offer_trap.txt");
    expect(looseReader(t, PRICE_LABEL)).toBe(4);
    // ...and the anchored reader on the SAME capture with a price row rendered
    // reads the right number, so the refusal is about this capture, not about the
    // reader being broken.
    const hub = await read("hub_v9_qty5.txt");
    expect(looseReader(hub, PRICE_LABEL)).toBe(32.3);
    expect(moneyAfterLabel(hub, PRICE_LABEL)).toBe(32.3);
  });

  test("a label-anchored read that yields a non-positive price is refused", () => {
    // The guard, exercised directly: 0 is the shape a failed read takes once
    // someone "helpfully" defaults it.
    expect(soundnessViolation({
      pcb_price_usd: 0,
      shipping_usd: null,
      qty: 5,
      layers: 4,
      dimensions_mm: "1x1mm",
      weight_kg: null,
    })).toContain("finite positive");
    expect(soundnessViolation({
      pcb_price_usd: 1,
      shipping_usd: 0,
      qty: 5,
      layers: 4,
      dimensions_mm: "1x1mm",
      weight_kg: null,
    })).toContain("shipping_usd");
    // COUNTER-TEST: a real quote is NOT flagged, so the guard is not "always bad".
    expect(soundnessViolation({
      pcb_price_usd: 32.3,
      shipping_usd: 23.36,
      qty: 5,
      layers: 4,
      dimensions_mm: "115x103mm",
      weight_kg: 0.33,
    })).toBeNull();
  });

  test("anchoring is strict: text between the label and the amount is not the price", () => {
    const crafted =
      "My Account\nCalculated Price\nShipping Estimate\n$23.36\nTotal\n$99.99\n";
    // No amount immediately after `Calculated Price` -> refused, even though the
    // page is full of `$` figures.
    expect(moneyAfterLabel(crafted, PRICE_LABEL)).toBeNull();
    // COUNTER-TEST: put the amount where the page puts it and the same reader
    // finds it, so the strictness is about the anchor and not about the reader.
    const rendered = "My Account\nCalculated Price\n$32.30\nShipping Estimate\n$23.36\n";
    expect(moneyAfterLabel(rendered, PRICE_LABEL)).toBe(32.3);
  });
});

describe("INVARIANT 3 — absent data is never emitted as a value", () => {
  test("a Shipping Estimate row with no amount yields NULL, not a number", async () => {
    const t = await read("hub_shipping_absent.txt");
    // The capture is authenticated and priced, so the ONLY thing missing is the
    // shipping amount.
    expect(sessionRendered(t)).toBe(true);
    const out = parseCapture(t);
    expect(out.refused).toBe(false);
    if (out.refused) throw new Error("unreachable");
    expect(out.fields.pcb_price_usd).toBe(32.3);
    expect(out.fields.shipping_usd).toBeNull();
    expect(out.fields.shipping_usd).not.toBe(0);
  });

  test("COUNTER-TEST: the loose reader invents $30.00 on that same capture", async () => {
    // Teeth: the null above is a decision, not an accident. A reader that takes
    // the first `$` after the label harvests a COUPON amount and calls it shipping.
    const t = await read("hub_shipping_absent.txt");
    expect(looseReader(t, SHIPPING_LABEL)).toBe(30);
    expect(t).toContain("Save $30.00");
  });

  test("a missing board summary yields nulls for layers and dimensions", () => {
    const noSummary = "My Account\nCustom PCB\nPCB Qty\n5\nCalculated Price\n$12.50\n";
    const out = parseCapture(noSummary);
    expect(out.refused).toBe(false);
    if (out.refused) throw new Error("unreachable");
    expect(out.fields.pcb_price_usd).toBe(12.5);
    expect(out.fields.layers).toBeNull();
    expect(out.fields.dimensions_mm).toBeNull();

    // COUNTER-TEST: with the summary present, the same reader fills them in.
    expect(detectedBoard("Detected 4 layer board of 115x103mm(4.528x4.055 inches).")).toEqual({
      layers: 4,
      dimensions_mm: "115x103mm",
    });
    expect(detectedBoard("no summary here")).toBeNull();
  });

  test("the qty row is read from its own label, not guessed", () => {
    expect(intAfterLabel("PCB Qty\n5\nProduct Type", "PCB Qty")).toBe(5);
    expect(intAfterLabel("PCB Qty\n50\nProduct Type", "PCB Qty")).toBe(50);
    expect(intAfterLabel("nothing here", "PCB Qty")).toBeNull();
  });
});

describe("INVARIANT 1 — an expired/absent session is a VISIBLE refusal", () => {
  test("a logged-out capture is refused as session_expired, never a price", async () => {
    const out = parseCapture(await read("logged_out.txt"));
    expect(out.refused).toBe(true);
    if (!out.refused) throw new Error("unreachable");
    expect(out.reason).toBe("session_expired");
    expect(out.message).toContain("My Account");
    expect(out.message).toContain("read a JLCPCB quote page");
    expect(JSON.stringify(out)).not.toContain("pcb_price_usd");
  });

  test("COUNTER-TEST: an authenticated, priced capture is NOT refused", async () => {
    // Teeth: the refusal above is conditioned on the session, not returned for
    // everything. Without this, "always refuse" would pass every test above.
    const out = parseCapture(await read("hub_v9_qty5.txt"));
    expect(out.refused).toBe(false);
    expect(sessionRendered(await read("logged_out.txt"))).toBe(false);
    expect(sessionRendered(await read("hub_v9_qty5.txt"))).toBe(true);
  });

  test("an empty capture is refused, not read as a zero", () => {
    const out = parseCapture("");
    expect(out.refused).toBe(true);
    if (!out.refused) throw new Error("unreachable");
    expect(out.reason).toBe("price_not_rendered");
    expect(out.message).toContain("empty");
  });
});
