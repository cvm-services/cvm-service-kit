/**
 * announce.ts — the CEP-6 announcement for cvm-jlc-quote, asserted.
 *
 * THE CONTRACT THIS SERVICE DECLARES
 *
 *  - It is a read-only quote reader with NO payment and NO required or optional
 *    input field the service-input register knows about: a gerber zip is a TOOL
 *    ARGUMENT (an opaque archive), not a declared input, and the service stores
 *    nothing. So it declares the sentinel `cvm:req:none` — "tiers none only" —
 *    and nothing else.
 *  - It is therefore TIER `none`, and the emitted tag set carries
 *    `cvm:tier:none`. That is MEASURED, not chosen: with a req/opt list carrying
 *    only the sentinel, the kit's `recomputeTier` returns `none` (not `null`),
 *    and `emitAnnouncementTags` emits the sentinel AND the tier tag — it has no
 *    path to an unclassified tag set, because the sentinel is derived from the
 *    tier rather than from the input array (src/announce.ts). Suppressing the
 *    tag by hand would publish a set the kit's own reader rejects
 *    ("expected exactly one cvm:tier tag, found 0"), so the emitter is the
 *    authority and this file asserts exactly what it produces.
 *
 *    The `none` is what matters: `cvm:req:none` is the register's shorthand for
 *    "tiers none/financial only", the tier is RECOMPUTED from the declared
 *    fields on the reader side and lands on the bottom of the ladder, and no
 *    higher tier is claimable — a counter-test proves a real declared field DOES
 *    raise it (`cvm:tier:financial` for `payment.amount`).
 *  - It MUST NOT carry a `cap` tag: there is no payment rail and no price. The
 *    ASSERTED tag set below is the whole claim, and counter-tests prove the
 *    assertions can fail (see announce.test.ts: the same emitter DOES produce a
 *    `cap` tag when a tool is priced, and DOES produce `cvm:tier:financial` when
 *    a real field is declared).
 *
 * The content of the kind-11316 event carries the refusal list and the quantity
 * limitation verbatim: omission reads as "maybe", and on this service the
 * quantity limitation is the thing a caller is most likely to assume away.
 */
import { emitAnnouncement, type AnnounceInput, type EmittedAnnouncement } from "../../../src/announce.ts";
import { parseVocab, type Vocab } from "../../../src/vocab.ts";
import {
  JLC_QUOTE_ABOUT,
  NOT_OFFERED,
  QUANTITY_LIMITATION,
  REFUSAL_LIST,
} from "./provenance.ts";

/**
 * The tier this service's tag set carries — the BOTTOM of the ladder, computed
 * by the kit's own `recomputeTier` from a field list that contains only the
 * sentinel. Not supplied by this service (the emitter has no way to accept one).
 */
export const JLC_QUOTE_TIER = "none";
/** The register's shorthand value, as the reader recomputes it. */
export const JLC_QUOTE_NONE_SENTINEL = "cvm:req:none";

export const JLC_QUOTE_CLASS = "pcb-quote";
export const JLC_QUOTE_D = "cvm-jlc-quote-01";

/**
 * The register, read from the repo so the emitter can never emit a tag the
 * reader cannot classify. A missing register is a hard failure, not a default.
 */
export async function loadVocab(repoRoot?: string): Promise<Vocab> {
  const url = repoRoot
    ? `${repoRoot}/vocab/service-inputs.json`
    : new URL("../../../vocab/service-inputs.json", import.meta.url).pathname;
  const raw = await Bun.file(url).text();
  return parseVocab(JSON.parse(raw));
}

export function jlcQuoteAnnounceInput(over: Partial<AnnounceInput> = {}): AnnounceInput {
  return {
    serviceClass: JLC_QUOTE_CLASS,
    d: JLC_QUOTE_D,
    // The sentinel only: "tiers none/financial only". This service collects
    // nothing the register knows about, and it stores nothing.
    required: [],
    optional: [],
    humanTags: ["pcb", "jlcpcb", "gerber", "quote"],
    urls: ["https://github.com/cvm-services/cvm-service-kit/tree/main/services/jlc-quote"],
    content: {
      name: "cvm-jlc-quote",
      about: JLC_QUOTE_ABOUT,
      class: `cvm:service:${JLC_QUOTE_CLASS}`,
      read_only: true,
      tier: null,
      free: true,
      places_orders: false,
      what_it_is:
        "A read-only JLCPCB instant quote: upload a gerber zip, read the price, shipping, " +
        "quantity, layers, dimensions and weight that cart.jlcpcb.com actually rendered.",
      not_offered: NOT_OFFERED,
      quantity_limitation: QUANTITY_LIMITATION,
      refusals: REFUSAL_LIST,
      honesty:
        "An expired session, an unrendered price row and a disagreement between two readers " +
        "are each a VISIBLE refusal. This service never reports a price it did not read, " +
        "never reports an absent row as 0, and never presents a default-quantity price as a " +
        "requested-quantity price.",
    },
    ...over,
  };
}

export function emitJlcQuoteAnnouncement(
  vocab: Vocab,
  over: Partial<AnnounceInput> = {},
): EmittedAnnouncement {
  return emitAnnouncement(jlcQuoteAnnounceInput(over), vocab);
}

/** The exact tag set this service asserts. Used by the test as the frozen claim. */
export const ASSERTED_TAGS: string[][] = [
  ["d", JLC_QUOTE_D],
  ["t", `cvm:service:${JLC_QUOTE_CLASS}`],
  ["t", "pcb"],
  ["t", "jlcpcb"],
  ["t", "gerber"],
  ["t", "quote"],
  ["t", "cvm:req:none"],
  // Emitted by the kit's emitter at the bottom of the ladder; see the header for
  // why suppressing it would be a non-conforming tag set rather than a stricter one.
  ["t", `cvm:tier:${JLC_QUOTE_TIER}`],
  ["r", "https://github.com/cvm-services/cvm-service-kit/tree/main/services/jlc-quote"],
];
