/**
 * tools.ts — the published MCP tool surface. One tool, `quote`.
 *
 * Every honesty invariant is enforced HERE as a property of the emitted shape,
 * not as a convention:
 *
 *  - INVARIANT 1 (an expired session is a VISIBLE refusal) — `quote` tests
 *    `run.authenticated` FIRST and returns a refusal object. It does not throw:
 *    a thrown error is unwrapped by the transport into a JSON-RPC error or a
 *    timeout, and a timeout reads like "still working". A refusal object is the
 *    shape a caller can print.
 *  - INVARIANT 2 (a price the page did not render is never reported) — the price
 *    comes only from `parseCapture`, which anchors on the `Calculated Price`
 *    label; the wrapped client's own reading arrives as
 *    `run.client_price_usd` and is CROSS-CHECKED, never used. A disagreement is
 *    a refusal, because the two readers disagreeing means neither is trusted.
 *  - INVARIANT 3 (absent data is never emitted as a value) — `assembleQuote`
 *    deletes every null field, and `assertNoNullNumbers` is a last-line guard
 *    that runs immediately before the value leaves the tool.
 *  - INVARIANT 4 (the announce contract) — see announce.ts; the tag set asserted
 *    there is the tag set this tool's server publishes.
 */
import { type Tool } from "../../../src/index.ts";
import type { JlcAdapter, PreparedInput } from "./adapter.ts";
import { DEFAULT_PAGE_QTY, parseCapture, soundnessViolation } from "./parse.ts";
import {
  NOT_OFFERED,
  PRICE_SOURCE,
  QUANTITY_LIMITATION,
  REFUSAL_LIST,
} from "./provenance.ts";
import { isRefusal, type BrowserRun, type QuoteFields, type Refusal } from "./types.ts";
import { buildQuotePcbaSweepTool } from "./pcba.ts";

/** Measured: JLCPCB charges a $25 setup fee per assembly side. */
export const DEFAULT_FIXED_FEES_USD = 25;

export interface JlcQuoteDeps {
  /** The browser leg. Omitted = unconfigured: the tool refuses, never invents. */
  adapter?: JlcAdapter;
  /** Materialise a gerber zip from a path or base64. Injected for tests. */
  prepareInput?: (args: Record<string, unknown>) => { prepared: PreparedInput } | { refusal: Refusal };
  /** Recording array the tests use to prove the adapter was (not) entered. */
  adapterCalls?: string[];
  /** Published break tables for the sweep, keyed by LCSC code. Omitted = empty. */
  loadBreaks?: () => Record<string, { breaks: [number, number, number][]; stock: number }>;
  /** Per-board counts for the sweep, keyed by LCSC code. */
  perBoardByLcsc?: Record<string, number>;
  /** Measured pcb prices by qty for the sweep. No entry => total null. */
  pcbUsdByQty?: Record<number, number>;
  /** Fixed order-level fees (setup/tooling). Measured: $25 per assembly side. */
  fixedFeesUsd?: number;
}

/**
 * The PUBLISHED response. Every optional field is optional-and-absent rather
 * than nullable: an absent key cannot be collapsed into a price by a careless
 * consumer, which is the whole point of invariant 3.
 */
export interface QuoteResponse {
  pcb_price_usd: number;
  shipping_usd?: number;
  qty: number;
  layers?: number;
  dimensions_mm?: string;
  weight_kg?: number;
  /** Where the number came from — a label, named. */
  price_source: string;
  /** Said on EVERY priced response, not buried in the docs. */
  quantity_limitation: string;
  /** The wrapped client's independent reading, when it produced one. */
  client_cross_check_usd?: number;
  captured_at: string;
}

// ---------------------------------------------------------------------------
// invariant 3: the emitting shape
// ---------------------------------------------------------------------------

/**
 * Build the PUBLISHED shape from parsed fields.
 *
 * Every null field is REMOVED, not forwarded. `{shipping_usd: null}` and
 * `{shipping_usd: 0}` are different sentences and a careless consumer collapses
 * them; an absent key cannot be collapsed into a price. Counter-tested in
 * tools.test.ts by emitting a `{shipping_usd: null, weight_kg: 2.5}` shape and
 * asserting the key set, plus by asserting a literal `0` shipping figure is
 * REJECTED (a zero is a failed read wearing a price's clothes).
 */
export function assembleQuote(
  f: QuoteFields,
  over: { clientPriceUsd: number | null; capturedAt: string },
): QuoteResponse {
  const draft: Partial<QuoteResponse> = {
    pcb_price_usd: f.pcb_price_usd,
    shipping_usd: f.shipping_usd ?? undefined,
    qty: f.qty ?? DEFAULT_PAGE_QTY,
    layers: f.layers ?? undefined,
    dimensions_mm: f.dimensions_mm ?? undefined,
    weight_kg: f.weight_kg ?? undefined,
    price_source: PRICE_SOURCE,
    quantity_limitation: QUANTITY_LIMITATION,
    captured_at: over.capturedAt,
  };
  if (over.clientPriceUsd !== null) draft.client_cross_check_usd = over.clientPriceUsd;
  return dropAbsentNumbers(draft) as QuoteResponse;
}

/** Remove every explicitly-null field. A null is not a value; it is an absence. */
export function dropAbsentNumbers<T extends object>(o: T): Partial<T> {
  const clean = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    clean[k] = v;
  }
  return clean as Partial<T>;
}

/**
 * Last-line guard: no field that IS present may be null/undefined/NaN, and no
 * present number may be `0` for a field where zero means "we failed to read it".
 * Runs immediately before the value leaves the tool.
 */
export function assertNoNullNumbers(o: object): string | null {
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) return `field '${k}' is present but absent-valued`;
    if (typeof v === "number" && !Number.isFinite(v)) return `field '${k}' is not a finite number`;
  }
  const rec = o as Record<string, unknown>;
  for (const k of ["pcb_price_usd", "shipping_usd", "weight_kg"]) {
    if (k in rec && typeof rec[k] === "number" && (rec[k] as number) <= 0) {
      return `field '${k}' is present as ${String(rec[k])}; a price-shaped field is never zero ` +
        "(a caller cannot tell 'free' from 'failed to read it')";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// the input seam
// ---------------------------------------------------------------------------

function refusal(reason: Refusal["reason"], message: string): Refusal {
  return { refused: true, reason, message };
}

/**
 * Decide what to read, from the call's own arguments — before any browser work.
 * Exactly one of `zip_path` / `zip_base64`. A malformed call is refused here and
 * the adapter is never entered (counter-tested in tools.test.ts: the recording
 * array must be empty).
 */
export function validateAndPrepare(
  args: Record<string, unknown>,
): { prepared: PreparedInput } | { refusal: Refusal } {
  const rawPath = typeof args.zip_path === "string" ? args.zip_path.trim() : "";
  const rawB64 = typeof args.zip_base64 === "string" ? args.zip_base64.trim() : "";

  if (!rawPath && !rawB64) {
    return {
      refusal: refusal(
        "input_invalid",
        "quote: called with no gerber zip. Send exactly one of 'zip_path' (a path on the " +
          "service host) or 'zip_base64' (the zip's bytes, base64). Nothing was attempted.",
      ),
    };
  }
  if (rawPath && rawB64) {
    return {
      refusal: refusal(
        "input_invalid",
        "quote: called with BOTH 'zip_path' and 'zip_base64'. Send exactly one; nothing was " +
          "attempted rather than guessing which one was meant.",
      ),
    };
  }
  if (rawPath && rawPath.startsWith("/tmp/")) {
    return {
      refusal: refusal(
        "input_invalid",
        `quote: 'zip_path' is under /tmp (${rawPath}), which is tmpfs and does not survive a ` +
          "reboot. Put the input outside /tmp. Nothing was attempted.",
      ),
    };
  }
  if (rawB64 && !/^[A-Za-z0-9+/=\s]+$/.test(rawB64)) {
    return {
      refusal: refusal(
        "input_invalid",
        "quote: 'zip_base64' is not valid base64. Nothing was attempted.",
      ),
    };
  }
  return {
    prepared: {
      zipPath: rawPath,
      origin: rawPath ? "zip_path" : "zip_base64",
      ephemeral: false,
    },
  };
}

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

/**
 * Run one quote and turn the browser run into either a price or a VISIBLE
 * refusal. Pure with respect to the adapter: everything after `capture()` is
 * decided from the returned evidence.
 */
export function quoteFromRun(run: BrowserRun, over: { nowIso: string }): QuoteResponse | Refusal {
  // ORDER MATTERS, and this order is the fix for a real bug in an earlier draft:
  // a browser-leg FAILURE (a missing script, a dead X server, a missing Chrome)
  // arrives with `authenticated: false`, because that is the safe default of an
  // empty run — so testing the session first reported "session_expired" for a
  // process that never even launched. That is a failure masquerading as an
  // honest refusal, which is its own kind of lie: it sends the operator to
  // re-login when the actual problem is the environment.
  //
  // A session verdict is only reachable when a page was ACTUALLY READ and lacked
  // the signed-in marker.
  if (run.error) {
    return refusal(
      "adapter_error",
      `quote: the browser leg failed before a quote could be read (${run.error}). No price ` +
        "is reported. Remedy: check the service environment (X display, Chrome path, profile " +
        "directory) and retry.",
    );
  }
  if (!run.raw_text.trim()) {
    return refusal(
      "adapter_error",
      "quote: the browser leg returned no page text at all, so nothing could be read and the " +
        "session state is UNKNOWN. No price is reported, and this is deliberately NOT reported " +
        "as an expired session — we cannot tell an expired session from a broken environment " +
        "when no page was read. Remedy: check the service environment and retry.",
    );
  }

  // INVARIANT 1 — a page WAS read and it does not render the signed-in header.
  if (!run.authenticated) {
    return refusal(
      "session_expired",
      "quote: the JLCPCB browser session is not signed in — the page that WAS read does not " +
        "render the signed-in header marker. No price is reported: an expired session is never " +
        "a quote." +
        (run.session_message ? ` Reported by the browser leg: ${run.session_message}.` : "") +
        " Remedy: the operator re-bootstraps the Chrome profile; retry after that.",
    );
  }

  const outcome = parseCapture(run.raw_text);
  if (outcome.refused) return outcome;

  // INVARIANT 2 — belt and braces. `parseCapture` already anchored on the label;
  // this refuses if the number it read is not a usable price at all.
  const violation = soundnessViolation(outcome.fields);
  if (violation) {
    return refusal(
      "price_not_rendered",
      `quote: the price read off the page is not a usable quote (${violation}). No price is ` +
        "reported. Remedy: retry, or inspect the saved snapshot.",
    );
  }

  // INVARIANT 2 — the cross-check. The wrapped client reads the page with a
  // looser rule ("first $ after the label"), so a DISAGREEMENT means at least one
  // reader is wrong and neither is trusted. Agreement is positive evidence.
  if (run.client_price_usd !== null && run.client_price_usd !== outcome.fields.pcb_price_usd) {
    return refusal(
      "price_not_rendered",
      "quote: two independent readings of the same page disagree " +
        `(label-anchored $${outcome.fields.pcb_price_usd} vs the wrapped client's ` +
        `$${run.client_price_usd}). One of them is wrong, so neither is reported. Remedy: ` +
        "retry; if it persists the page has changed and the parser needs a new capture.",
    );
  }

  const assembled = assembleQuote(outcome.fields, {
    clientPriceUsd: run.client_price_usd,
    capturedAt: over.nowIso,
  });
  const shapeProblem = assertNoNullNumbers(assembled);
  if (shapeProblem) {
    return refusal(
      "price_not_rendered",
      `quote: refusing to publish a malformed quote (${shapeProblem}). Nothing is reported ` +
        "rather than something a caller would have to second-guess.",
    );
  }
  return assembled;
}

/** The MCP tool definition + handler. */
export function buildJlcQuoteTools(deps: JlcQuoteDeps): Tool[] {
  const record = (n: string) => deps.adapterCalls?.push(n);

  const quote: Tool = {
    definition: {
      name: "quote",
      description:
        "Read-only JLCPCB instant PCB quote from a gerber zip. Send exactly one of " +
        "'zip_path' or 'zip_base64'. Returns pcb_price_usd, shipping_usd, qty, layers, " +
        "dimensions_mm and weight_kg as cart.jlcpcb.com actually rendered them. Quotes at " +
        "the page-default quantity (5) only; any other quantity is refused with reason " +
        "'qty_unsupported'. Never places an order. Free: no payment, no cap.",
      inputSchema: {
        type: "object",
        properties: {
          zip_path: {
            type: "string",
            description:
              "Path to a gerber zip on the service host (outside /tmp). Mutually exclusive " +
              "with zip_base64.",
          },
          zip_base64: {
            type: "string",
            description:
              "The gerber zip's bytes, base64-encoded. Mutually exclusive with zip_path.",
          },
          qty: {
            type: "number",
            description:
              `Only ${DEFAULT_PAGE_QTY} is supported (the page default). Any other value is ` +
              "refused with reason 'qty_unsupported': the quantity widget is not automated.",
          },
        },
      },
      // priceSats deliberately absent: this service is free (tier none) and must
      // therefore emit no `cap` tag (asserted in announce.test.ts).
    },
    handler: async (args: Record<string, unknown>, _ctx: { caller: string }) => {
      // The quantity gate is checked BEFORE any browser work. INVARIANT: a
      // requested quantity is either the default or a visible refusal — a
      // default-quantity price is never presented as a requested-qty price.
      const requested = args.qty === undefined ? DEFAULT_PAGE_QTY : Number(args.qty);
      if (!Number.isFinite(requested) || requested !== DEFAULT_PAGE_QTY) {
        return refusal(
          "qty_unsupported",
          `quote: requested quantity ${String(args.qty)} but this service quotes at the ` +
            `page-default quantity (${DEFAULT_PAGE_QTY}) ONLY. Automating JLCPCB's ` +
            "Element-UI quantity widget is not solved, so a default-quantity price is NOT " +
            "presented as a requested-quantity price. Remedy: retry with no 'qty', or with " +
            `qty ${DEFAULT_PAGE_QTY}.`,
        );
      }

      const decided: { prepared: PreparedInput } | { refusal: Refusal } = deps.prepareInput
        ? deps.prepareInput(args)
        : validateAndPrepare(args);

      if ("refusal" in decided) return decided.refusal;
      const prepared = decided.prepared;

      if (!deps.adapter) {
        return refusal(
          "adapter_error",
          "quote: no JLCPCB browser adapter is configured on this host, so no quote can be " +
            "read. Nothing is reported: the service does not invent a price when its rail is " +
            "absent. Remedy: the operator configures the Playwright venv, the Chrome profile " +
            "and the X display.",
        );
      }

      record("adapter.capture");
      const run = await deps.adapter.capture(prepared);
      return quoteFromRun(run, { nowIso: new Date().toISOString() });
    },
  };

  const docs: Tool = {
    definition: {
      name: "docs",
      description:
        "The contract for this service verbatim: what it is, what it is NOT, the refusal " +
        "list, the quantity limitation, and the environment it needs. Free.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: () => ({
      service: "cvm-jlc-quote",
      about:
        "Read-only JLCPCB gerber quote. Uploads a gerber zip to cart.jlcpcb.com and reports " +
        "the rendered price, shipping, quantity, layers, dimensions and weight.",
      class: "cvm:service:pcb-quote",
      tier: null,
      not_offered: NOT_OFFERED,
      quantity_limitation: QUANTITY_LIMITATION,
      refusals: REFUSAL_LIST,
      price_source: PRICE_SOURCE,
    }),
  };

  // The deterministic quantity sweep. Pure arithmetic over published LCSC
  // price-break tables: no browser, no network, no clock. Registered ALWAYS,
  // because it needs no adapter — and it never emits a total for a quantity
  // whose parts or PCB price are unknown (see pcba.ts invariants).
  const sweepTool = buildQuotePcbaSweepTool(
    () => deps.loadBreaks?.() ?? {},
    () => deps.perBoardByLcsc ?? {},
    {
      fixedFeesUsd: deps.fixedFeesUsd ?? DEFAULT_FIXED_FEES_USD,
      pcbUsdByQty: deps.pcbUsdByQty ?? {},
    },
  );

  return [quote, sweepTool, docs];
}
