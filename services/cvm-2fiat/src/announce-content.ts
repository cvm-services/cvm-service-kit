/**
 * announce-content.ts — the single description of the cvm-2fiat announcement.
 *
 * Why a dedicated module: this service is FIELD-LESS. It collects no input
 * the register knows about (no card field exists), so per CEP-6/ADR-0001 D14
 * it is UNCLASSIFIED: the announcement must carry NO `cvm:tier:*` tag and NO
 * `cvm:req:*`/`cvm:opt:*` tags at all - "absent" is the honest state, and a
 * tier tag here would be a caller-supplied-looking claim the register cannot
 * back. The generic `AnnounceOptions` path auto-emits `cvm:tier:none` when
 * both input arrays are `[]`, which is exactly what this service must NOT
 * do, so the tag/content surface is described here and the server.ts passes
 * it through with `requiredInputs`/`optionalInputs` left undefined.
 *
 * The `content` of the kind-11316 event carries the refusal list verbatim:
 * omission reads as "maybe", and the refusal list is the product.
 */
import { REFUSAL_LIST } from "./hygiene.ts";

export interface TwoFiatAnnouncement {
  /** JSON content for the 11316 event (stringified by the caller). */
  content: string;
  /** undefined = unclassified: no tier tag is emitted. */
  tierTag: undefined;
  /** deliberately undefined - a field-less service declares nothing. */
  requiredInputs: undefined;
  optionalInputs: undefined;
  tools: string[];
}

export const TWOFIAT_SERVICE_CLASS = "payment-rail";

export const TWOFIAT_ABOUT =
  "Credential-free payment rail for 2fiat prepaid cards: checkout hand-off " +
  "instructions, rail facts, and an owner-only balance read. No card number " +
  "is ever disclosed, stored or charged by this service; paying happens at " +
  "the merchant's hosted checkout with a human answering 3DS.";

export function twoFiatAnnouncementContent(tools: string[] = [
  "card.rail_info",
  "payment.quote",
  "card.balance",
  "docs",
]): TwoFiatAnnouncement {
  const content = {
    name: "cvm-2fiat",
    about: TWOFIAT_ABOUT,
    class: `cvm:service:${TWOFIAT_SERVICE_CLASS}`,
    informational: true,
    tier: null, // unclassified - field-less; no cvm:tier tag is emitted
    best_effort: true,
    human_in_the_loop: "3DS at the merchant checkout",
    what_this_is:
      "The RAIL, not the card: validates a merchant checkout URL and returns " +
      "the amount plus instructions for the own-card hand-off; reads the " +
      "operator's card balance through a LOCAL adapter (owner key only).",
    what_this_is_not: REFUSAL_LIST,
    money_rules: {
      settle_then_spend:
        "No spend may happen before the caller's payment has settled. Paid " +
        "paths sit downstream of the kit's ExplicitGate; a Cashu receive and " +
        "a Lightning payment are FINAL (there is no un-pay), so the failure " +
        "risk of a settled-then-failed call sits with this service.",
      refunds: "manual",
      cap_note:
        "A cap bounds what the CLIENT pays this service. It says nothing " +
        "about the card: no tool on this service can charge the card at all.",
    },
  };
  return {
    content: JSON.stringify(content),
    tierTag: undefined,
    requiredInputs: undefined,
    optionalInputs: undefined,
    tools,
  };
}
