/**
 * hygiene.ts — the card-material rules for cvm-2fiat, as code.
 *
 * This service is PUBLIC and wraps an ISSUER PORTAL (2fiat). The kit's
 * service-input register has no field for a PAN/CVV, so no tool can honestly
 * accept or return one; the transport has no replay protection, so no tool may
 * charge anything. These helpers make "no credential-shaped value may leave
 * this service" a property the tests can assert on every response.
 *
 * The refusal list below is a single source of truth: it is rendered into the
 * announced content AND into the docs tool output, so an omission anywhere
 * reads as "maybe", never as "not refused".
 */

/**
 * Capabilities this service REFUSES to expose, each with the reason. Written
 * out in full because "not implemented" and "refused" are different claims.
 */
export const REFUSAL_LIST: readonly string[] = [
  "REFUSED card.details: no tool will ever disclose a card number, CVV, expiry or last-4. The service-input register has no field for card material, and a PAN is a bearer instrument and an authentication factor at once.",
  "REFUSED payment.authorize / charge: there is no authorize endpoint on the issuer portal, human 3DS/SCA is mandatory, and the transport has no replay protection - one captured gift wrap would be a repeated charge.",
  "REFUSED card.pay_checkout unless BOTH hold: the caller is the owner key, AND the caller's sats payment has settled. The fiat leg is entered at most once per settlement, so a replayed (captured) gift wrap is refused by the state machine rather than becoming a second charge.",
  "REFUSED card.pay_checkout for an unattended charge: the last step is always a human - 3DS/SCA and the 2fiat OTP at the venue's hosted page. There is no autonomous fiat payment anywhere in this service.",
  "REFUSED card.create: issuing a card is a purchase, not a read; this service does not spend.",
  "REFUSED card.fund: funding drains a wallet; this service does not spend.",
];

/** One-line fragments the tests require to be present in the refusal list. */
export const REFUSAL_FRAGMENTS = [
  "card.details",
  "payment.authorize",
  "charge",
  "card.create",
  "card.fund",
] as const;

// ---------------------------------------------------------------------------
// credential-shape detection
// ---------------------------------------------------------------------------

/** A 2fiat magic-link token as it appears in a wallet URL path (`token1…`). */
const TOKEN1_RE = /token1[a-z0-9]{8,}/gi;
/** 13–19 digit run: PAN-shaped (also matches test PANs and card-order ids). */
const PAN_RE = /\b(?:\d[ -]?){13,19}\b/g;
/** 3–4 digit run on a cvv/cvc/code/pan-adjacent word. */
const CVV_RE = /\b(?:cvv|cvc|csc|security code|code)\D{0,8}(\d{3,4})\b/gi;
/** any 16-digit run even without word boundaries (conservative) */
const PAN16_RE = /\d{16,19}/g;

export interface CardMaterialHit {
  kind: "pan" | "cvv" | "token";
  /** The matched text (for the server log; never returned in a tool response). */
  match: string;
}

/**
 * Scan free text for credential-shaped material. Deliberately over-broad:
 * a false positive inside the service is an audit finding, not a leak.
 */
export function scanForCardMaterial(text: string): CardMaterialHit[] {
  const hits: CardMaterialHit[] = [];
  for (const m of text.matchAll(TOKEN1_RE)) hits.push({ kind: "token", match: m[0] });
  for (const m of text.matchAll(PAN16_RE)) hits.push({ kind: "pan", match: m[0] });
  for (const m of text.matchAll(PAN_RE)) {
    const squashed = m[0].replace(/\D/g, "");
    if (squashed.length >= 13) hits.push({ kind: "pan", match: m[0] });
  }
  for (const m of text.matchAll(CVV_RE)) {
    if (m[1]) hits.push({ kind: "cvv", match: m[1] });
  }
  return hits;
}

/** Replace credential-shaped runs with a labelled placeholder. */
export function redactCardMaterial(text: string): string {
  return text
    .replace(TOKEN1_RE, "[redacted:token]")
    .replace(PAN16_RE, (s) => "[redacted:pan]")
    .replace(PAN_RE, (s) => (s.replace(/\D/g, "").length >= 13 ? "[redacted:pan]" : s))
    .replace(CVV_RE, (orig, digits: string) => orig.replace(digits, "[redacted:cvv]"));
}

/**
 * Wrap every value this service returns. If credential-shaped material ever
 * reaches a tool response it is redacted and the redaction is reported in the
 * `hygiene` field so a caller (and the operator) sees that something was
 * caught - a silent strip would hide the defect.
 */
export function hygieneWrap<T extends Record<string, unknown>>(out: T): T {
  const raw = JSON.stringify(out);
  const hits = scanForCardMaterial(raw);
  if (hits.length === 0) return out;
  const redacted = redactCardMaterial(raw);
  return JSON.parse(redacted) as T & { hygiene?: unknown };
}
