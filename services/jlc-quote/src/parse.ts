/**
 * parse.ts — pure, browser-free reading of a JLCPCB quote-page capture.
 *
 * The entire honesty claim of this service lives in this file. JLCPCB exposes
 * no quote API, so the numbers are read out of the RENDERED TEXT of the quote
 * page. Every rule below exists because the naive version of it produced a
 * NUMBER THAT WAS WRONG WHILE LOOKING AUTHORITATIVE:
 *
 *  1. ANCHOR, NEVER SCAN. The page renders `Special Offer` as well as
 *     `Calculated Price`, plus build-time adders, coupons and assembly rows —
 *     all carrying `$` figures. An earlier reader took "the first `$` after
 *     `Calculated Price`" (equivalently: the last `$` on the page) and reported
 *     **$4.00 for a board actually priced $32.30** (docs/JLCPCB-QUOTE-FINDINGS.md).
 *     A capture is trusted only when the amount sits IMMEDIATELY after the
 *     label, separated by whitespace alone; where it does not, this module
 *     REFUSES (`price_not_rendered`) instead of reaching for the next `$` in
 *     the document. See `fixtures/hub_special_offer_trap.txt`, a real capture
 *     in which `Calculated Price` is rendered with NO adjacent amount and the
 *     only nearby figure, `$4.00`, belongs to `Special Offer`.
 *
 *     The `Special Offer` FALLBACK the wrapped client carries is deliberately
 *     NOT reproduced here. On a page whose `Calculated Price` row has not
 *     rendered, the `Special Offer` figure is precisely the number that lies,
 *     and a fallback is a promise to report it.
 *
 *  2. AN EXPIRED SESSION IS A VISIBLE REFUSAL. The verdict comes from the
 *     rendered header (`My Account`), never from a status code: `POST
 *     /checkLogin` answers HTTP 200 with `login.unlogin` while logged out, so
 *     a status code is not evidence. A capture with no header marker becomes
 *     `{refused: true, reason: "session_expired", message: ...}` — never a
 *     price, never 0, never a silently empty result.
 *
 *  3. ABSENT IS NOT ZERO. An optional row that renders with no amount yields
 *     `null`, and a `null` is never emitted as a value. The live page does this
 *     to `Shipping Estimate`: on a real run (2026-10-13) the wrapped client's
 *     "first money after the label" reader returned `shipping_usd: 30.00` from
 *     a page whose only `$30.00` is a COUPON amount. This module returns `null`
 *     for the same capture, and `fixtures/hub_shipping_absent.txt` is that
 *     capture verbatim.
 *
 * Nothing here imports Playwright, spawns a process or touches the network.
 */
import type { QuoteFields, Refusal, RefusalReason } from "./types.ts";

export type { QuoteFields, Refusal, RefusalReason } from "./types.ts";

/** The label the price MUST be read from (verified against live captures). */
export const PRICE_LABEL = "Calculated Price";
/** The optional shipping row. Its amount may legitimately be absent. */
export const SHIPPING_LABEL = "Shipping Estimate";
/** The quantity row. */
export const QTY_LABEL = "PCB Qty";
/** The rendered-header marker that means "this profile is signed in". */
export const AUTH_MARKER = "My Account";

/**
 * The quantity the page defaults to when nothing is selected, and the ONLY
 * quantity this service can quote (see QUANTITY_LIMITATION in contract.ts).
 */
export const DEFAULT_PAGE_QTY = 5;

/**
 * The board summary is a sentence, not a field:
 * "Detected 4 layer board of 115x103mm(4.528x4.055 inches)."
 */
export const DETECTED_RE =
  /Detected\s+(\d+)\s+layer\s+board\s+of\s+([0-9.]+)\s*x\s*([0-9.]+)\s*mm/;

/**
 * Board weight, anchored on the `Weight` ROW (and the kg unit) because the page
 * also carries "Outer Copper Weight" and "Inner Copper Weight" EARLIER in the
 * document — a bare label search for "Weight" returns the copper weight.
 */
export const BOARD_WEIGHT_RE = /Weight\s*\n?\s*([0-9]+(?:\.[0-9]+)?)\s*kg/;

/** A money amount: `$1,234.56` (the space after `$` is optional on the page). */
const MONEY_SRC = String.raw`\$\s?([0-9][0-9,]*(?:\.[0-9]+)?)`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toNumber(raw: string): number | null {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Money IMMEDIATELY after `label` — whitespace only in between.
 *
 * Deliberately strict. `moneyAnywhereAfterLabel` (what the wrapped client does)
 * is the bug this function exists to prevent; see the module header and the
 * counter-test in parse.test.ts, which reimplements the loose reader and
 * asserts it returns $4.00 / $30.00 on the same captures.
 */
export function moneyAfterLabel(text: string, label: string): number | null {
  const re = new RegExp(escapeRe(label) + String.raw`\s*` + MONEY_SRC);
  const m = re.exec(text);
  return m ? toNumber(m[1]) : null;
}

/** An integer row immediately after `label` — whitespace only in between. */
export function intAfterLabel(text: string, label: string): number | null {
  const re = new RegExp(escapeRe(label) + String.raw`\s*:?\s*([0-9][0-9,]*)`);
  const m = re.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isInteger(n) ? n : null;
}

/** True when the capture renders the signed-in header marker. */
export function sessionRendered(text: string): boolean {
  return text.includes(AUTH_MARKER);
}

/** Layers + "WxHmm" from JLCPCB's "Detected N layer board of WxHmm" sentence. */
export function detectedBoard(text: string): { layers: number; dimensions_mm: string } | null {
  const m = DETECTED_RE.exec(text);
  if (!m) return null;
  return { layers: Number(m[1]), dimensions_mm: `${m[2]}x${m[3]}mm` };
}

export type ParseOutcome = { refused: false; fields: QuoteFields } | Refusal;

/**
 * Read a quote-page capture.
 *
 * Order matters: authentication is decided FIRST, so a logged-out page can
 * never be mistaken for a page that merely failed to price.
 */
export function parseCapture(text: string): ParseOutcome {
  const body = typeof text === "string" ? text : "";

  if (body.trim().length === 0) {
    return {
      refused: true,
      reason: "price_not_rendered",
      message:
        "read a JLCPCB quote page: the capture was empty, so no price could be read. " +
        "Nothing is reported rather than a guess.",
    };
  }

  if (!sessionRendered(body)) {
    return {
      refused: true,
      reason: "session_expired",
      message:
        `read a JLCPCB quote page: the rendered header does not contain '${AUTH_MARKER}', ` +
        "so the browser profile is not signed in (expired or absent session). " +
        "No price is reported: an expired session is never a quote.",
    };
  }

  const price = moneyAfterLabel(body, PRICE_LABEL);
  if (price === null) {
    return {
      refused: true,
      reason: "price_not_rendered",
      message:
        `read a JLCPCB quote page: the '${PRICE_LABEL}' row rendered no amount immediately ` +
        "after its label, so there is no price to report. The page carries other `$` figures " +
        "(Special Offer, adders, coupons) and none of them is the board price, so none is used.",
    };
  }

  const board = detectedBoard(body);
  const shipping = moneyAfterLabel(body, SHIPPING_LABEL);
  const weightMatch = BOARD_WEIGHT_RE.exec(body);

  return {
    refused: false,
    fields: {
      pcb_price_usd: price,
      shipping_usd: shipping,
      qty: intAfterLabel(body, QTY_LABEL),
      layers: board ? board.layers : null,
      dimensions_mm: board ? board.dimensions_mm : null,
      weight_kg: weightMatch ? toNumber(weightMatch[1]) : null,
    },
  };
}

/**
 * Last-line soundness guard, run immediately before a value is published.
 *
 * A quote whose price is not a finite positive number is not a quote. `0` is
 * refused on purpose: a caller cannot tell "free" from "we failed to read it",
 * and `0` is exactly the shape a failed read takes once someone "helpfully"
 * defaults it.
 */
export function soundnessViolation(f: QuoteFields): string | null {
  if (!Number.isFinite(f.pcb_price_usd) || f.pcb_price_usd <= 0) {
    return `pcb_price_usd is not a finite positive number (got ${String(f.pcb_price_usd)})`;
  }
  for (const k of ["shipping_usd", "weight_kg"] as const) {
    const v = f[k];
    if (v !== null && (!Number.isFinite(v) || v <= 0)) {
      return `${k} is present but not a finite positive number (got ${String(v)})`;
    }
  }
  if (f.qty !== null && (!Number.isInteger(f.qty) || f.qty <= 0)) {
    return `qty is present but not a positive integer (got ${String(f.qty)})`;
  }
  return null;
}
