/**
 * tools.test.ts — the tool layer, and the four honesty invariants end to end.
 *
 * The adapter is INJECTED, so every invariant is exercised without a browser.
 * Each invariant has a test AND a counter-test: a name is not evidence, and an
 * assertion that cannot fail is not a guarantee (cvm-service-development: "A
 * test named after an invariant is not evidence the invariant holds").
 */
import { describe, expect, test } from "bun:test";
import {
  assertNoNullNumbers,
  assembleQuote,
  buildJlcQuoteTools,
  dropAbsentNumbers,
  quoteFromRun,
  validateAndPrepare,
  type QuoteResponse,
} from "./tools.ts";
import { isRefusal, type BrowserRun, type Refusal } from "./types.ts";
import { QUANTITY_LIMITATION } from "./provenance.ts";

const FIX = new URL("../fixtures/", import.meta.url).pathname;
const read = (n: string) => Bun.file(FIX + n).text();

const NOW = "2026-10-13T23:00:00.000Z";

/** A response or refusal viewed as a bag, for "does this KEY exist at all" checks. */
const bag = (v: QuoteResponse | Refusal): Record<string, unknown> =>
  v as unknown as Record<string, unknown>;

function run(over: Partial<BrowserRun> = {}): BrowserRun {
  return {
    raw_text: "",
    url: "https://cart.jlcpcb.com/quote",
    authenticated: true,
    session_message: "",
    client_price_usd: null,
    client_error: "",
    error: "",
    ...over,
  };
}

async function adaptedRun(fixture: string, over: Partial<BrowserRun> = {}): Promise<BrowserRun> {
  return run({ raw_text: await read(fixture), ...over });
}

function toolByName(tools: ReturnType<typeof buildJlcQuoteTools>, name: string) {
  const t = tools.find((x) => x.definition.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

/** A recording fake adapter — proves whether the browser leg was entered. */
function fakeAdapter(log: string[], primary: string, over: Partial<BrowserRun> = {}) {
  return {
    async capture() {
      log.push("adapter.capture");
      return adaptedRun(primary, over);
    },
  };
}

describe("INVARIANT 1 — an expired/absent session is a VISIBLE refusal, never a price", () => {
  test("quoteFromRun refuses session_expired on a logged-out capture", async () => {
    const out = quoteFromRun(await adaptedRun("logged_out.txt"), { nowIso: NOW });
    expect(isRefusal(out)).toBe(true);
    if (!isRefusal(out)) throw new Error("unreachable");
    expect(out.reason).toBe("session_expired");
    expect(out.message).toContain("not signed in");
    expect(out.message).toContain("never a quote");
  });

  test("the refusal has EXACTLY three keys and nowhere to put a price", async () => {
    const out = quoteFromRun(await adaptedRun("logged_out.txt"), { nowIso: NOW });
    // Structural: a refusal that could carry a number is a refusal that will.
    expect(Object.keys(out).sort()).toEqual(["message", "reason", "refused"]);
    expect(Object.keys(out)).not.toContain("pcb_price_usd");
    const blob = JSON.stringify(out);
    expect(blob).not.toContain("pcb_price");
    expect(blob).not.toContain("32.3");
  });

  test("through the tool: a logged-out session is a refusal, not a crash and not a price", async () => {
    const calls: string[] = [];
    const tools = buildJlcQuoteTools({
      adapter: fakeAdapter(calls, "logged_out.txt"),
      prepareInput: () => ({
        prepared: {
          zipPath: "/home/c03rad0r/jlc-quote-inputs/hub_v9.zip",
          origin: "zip_path",
          ephemeral: false,
        },
      }),
    });
    const out = (await toolByName(tools, "quote").handler(
      { zip_path: "/home/c03rad0r/jlc-quote-inputs/hub_v9.zip" },
      { caller: "a".repeat(64) },
    )) as Record<string, unknown>;
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("session_expired");
    // The browser leg WAS entered (this is a session verdict, not a config one).
    expect(calls).toEqual(["adapter.capture"]);
  });

  test("there is no silent-empty or zero path: every failure mode is a refusal object", () => {
    const cases: BrowserRun[] = [
      run({ authenticated: false }), // logged out, no text at all
      run({ authenticated: true, error: "no X display" }), // browser leg failed
      run({ authenticated: true, raw_text: "   " }), // success but no text
      run({ authenticated: true, raw_text: "My Account\nCalculated Price\n" }), // no amount
    ];
    for (const c of cases) {
      const out = bag(quoteFromRun(c, { nowIso: NOW }));
      expect(out.refused).toBe(true);
      expect(typeof out.reason).toBe("string");
      expect(typeof out.message).toBe("string");
      // Never 0, never an empty object, never a price.
      expect(Object.keys(out).length).toBeGreaterThanOrEqual(3);
      expect(out.pcb_price_usd).toBeUndefined();
    }
  });

  test("a browser-leg FAILURE is never reported as an expired session", () => {
    // A REAL bug found on the live path: an empty run carries
    // `authenticated: false` (the safe default), so testing the session first
    // reported session_expired for a subprocess that never launched — a failure
    // wearing an honest refusal's clothes, sending the operator to re-login for
    // an environment problem.
    const broken = run({
      authenticated: false,
      error: "the capture subprocess printed no JSON report (exit 2)",
    });
    const brokenOut = bag(quoteFromRun(broken, { nowIso: NOW }));
    expect(brokenOut.reason).toBe("adapter_error");
    expect(brokenOut.reason).not.toBe("session_expired");

    // ...and with NO error and NO text the session is UNKNOWN, so the verdict is
    // still not "expired": we did not read a page, so we cannot claim to have
    // read a logged-out page.
    const silent = bag(quoteFromRun(run({ authenticated: false, raw_text: "" }), { nowIso: NOW }));
    expect(silent.reason).toBe("adapter_error");
    expect(String(silent.message)).toContain("UNKNOWN");

    // COUNTER-TEST: a session verdict IS reachable when a page was really read.
    const loggedOut = bag(
      quoteFromRun(run({ authenticated: false, raw_text: "Sign In\nProducts\n" }), { nowIso: NOW }),
    );
    expect(loggedOut.reason).toBe("session_expired");
  });

  test("COUNTER-TEST: an authenticated, priced capture IS NOT refused", async () => {
    // Teeth: "always refuse" would satisfy every assertion above.
    const out = bag(quoteFromRun(await adaptedRun("hub_v9_qty5.txt"), { nowIso: NOW }));
    expect(out.refused).toBeUndefined();
    expect(out.pcb_price_usd).toBe(32.3);
  });

  test("an unconfigured adapter refuses adapter_error and never invents a price", async () => {
    const tools = buildJlcQuoteTools({});
    const out = (await toolByName(tools, "quote").handler(
      { zip_path: "/home/c03rad0r/jlc-quote-inputs/hub_v9.zip" },
      { caller: "a".repeat(64) },
    )) as Record<string, unknown>;
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("adapter_error");
    expect(out.pcb_price_usd).toBeUndefined();
  });
});

describe("INVARIANT 2 — a price the page did not render is never reported", () => {
  test("the $4.00 trap is refused through the tool layer", async () => {
    const out = bag(quoteFromRun(await adaptedRun("hub_special_offer_trap.txt"), { nowIso: NOW }));
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("price_not_rendered");
    expect(JSON.stringify(out)).not.toContain("4.00");
  });

  test("a disagreement between two readers of the same page is a refusal", async () => {
    // The wrapped client's own reading arrives as evidence. If it disagrees with
    // the label-anchored read, one of them is wrong and neither is reported.
    const out = bag(
      quoteFromRun(await adaptedRun("hub_v9_qty5.txt", { client_price_usd: 4 }), { nowIso: NOW }),
    );
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("price_not_rendered");
    expect(String(out.message)).toContain("disagree");
    expect(out.pcb_price_usd).toBeUndefined();
  });

  test("COUNTER-TEST: agreement passes, and is recorded as positive evidence", async () => {
    const out = bag(
      quoteFromRun(await adaptedRun("hub_v9_qty5.txt", { client_price_usd: 32.3 }), {
        nowIso: NOW,
      }),
    );
    expect(out.refused).toBeUndefined();
    expect(out.pcb_price_usd).toBe(32.3);
    expect(out.client_cross_check_usd).toBe(32.3);
  });

  test("a non-positive price that DID anchor is refused by the soundness guard", () => {
    const out = bag(
      quoteFromRun(
        run({
          raw_text:
            "My Account\nDetected 2 layer board of 10x10mm(1x1 inches).\nPCB Qty\n5\n" +
            "Calculated Price\n$0.00\nShipping Estimate\n$1.00\n",
        }),
        { nowIso: NOW },
      ),
    );
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("price_not_rendered");
  });
});

describe("INVARIANT 3 — absent data is never emitted as a value/number", () => {
  test("a shipping row with no amount is ABSENT from the response, not null and not 0", async () => {
    const out = bag(quoteFromRun(await adaptedRun("hub_shipping_absent.txt"), { nowIso: NOW }));
    expect(out.refused).toBeUndefined();
    expect(out.pcb_price_usd).toBe(32.3);
    expect("shipping_usd" in out).toBe(false);
    expect(out.shipping_usd).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("30");
  });

  test("assembleQuote drops every null field and keeps the present ones", () => {
    const assembled = assembleQuote(
      {
        pcb_price_usd: 32.3,
        shipping_usd: null,
        qty: 5,
        layers: null,
        dimensions_mm: "115x103mm",
        weight_kg: 0.33,
      },
      { clientPriceUsd: null, capturedAt: NOW },
    );
    expect(Object.keys(assembled).sort()).toEqual([
      "captured_at",
      "dimensions_mm",
      "pcb_price_usd",
      "price_source",
      "qty",
      "quantity_limitation",
      "weight_kg",
    ]);
    // COUNTER-TEST: with the values present they DO appear, so the key set above
    // is the drop working and not the fields never being built.
    const full = assembleQuote(
      {
        pcb_price_usd: 32.3,
        shipping_usd: 23.36,
        qty: 5,
        layers: 4,
        dimensions_mm: "115x103mm",
        weight_kg: 0.33,
      },
      { clientPriceUsd: 32.3, capturedAt: NOW },
    );
    expect(Object.keys(full)).toContain("shipping_usd");
    expect(Object.keys(full)).toContain("layers");
    expect(Object.keys(full)).toContain("client_cross_check_usd");
  });

  test("dropAbsentNumbers removes null and undefined but keeps a legitimate 0", () => {
    const dropped = dropAbsentNumbers({
      a: null,
      b: undefined,
      c: 5,
      d: "x",
    } as Record<string, unknown>);
    expect(dropped).toEqual({ c: 5, d: "x" });
    expect(Object.keys(dropped)).not.toContain("a");
    expect(Object.keys(dropped)).not.toContain("b");
    // A real 0 is a value and survives the drop (whether it BELONGS in a price
    // field is a different guard's job; see assertNoNullNumbers).
    const zero = dropAbsentNumbers({ a: 0 } as Record<string, unknown>);
    expect(zero).toEqual({ a: 0 });
  });

  test("assertNoNullNumbers: catches a null field and a zero price, passes a real quote", () => {
    expect(assertNoNullNumbers({ shipping_usd: null })).toContain("absent-valued");
    expect(assertNoNullNumbers({ pcb_price_usd: 0 })).toContain("never zero");
    expect(assertNoNullNumbers({ pcb_price_usd: Number.NaN })).toContain("finite");
    // COUNTER-TEST: a healthy quote is not flagged, so the guard is not a
    // constant "always broken".
    expect(
      assertNoNullNumbers({ pcb_price_usd: 32.3, shipping_usd: 23.36, weight_kg: 0.33 }),
    ).toBeNull();
  });

  test("every priced response says the quantity limitation out loud", async () => {
    for (const f of ["hub_v9_qty5.txt", "wing_v9_qty5.txt"]) {
      const out = bag(quoteFromRun(await adaptedRun(f), { nowIso: NOW }));
      expect(out.quantity_limitation).toBe(QUANTITY_LIMITATION);
      expect(String(out.quantity_limitation)).toContain("page-default quantity (5) ONLY");
    }
  });
});

describe("the quantity gate — default only, or a VISIBLE refusal", () => {
  test("qty 5 (and an omitted qty) are accepted", async () => {
    const calls: string[] = [];
    const tools = buildJlcQuoteTools({ adapter: fakeAdapter(calls, "hub_v9_qty5.txt") });
    const t = toolByName(tools, "quote");
    for (const args of [
      { zip_path: "/home/c03rad0r/x.zip" },
      { zip_path: "/home/c03rad0r/x.zip", qty: 5 },
    ]) {
      const out = (await t.handler(args, { caller: "a".repeat(64) })) as Record<string, unknown>;
      expect(out.refused).toBeUndefined();
      expect(out.pcb_price_usd).toBe(32.3);
      expect(out.qty).toBe(5);
    }
    expect(calls).toEqual(["adapter.capture", "adapter.capture"]);
  });

  test("any other quantity is refused qty_unsupported BEFORE the browser leg runs", async () => {
    const calls: string[] = [];
    const tools = buildJlcQuoteTools({ adapter: fakeAdapter(calls, "hub_v9_qty5.txt") });
    const t = toolByName(tools, "quote");
    for (const qty of [10, 50, 0, -5, 4.5, Number.NaN, "100"]) {
      const out = (await t.handler(
        { zip_path: "/home/c03rad0r/x.zip", qty },
        { caller: "a".repeat(64) },
      )) as Record<string, unknown>;
      expect(out.refused).toBe(true);
      expect(out.reason).toBe("qty_unsupported");
      // THE POINT: no default-qty price is presented as a requested-qty price.
      expect(out.pcb_price_usd).toBeUndefined();
      expect(out.qty).toBeUndefined();
    }
    // Nothing was attempted, so no default-qty price could leak out.
    expect(calls).toEqual([]);
  });

  test("COUNTER-TEST: the qty gate is not a blanket refusal", async () => {
    const calls: string[] = [];
    const tools = buildJlcQuoteTools({ adapter: fakeAdapter(calls, "hub_v9_qty5.txt") });
    const ok = (await toolByName(tools, "quote").handler(
      { zip_path: "/home/c03rad0r/x.zip" },
      { caller: "a".repeat(64) },
    )) as Record<string, unknown>;
    expect(ok.refused).toBeUndefined();
    expect(calls.length).toBe(1);
  });
});

describe("the input seam — a malformed call is refused before any browser work", () => {
  test("no source, both sources, /tmp paths and bad base64 are each refused", () => {
    const bad: Record<string, unknown>[] = [
      {},
      { zip_path: "/home/c03rad0r/a.zip", zip_base64: "UEsDBA==" },
      { zip_path: "/tmp/a.zip" },
      { zip_base64: "not base64!!" },
    ];
    for (const args of bad) {
      const out = validateAndPrepare(args);
      expect("refusal" in out).toBe(true);
      if ("refusal" in out) expect(out.refusal.reason).toBe("input_invalid");
    }
    // COUNTER-TEST: a well-formed call passes the same function.
    const ok = validateAndPrepare({ zip_path: "/home/c03rad0r/a.zip" });
    expect("prepared" in ok).toBe(true);
    if ("prepared" in ok) expect(ok.prepared.origin).toBe("zip_path");
  });

  test("the adapter is never entered for a malformed call", async () => {
    const calls: string[] = [];
    const tools = buildJlcQuoteTools({ adapter: fakeAdapter(calls, "hub_v9_qty5.txt") });
    const out = (await toolByName(tools, "quote").handler({}, { caller: "a".repeat(64) })) as Record<
      string,
      unknown
    >;
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("input_invalid");
    expect(calls).toEqual([]);
  });
});

describe("the published tool surface", () => {
  test("no tool is priced: no priceSats, so no cap tag can be emitted", () => {
    const tools = buildJlcQuoteTools({});
    for (const t of tools) {
      expect((t.definition as { priceSats?: number }).priceSats).toBeUndefined();
    }
  });

  test("the tool schema mentions no credential-shaped field", () => {
    const tools = buildJlcQuoteTools({});
    const schema = JSON.stringify(tools.map((t) => t.definition.inputSchema));
    for (const forbidden of ["password", "token", "secret", "cookie", "phone", "email", "address"]) {
      expect(schema.toLowerCase()).not.toContain(forbidden);
    }
  });

  test("docs names the refusal list, the quantity limitation and the not-offered list", async () => {
    const tools = buildJlcQuoteTools({});
    const out = (await toolByName(tools, "docs").handler({}, { caller: "a".repeat(64) })) as Record<
      string,
      unknown
    >;
    expect(String(out.quantity_limitation)).toContain("qty_unsupported");
    expect(JSON.stringify(out.refusals)).toContain("session_expired");
    expect(JSON.stringify(out.not_offered)).toContain("no ordering");
  });
});
