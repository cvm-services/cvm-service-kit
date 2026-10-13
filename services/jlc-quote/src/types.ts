/**
 * types.ts — shared shapes for the jlc-quote service.
 *
 * A refusal is DATA, not an exception, and it carries EXACTLY three fields.
 * That exactness is load-bearing: the strongest statement this service can
 * make is "a refusal has nowhere to put a price", and a test asserts the key
 * set is exactly ["refused", "reason", "message"] and that a refusal carries no
 * numeric price-shaped field at all.
 */

export type RefusalReason =
  /** The browser profile renders no signed-in header: expired/absent session. */
  | "session_expired"
  /** The page rendered, but showed no amount on the price row. */
  | "price_not_rendered"
  /** A quantity other than the page default was requested (not solved). */
  | "qty_unsupported"
  /** The call's own arguments were malformed (no source, two sources, bad base64). */
  | "input_invalid"
  /** The quote subprocess failed for a reason that is not an expired session. */
  | "adapter_error";

export interface Refusal {
  refused: true;
  reason: RefusalReason;
  /** What was attempted, in one sentence, plus the remedy. */
  message: string;
}

/** A quote as read off the page. Every optional field is nullable, never 0. */
export interface QuoteFields {
  pcb_price_usd: number;
  /** `null` when the page rendered no amount on the shipping row. Never 0. */
  shipping_usd: number | null;
  qty: number | null;
  layers: number | null;
  dimensions_mm: string | null;
  weight_kg: number | null;
}

/**
 * What one run of the browser leg reports, verbatim.
 *
 * This is EVIDENCE, not an answer: `raw_text` is the rendered page text and the
 * `client_*` fields are the wrapped client's own reading, reported only so a
 * cross-check can compare them. Deciding what the page said happens in
 * `parse.ts`, under test.
 */
export interface BrowserRun {
  /** The rendered page text, verbatim. The evidence every number comes from. */
  raw_text: string;
  /** Where the capture was taken (the URL, not a credential). */
  url: string;
  /** Did the profile render the signed-in header marker? */
  authenticated: boolean;
  /** The session message when `authenticated` is false. */
  session_message: string;
  /** The wrapped client's own price reading — evidence for a cross-check only. */
  client_price_usd: number | null;
  /** Why the wrapped client's own parser failed, if it did. */
  client_error: string;
  /** Why the browser leg itself failed, if it did. Never a price. */
  error: string;
}

export function isRefusal(v: unknown): v is Refusal {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { refused?: unknown }).refused === true &&
    typeof (v as { reason?: unknown }).reason === "string" &&
    typeof (v as { message?: unknown }).message === "string"
  );
}
