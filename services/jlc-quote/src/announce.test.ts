/**
 * announce.test.ts — INVARIANT 4: the announcement contract is frozen AND
 * adversarial.
 *
 * The tag set is ASSERTED exactly, and then a counter-test proves the assertion
 * has teeth: the same emitter DOES produce a `cap` tag for a priced tool and
 * DOES produce a `cvm:tier:financial` tag for a real declared field. Without
 * that, "no tier tag, no cap tag" would pass on a typo, on an empty tag list, or
 * on an emitter that silently returned nothing.
 */
import { describe, expect, test } from "bun:test";
import { emitAnnouncementTags } from "../../../src/announce.ts";
import { assessAnnouncementTags, assertAnnouncementTags } from "../../../src/validate.ts";
import {
  ASSERTED_TAGS,
  emitJlcQuoteAnnouncement,
  JLC_QUOTE_CLASS,
  JLC_QUOTE_D,
  JLC_QUOTE_NONE_SENTINEL,
  JLC_QUOTE_TIER,
  jlcQuoteAnnounceInput,
  loadVocab,
} from "./announce.ts";
import { NOT_OFFERED, QUANTITY_LIMITATION, REFUSAL_LIST } from "./provenance.ts";

const sorted = (tags: string[][]) =>
  tags.map((t) => JSON.stringify(t)).sort((a, b) => a.localeCompare(b));
const VOCAB = await loadVocab();

describe("INVARIANT 4 — the emitted tag set is exactly the asserted one", () => {
  test("the tags equal ASSERTED_TAGS: class tag + four human words + sentinel + r", () => {
    const { tags, tier } = emitAnnouncementTags(jlcQuoteAnnounceInput(), VOCAB);
    expect(sorted(tags)).toEqual(sorted(ASSERTED_TAGS));
    expect(tier).toBe("none");
  });

  test("the tag set carries NO cvm:tier tag and NO cap tag, and exactly one sentinel", () => {
    const { tags } = emitAnnouncementTags(jlcQuoteAnnounceInput(), VOCAB);
    const t = tags.filter((x) => x[0] === "t").map((x) => x[1]);
    // THE MEASURED CONTRACT: exactly one tier tag, and it is the bottom of the
    // ladder. This is what the kit's emitter produces (see announce.ts header);
    // the test asserts the VALUE so a drift to a higher tier fails loudly.
    expect(t.filter((v) => v.startsWith("cvm:tier:"))).toEqual([`cvm:tier:${JLC_QUOTE_TIER}`]);
    expect(JLC_QUOTE_TIER).toBe("none");
    expect(tags.filter((x) => x[0] === "cap")).toEqual([]);
    expect(t.filter((v) => v === JLC_QUOTE_NONE_SENTINEL)).toEqual([JLC_QUOTE_NONE_SENTINEL]);
    // ...and no other req/opt tag, because this service declares nothing.
    expect(t.filter((v) => v.startsWith("cvm:req:") || v.startsWith("cvm:opt:"))).toEqual([
      JLC_QUOTE_NONE_SENTINEL,
    ]);
    expect(t).toContain(`cvm:service:${JLC_QUOTE_CLASS}`);
    expect(tags).toContainEqual(["d", JLC_QUOTE_D]);
  });

  test("the tier cannot drift upward: no field raises it, and the reader agrees", () => {
    // Teeth: a service that quietly declared a real field would move the tier.
    const { tier } = emitAnnouncementTags(jlcQuoteAnnounceInput(), VOCAB);
    expect(tier).toBe(JLC_QUOTE_TIER);
    const base = emitAnnouncementTags(jlcQuoteAnnounceInput(), VOCAB).tags;
    const raised = emitAnnouncementTags(
      jlcQuoteAnnounceInput({ required: ["ship.address"] }),
      VOCAB,
    ).tags;
    expect(sorted(base)).not.toEqual(sorted(raised));
    expect(raised).toContainEqual(["t", "cvm:tier:fulfilment"]);
  });

  test("a reader agrees: no violations, tier none, no mismatch", () => {
    const { tags } = emitAnnouncementTags(jlcQuoteAnnounceInput(), VOCAB);
    const a = assertAnnouncementTags(tags, VOCAB);
    expect(a.violations).toEqual([]);
    expect(a.tierMismatch).toBe(false);
    expect(a.effective).toBe("none");
    expect(a.recomputed).toBe("none");
    expect(a.declaredInputs.required).toEqual([]);
    expect(a.declaredInputs.noneSentinel).toBe(true);
  });
});

describe("INVARIANT 4 — counter-tests: the assertion has teeth", () => {
  test("COUNTER-TEST A: a PRICED tool DOES emit exactly one cap tag", () => {
    // If the emitter could never produce a `cap` tag, "no cap tag" would be
    // vacuous. Note the kit's ToolCap shape is { amount: N }, not { amountSats }.
    const { tags } = emitAnnouncementTags(
      jlcQuoteAnnounceInput({ tools: { quote: { amount: 5 } } }),
      VOCAB,
    );
    const caps = tags.filter((t) => t[0] === "cap");
    expect(caps).toEqual([["cap", "tool:quote", "5", "sats"]]);
  });

  test("COUNTER-TEST B: a real declared field MOVES the tier tag off 'none'", () => {
    // Teeth: the `cvm:tier:none` this service publishes is a consequence of
    // declaring no field, not a constant. A money field makes it `financial`
    // (the sentinel STAYS: the register's shorthand is "tiers none/financial
    // only", so `cvm:req:none` accompanies both), and a fulfilment field makes it
    // `fulfilment` and DOES suppress the sentinel.
    const money = emitAnnouncementTags(jlcQuoteAnnounceInput({ required: ["payment.amount"] }), VOCAB);
    expect(money.tags.filter((t) => t[0] === "t" && t[1].startsWith("cvm:tier:"))).toEqual([
      ["t", "cvm:tier:financial"],
    ]);
    expect(money.tier).toBe("financial");
    expect(money.tags).toContainEqual(["t", "cvm:req:none"]);

    const ship = emitAnnouncementTags(jlcQuoteAnnounceInput({ required: ["ship.address"] }), VOCAB);
    expect(ship.tags.filter((t) => t[0] === "t" && t[1].startsWith("cvm:tier:"))).toEqual([
      ["t", "cvm:tier:fulfilment"],
    ]);
    expect(ship.tier).toBe("fulfilment");
    expect(ship.tags).not.toContainEqual(["t", "cvm:req:none"]);
    // ...and the service's OWN tag set is unchanged by that experiment.
    expect(emitAnnouncementTags(jlcQuoteAnnounceInput(), VOCAB).tier).toBe("none");
  });

  test("COUNTER-TEST C: a polluted tag set breaks the equality AND the reader flags it", () => {
    // Teeth on the happy-path assertion itself, in two directions. (Measured
    // against the kit's reader: it DEDUPES repeated tier tags, so a duplicate
    // alone is not a violation — the pollution has to be a value the fields
    // cannot back, which is the lie the register exists to catch.)
    //
    // (i) the equality: a tier tag the fields do not back still breaks it.
    const lying = [
      ...ASSERTED_TAGS.filter((t) => t[1] !== "cvm:tier:none"),
      ["t", "cvm:tier:sensitive"],
    ];
    expect(sorted(lying)).not.toEqual(sorted(ASSERTED_TAGS));

    // (ii) the reader: violations non-empty, BOTH values named, and the
    //      recomputed value — never the published one — is the effective one.
    const aOnly = assessAnnouncementTags(lying, VOCAB);
    expect(aOnly.violations.length).toBeGreaterThan(0);
    expect(aOnly.violations.join(" ")).toContain("sensitive");
    expect(aOnly.violations.join(" ")).toContain("none");
    expect(aOnly.effective).toBe("none");
    expect(aOnly.tierMismatch).toBe(true);

    // (iii) a tier value that is not on the ladder at all is also a violation.
    const offLadder = [
      ...ASSERTED_TAGS.filter((t) => t[1] !== "cvm:tier:none"),
      ["t", "cvm:tier:platinum"],
    ];
    expect(assessAnnouncementTags(offLadder, VOCAB).violations.join(" ")).toContain("ladder");
  });

  test("COUNTER-TEST D: a cap tag makes the asserted equality fail", () => {
    const { tags } = emitAnnouncementTags(
      jlcQuoteAnnounceInput({ tools: { quote: { amount: 5 } } }),
      VOCAB,
    );
    expect(sorted(tags)).not.toEqual(sorted(ASSERTED_TAGS));
  });
});

describe("the announcement CONTENT carries the limitations verbatim", () => {
  test("content names the refusal list, the not-offered list and the qty limitation", () => {
    const content = JSON.parse(String(emitJlcQuoteAnnouncement(VOCAB).content));
    expect(content.read_only).toBe(true);
    expect(content.places_orders).toBe(false);
    expect(content.free).toBe(true);
    expect(content.tier).toBeNull();
    expect(content.quantity_limitation).toBe(QUANTITY_LIMITATION);
    expect(String(content.quantity_limitation)).toContain("qty_unsupported");
    expect(content.not_offered).toEqual(NOT_OFFERED);
    expect(content.refusals).toEqual(REFUSAL_LIST);
    // The honesty sentence a reader needs is IN the content, not only in the repo.
    expect(String(content.honesty)).toContain("VISIBLE refusal");
  });

  test("the content carries no payment rail: no pmi, no cap, no price", () => {
    const ann = emitJlcQuoteAnnouncement(VOCAB);
    expect(ann.tags.filter((t) => t[0] === "pmi")).toEqual([]);
    expect(ann.tags.filter((t) => t[0] === "cap")).toEqual([]);
    expect(JSON.stringify(ann.content).toLowerCase()).not.toContain("cashu");
    expect(JSON.stringify(ann.content).toLowerCase()).not.toContain("invoice");
  });

  test("every refusal reason in the catalogue is covered by the announced list", () => {
    for (const reason of [
      "session_expired",
      "price_not_rendered",
      "qty_unsupported",
      "input_invalid",
      "adapter_error",
    ]) {
      expect(REFUSAL_LIST.join("\n")).toContain(`${reason}:`);
    }
  });
});
