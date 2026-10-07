/**
 * announce_test.ts — the CEP-6 announcement emitter (card S2a).
 *
 * The surface under test: `cvm:service:<class>`, `cvm:req:<field>`,
 * `cvm:opt:<field>`, `cvm:tier:<max>` and the `cap` prices; deterministic tag
 * order; and the property that gives the tier tag its meaning — **the caller
 * cannot supply the tier**, so a lying aggregate is not expressible.
 *
 * Run: deno test --allow-read
 */
import { type AnnounceInput, emitAnnouncement, emitAnnouncementTags } from "../src/announce.ts";
import { parseVocab, type Vocab } from "../src/vocab.ts";
import { assertAnnouncementTags, assessAnnouncementTags } from "../src/validate.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT (${msg}): got ${a}, want ${b}`);
}
function assertThrows(fn: () => unknown, contains: string) {
  try {
    fn();
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes(contains)) {
      throw new Error(`ASSERT (throw message): got '${msg}', want it to contain '${contains}'`);
    }
    return;
  }
  throw new Error(`ASSERT (expected throw containing '${contains}'): nothing thrown`);
}
function sorted(tags: string[][]): string[] {
  return tags.map((t) => JSON.stringify(t)).sort();
}

const VOCAB: Vocab = parseVocab(
  JSON.parse(await Deno.readTextFile(new URL("../vocab/service-inputs.json", import.meta.url))),
);

const KIOSK: AnnounceInput = {
  serviceClass: "restaurant",
  d: "berlin-mitte-kiosk-01",
  required: ["payment.amount"],
};
const PIZZA: AnnounceInput = {
  serviceClass: "restaurant",
  d: "berlin-neukoelln-pizza-01",
  required: ["ship.address", "contact.phone"],
  optional: ["order.notes"],
};
const PHARMACY: AnnounceInput = {
  serviceClass: "pharmacy",
  d: "berlin-charlottenburg-apotheke-01",
  required: ["contact.name"],
  optional: ["identity.dob"],
};

Deno.test("emitter reproduces the spec's tier-tag examples as tag sets", () => {
  // coffee kiosk: money only -> sentinel + payment.amount + tier financial
  assertEquals(
    sorted(emitAnnouncementTags(KIOSK, VOCAB).tags),
    sorted([
      ["d", "berlin-mitte-kiosk-01"],
      ["t", "cvm:service:restaurant"],
      ["t", "cvm:req:payment.amount"],
      ["t", "cvm:req:none"],
      ["t", "cvm:tier:financial"],
    ]),
    "kiosk",
  );

  // pizza delivery -> fulfilment, no sentinel
  assertEquals(
    sorted(emitAnnouncementTags(PIZZA, VOCAB).tags),
    sorted([
      ["d", "berlin-neukoelln-pizza-01"],
      ["t", "cvm:service:restaurant"],
      ["t", "cvm:req:ship.address"],
      ["t", "cvm:req:contact.phone"],
      ["t", "cvm:opt:order.notes"],
      ["t", "cvm:tier:fulfilment"],
    ]),
    "pizza",
  );

  // pharmacy with an optional date of birth -> sensitive
  assertEquals(
    sorted(emitAnnouncementTags(PHARMACY, VOCAB).tags),
    sorted([
      ["d", "berlin-charlottenburg-apotheke-01"],
      ["t", "cvm:service:pharmacy"],
      ["t", "cvm:req:contact.name"],
      ["t", "cvm:opt:identity.dob"],
      ["t", "cvm:tier:sensitive"],
    ]),
    "pharmacy",
  );
});

Deno.test("emitter round-trips through the reader: zero violations, effective == computed", () => {
  for (const input of [KIOSK, PIZZA, PHARMACY]) {
    const { tags, tier } = emitAnnouncementTags(input, VOCAB);
    const a = assertAnnouncementTags(tags, VOCAB);
    assertEquals(a, assessAnnouncementTags(tags, VOCAB), `assert == assess for ${input.d}`);
    assertEquals(a.violations, [], `violations for ${input.d}`);
    assertEquals(a.tierMismatch, false, `mismatch for ${input.d}`);
    assertEquals(a.effective, tier, `effective tier for ${input.d}`);
    assertEquals(a.recomputed, tier, `recomputed tier for ${input.d}`);
  }
});

Deno.test("the emitted tier is COMPUTED: a caller-supplied tier cannot leak through", () => {
  // AnnounceInput has no tier field; a lying extra property must be ignored.
  const lying = { ...KIOSK, tier: "none", "cvm:tier": "none" } as unknown as AnnounceInput;
  const { tier, tags } = emitAnnouncementTags(lying, VOCAB);
  assertEquals(tier, "financial", "computed, not supplied");
  assertEquals(tags.filter((t) => t[0] === "t" && t[1].startsWith("cvm:tier:")), [[
    "t",
    "cvm:tier:financial",
  ]], "one honest tier tag");
});

Deno.test("emission is deterministic (an unchanged input re-publishes byte-identically)", () => {
  const a = emitAnnouncementTags(PIZZA, VOCAB).tags.map((t) => t.join("\u0000")).join("\n");
  const b = emitAnnouncementTags(PIZZA, VOCAB).tags.map((t) => t.join("\u0000")).join("\n");
  assertEquals(a, b, "stable tag order");
  assertEquals(
    JSON.stringify(emitAnnouncement(PIZZA, VOCAB).tags),
    JSON.stringify(emitAnnouncementTags(PIZZA, VOCAB).tags),
    "the event carries the same tags",
  );
});

Deno.test("exactly one cvm:tier tag, always", () => {
  for (const input of [KIOSK, PIZZA, PHARMACY, { serviceClass: "ev-charger", d: "x" }]) {
    const { tags } = emitAnnouncementTags(input, VOCAB);
    assertEquals(
      tags.filter((t) => t[0] === "t" && t[1].startsWith("cvm:tier:")).length,
      1,
      `one tier tag for ${input.d}`,
    );
  }
});

Deno.test("the sentinel is derived from the tier: present iff none/financial", () => {
  const kiosk = emitAnnouncementTags(KIOSK, VOCAB).tags;
  assert(kiosk.some((t) => t[0] === "t" && t[1] === "cvm:req:none"), "financial -> sentinel");
  const pizza = emitAnnouncementTags(PIZZA, VOCAB).tags;
  assert(!pizza.some((t) => t[0] === "t" && t[1] === "cvm:req:none"), "fulfilment -> no sentinel");
  const nothing: AnnounceInput = { serviceClass: "info-booth", d: "y" };
  const bare = emitAnnouncementTags(nothing, VOCAB).tags;
  assert(bare.some((t) => t[0] === "t" && t[1] === "cvm:req:none"), "no fields -> sentinel");
  assertEquals(emitAnnouncementTags(nothing, VOCAB).tier, "none", "no fields -> none");
  // passing the sentinel as a field is absorbed, not duplicated
  const explicit = emitAnnouncementTags(
    { ...nothing, required: ["none"] } as unknown as AnnounceInput,
    VOCAB,
  );
  assertEquals(
    explicit.tags.filter((t) => t[1] === "cvm:req:none").length,
    1,
    "sentinel not duplicated",
  );
});

Deno.test("an unknown field is refused by default and never emitted as 'none'", () => {
  const bad: AnnounceInput = { serviceClass: "restaurant", d: "z", required: ["mystery.field"] };
  assertThrows(() => emitAnnouncementTags(bad, VOCAB), "unknown requirement field");

  const { tags, tier, warnings } = emitAnnouncementTags(
    { ...bad, allowUnknownFields: true },
    VOCAB,
  );
  assertEquals(tier, "sensitive", "unknown is treated at the most restrictive rank");
  assert(tags.some((t) => t[1] === "cvm:req:mystery.field"), "the field is visible on the wire");
  assert(!tags.some((t) => t[1] === "cvm:tier:none"), "never counted as none");
  assert(warnings.some((w) => w.includes("unknown requirement field")), "warned loud");
});

Deno.test("geohash precisions: two or more of ONE point (P2)", () => {
  const two = emitAnnouncementTags(
    { serviceClass: "ev-charger", d: "charger-01", geohashes: ["u33d", "u33dc0"] },
    VOCAB,
  ).tags;
  assertEquals(
    two.filter((t) => t[0] === "g").map((t) => t[1]),
    ["u33d", "u33dc0"],
    "both precisions, short first",
  );

  assertThrows(
    () =>
      emitAnnouncementTags(
        { serviceClass: "ev-charger", d: "charger-02", geohashes: ["u33d"] },
        VOCAB,
      ),
    "exactly one distinct precision",
  );
  // F1 (review round 1): the guard must see the EMITTED tag set, not the input
  // array -- duplicates collapsing to one `g` tag are the same silent
  // discovery failure as publishing one precision (P2/D3, #g is exact match).
  for (
    const dup of [
      { label: "duplicate-only", d: "charger-dup-01", geohashes: ["u33d", "u33d"] },
      { label: "dedupe to one of three", d: "charger-dup-02", geohashes: ["u33d", "u33d", "u33d"] },
      {
        label: "duplicates plus a genuine second precision",
        d: "charger-dup-03",
        geohashes: ["u33dc0", "u33d", "u33d"],
      },
    ]
  ) {
    const uniq = new Set(dup.geohashes).size;
    if (uniq === 1) {
      assertThrows(
        () => emitAnnouncementTags({ serviceClass: "ev-charger", ...dup }, VOCAB),
        "exactly one distinct precision",
      );
    } else {
      const g = emitAnnouncementTags({ serviceClass: "ev-charger", ...dup }, VOCAB)
        .tags.filter((t) => t[0] === "g").map((t) => t[1]);
      assertEquals(g.length, uniq, `${dup.label}: one g tag per DISTINCT precision`);
      assertEquals(g, ["u33d", "u33dc0"], `${dup.label}: short first, no duplicates`);
    }
  }
  assertThrows(
    () =>
      emitAnnouncementTags(
        { serviceClass: "ev-charger", d: "charger-03", geohashes: ["u33d", "u33cw"] },
        VOCAB,
      ),
    "must describe ONE point",
  );
  // no fixed location -> no g tag
  assertEquals(
    emitAnnouncementTags({ serviceClass: "info-booth", d: "no-location" }, VOCAB).tags.filter((t) =>
      t[0] === "g"
    ),
    [],
    "no meaningless g",
  );
});

Deno.test("class and slug validation", () => {
  assertThrows(() => emitAnnouncementTags({ serviceClass: "EV Charger", d: "x" }, VOCAB), "kebab");
  assertThrows(
    () => emitAnnouncementTags({ serviceClass: "cvm:service:x", d: "x" }, VOCAB),
    "kebab",
  );
  assertThrows(
    () => emitAnnouncementTags({ serviceClass: "restaurant", d: "" }, VOCAB),
    "whitespace",
  );
  assertThrows(
    () => emitAnnouncementTags({ serviceClass: "restaurant", d: "has space" }, VOCAB),
    "whitespace",
  );
  assertThrows(
    () =>
      emitAnnouncementTags(
        { serviceClass: "restaurant", d: "x", humanTags: ["cvm:req:none"] },
        VOCAB,
      ),
    "namespaced",
  );
});

Deno.test("cap prices are per tool, with a declared unit", () => {
  const { tags } = emitAnnouncementTags({
    serviceClass: "restaurant",
    d: "cap-test",
    required: ["order.items"],
    tools: { order: { amount: 676 }, menu: { amount: 0, unit: "sats" } },
  }, VOCAB);
  assertEquals(
    tags.filter((t) => t[0] === "cap").sort((a, b) => a[1].localeCompare(b[1])),
    [["cap", "tool:menu", "0", "sats"], ["cap", "tool:order", "676", "sats"]],
    "one cap per tool, unit declared",
  );
  assertThrows(
    () =>
      emitAnnouncementTags(
        { serviceClass: "restaurant", d: "cap-bad", tools: { order: { amount: -1 } } },
        VOCAB,
      ),
    "negative amount",
  );
});

Deno.test("emitAnnouncement builds a 11316 with JSON content", () => {
  const event = emitAnnouncement({ ...PIZZA, content: { name: "Pizza", currency: "EUR" } }, VOCAB);
  assertEquals(event.kind, 11316, "CEP-6 server announcement kind");
  assertEquals(
    JSON.parse(event.content),
    { name: "Pizza", currency: "EUR" },
    "content is the announcement JSON",
  );
  assertEquals(event.tier, "fulfilment", "tier exposed for the caller");
});
