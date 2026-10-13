/**
 * provenance.ts — the honest, code-carried description of this service.
 *
 * Written as a module rather than prose in the README because the same text has
 * to reach three places that must not drift: the tool response, the announcement
 * content, and the docs tool. A limitation stated in only one of them is a
 * limitation someone will not read.
 */
import type { RefusalReason } from "./types.ts";

/**
 * The quantity limitation, stated exactly where a caller will meet it.
 *
 * The wrapped client has no quantity parameter: it reads whatever quantity the
 * page defaults to. Making the Element-UI quantity widget (`#QtyDom >
 * span.qtySelect`, a TELEPORTED `ul.qty-select-list`, and a `Confirm` button that
 * starts disabled) actually change the quote was NOT solved, and three measured
 * traps are on record (docs/JLCPCB-QUOTE-FINDINGS.md): clicking text outside
 * `#QtyDom` hit the LAYERS option "10" and produced an impossible $268.60; the
 * option list is teleported out of `#QtyDom` so a scoped selector returns null
 * once it opens; `Confirm` is disabled until a selection and it was never
 * settled whether it is required at all.
 *
 * A wrong price is far worse than an honest refusal, so this service quotes at
 * the page default only and says so on every priced response.
 */
export const QUANTITY_LIMITATION =
  "QUANTITY: this service quotes at the page-default quantity (5) ONLY. It has no " +
  "quantity parameter and never presents a default-quantity price as a requested-quantity " +
  "price. A call for any other quantity is REFUSED with reason 'qty_unsupported'. " +
  "Multiplying a default-quantity price is not offered, because JLCPCB's setup fee is " +
  "per-design, its shipping is per-parcel and its build-time adders are not linear.";

/** What this service is, in the announcement and the docs. */
export const JLC_QUOTE_ABOUT =
  "Read-only JLCPCB instant PCB quote from a gerber zip: the price, shipping, quantity, " +
  "layers, board dimensions and weight that cart.jlcpcb.com actually rendered. Free, " +
  "no payment, no order placed, ever. Quotes at the page-default quantity (5) only.";

/** Where a published price came from — a label, named. */
export const PRICE_SOURCE = "calculated_price_label";

/**
 * The refusal catalogue, as data. Each entry says what the reason means and what
 * the caller can do, and a test asserts every `RefusalReason` is covered here so
 * a new refusal cannot be introduced without a stated remedy.
 */
export const REFUSAL_CATALOGUE: Record<RefusalReason, string> = {
  session_expired:
    "The JLCPCB session (the persistent Chrome profile) is not signed in. Nothing was " +
    "priced. Remedy: the operator re-bootstraps the profile; the caller retries later. " +
    "An expired session is NEVER a price.",
  price_not_rendered:
    "The quote page did not render an amount on the 'Calculated Price' row. The page also " +
    "carries Special Offer, build-time adder and coupon figures; none of them is the board " +
    "price, so none is reported. Remedy: retry (the SPA sometimes needs another attempt) " +
    "or inspect the saved snapshot.",
  qty_unsupported:
    "A quantity other than the page default (5) was requested. Automating the quantity " +
    "widget is not solved, so this service refuses rather than quoting the wrong quantity. " +
    "Remedy: call with no quantity, or with quantity 5.",
  input_invalid:
    "The call carried no gerber zip, two sources at once, an unreadable path, or invalid " +
    "base64. Remedy: send exactly one of 'zip_path' or 'zip_base64'.",
  adapter_error:
    "The browser leg failed for a reason other than an expired session (no X display, a " +
    "missing google-chrome, a dead profile directory, a page that never rendered). No price " +
    "is reported. Remedy: check the service's environment and retry.",
};

/** The refusal list, in the shape the announcement content and the docs tool carry. */
export const REFUSAL_LIST: string[] = Object.entries(REFUSAL_CATALOGUE).map(
  ([reason, text]) => `${reason}: ${text}`,
);

/** What this service positively does NOT do. Omission reads as "maybe". */
export const NOT_OFFERED: string[] = [
  "no ordering: this service never places, saves, submits or pays for an order; it uploads a gerber zip and reads the rendered quote",
  "no quantity automation: only the page-default quantity (5) is quoted; any other quantity is refused as 'qty_unsupported'",
  "no price arithmetic: no per-unit price is derived, no quantity is extrapolated, no currency is converted",
  "no price from a fallback label: the 'Special Offer' figure is never used as the board price, which is exactly how $4.00 was once reported for a $32.30 board",
  "no fabricated zero: a row that rendered no amount is reported as absent, never as 0",
  "no credentials in any response, log line or snapshot",
];
