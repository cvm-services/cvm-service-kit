/**
 * tier_recompute_test.ts — the tier-recompute contract (card S2a).
 *
 * The rule under test (docs/spec/service-inputs.md, "The tier tag"): the field
 * list is the truth. The published `cvm:tier:<max>` tag MUST equal the
 * recomputed max of the declared `cvm:req:*`/`cvm:opt:*` fields; a reader that
 * finds a disagreement MUST use the RECOMPUTED value AND surface the mismatch.
 *
 * Runs against the real vendored register, so a register edit that breaks the
 * ladder fails here. No third-party imports: no network required.
 *
 * Run: deno test --allow-read
 */
import {
  declaredInputs,
  parseVocab,
  rankOf,
  recomputeTier,
  recomputeTierFromTags,
  TIER_LADDER,
  TIER_PREFIX,
  TIER_RANKS,
  tierPrefilter,
  type Vocab,
  vocabErrors,
} from "../src/vocab.ts";
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

const VOCAB: Vocab = parseVocab(
  JSON.parse(await Deno.readTextFile(new URL("../vocab/service-inputs.json", import.meta.url))),
);

/** Build the minimal `t` tags for a declared field set. */
function tTags(req: string[] = [], opt: string[] = [], tier?: string): string[][] {
  const tags: string[][] = [["d", "test"]];
  for (const f of req) tags.push(["t", "cvm:req:" + f]);
  for (const f of opt) tags.push(["t", "cvm:opt:" + f]);
  if (tier) tags.push(["t", TIER_PREFIX + tier]);
  return tags;
}

Deno.test("the vendored register is structurally sound", () => {
  assertEquals(VOCAB.version, 1, "vocab.version");
  assertEquals(vocabErrors(VOCAB), [], "vocabErrors");
  assertEquals(Object.keys(VOCAB.tier_tag!.ranks), [...TIER_LADDER], "ranks ladder");
  assertEquals(VOCAB.tier_tag!.ranks, TIER_RANKS, "ranks are the fixed ladder");
  assert(Object.keys(VOCAB.fields).length >= 30, "register has the v1 fields");
});

Deno.test("recompute: every tier is reachable from a real register field", () => {
  const sample: Record<string, string> = {
    financial: "payment.amount",
    contact: "contact.phone",
    fulfilment: "ship.address",
    legal: "legal.terms",
    sensitive: "identity.dob",
  };
  for (const [tier, field] of Object.entries(sample)) {
    const rec = recomputeTierFromTags(tTags([field]), VOCAB);
    assertEquals(rec.tier, tier, `single ${tier} field '${field}'`);
    assertEquals(rec.unknown, [], `no unknown for '${field}'`);
  }
  // "none" has no field: it is the sentinel-only case.
  const sentinelOnly = recomputeTierFromTags([["d", "x"], ["t", "cvm:req:none"]], VOCAB);
  assertEquals(sentinelOnly.tier, "none", "sentinel only -> none");
  assertEquals(sentinelOnly.basis, [], "sentinel contributes no basis field");
});

Deno.test("recompute: max over required AND optional, ranks ordered", () => {
  // contact.name (req) + identity.dob (opt) -> sensitive
  assertEquals(
    recomputeTierFromTags(tTags(["contact.name"], ["identity.dob"]), VOCAB).tier,
    "sensitive",
  );
  // fulfilment beats contact, contact beats financial
  assertEquals(
    recomputeTierFromTags(tTags(["ship.address", "contact.phone"]), VOCAB).tier,
    "fulfilment",
  );
  assertEquals(
    recomputeTierFromTags(tTags(["order.items", "payment.amount"]), VOCAB).tier,
    "fulfilment",
  );
  // legal beats fulfilment, sensitive beats legal
  assertEquals(recomputeTierFromTags(tTags(["legal.terms", "order.items"]), VOCAB).tier, "legal");
  assertEquals(
    recomputeTierFromTags(tTags(["legal.terms"], ["prefs.dietary"]), VOCAB).tier,
    "sensitive",
  );
  assertEquals(rankOf("legal")! > rankOf("fulfilment")!, true, "legal > fulfilment");
  assertEquals(rankOf("sensitive")! > rankOf("legal")!, true, "sensitive > legal");
  assertEquals(rankOf("not-a-tier"), null, "unrecognised tier has no rank");
});

Deno.test("recompute: the spec's three tier-tag examples recompute as published", () => {
  // coffee kiosk: money only -> financial
  const kiosk = tTags(["payment.amount"], [], "financial");
  assertEquals(recomputeTierFromTags(kiosk, VOCAB).tier, "financial", "kiosk");
  assertEquals(assessAnnouncementTags(kiosk, VOCAB).violations, [], "kiosk conforms");

  // pizza delivery -> fulfilment
  const pizza = tTags(["ship.address", "contact.phone"], [], "fulfilment");
  assertEquals(recomputeTierFromTags(pizza, VOCAB).tier, "fulfilment", "pizza");
  assertEquals(assessAnnouncementTags(pizza, VOCAB).violations, [], "pizza conforms");

  // pharmacy with an optional date of birth -> sensitive
  const pharmacy = tTags(["contact.name"], ["identity.dob"], "sensitive");
  assertEquals(recomputeTierFromTags(pharmacy, VOCAB).tier, "sensitive", "pharmacy");
  assertEquals(assessAnnouncementTags(pharmacy, VOCAB).violations, [], "pharmacy conforms");
});

Deno.test("recompute: absent is not none (unclassified -> null, no tier tag expected)", () => {
  const d = declaredInputs([["d", "x"], ["t", "cvm:service:restaurant"]]);
  assertEquals(d.unclassified, true, "no req/opt tags = unclassified");
  assertEquals(recomputeTier(d, VOCAB).tier, null, "unknown appetite, never 'none'");
});

Deno.test("recompute: an unknown field fails loud and is never 'none'", () => {
  const tags = tTags(["mystery.field"], ["ship.address"]);
  const rec = recomputeTierFromTags(tags, VOCAB);
  assertEquals(rec.unknown, ["mystery.field"], "unknown surfaced");
  assertEquals(rec.tier, "sensitive", "unknown treated at the most restrictive rank");

  const a = assessAnnouncementTags(tags, VOCAB);
  assertEquals(a.effective, "sensitive", "effective is the recomputed value");
  assert(
    a.violations.some((v) => v.includes("unknown requirement field")),
    "unknown is a violation, not a silent drop",
  );
  // ... and it must never be counted as the sentinel
  assertEquals(
    recomputeTierFromTags(
      [["d", "x"], ["t", "cvm:req:none"], ["t", "cvm:req:mystery.field"]],
      VOCAB,
    ).tier,
    "sensitive",
    "sentinel does not mask an unknown field",
  );
});

Deno.test("MISMATCH: the recomputed value wins and the disagreement is surfaced", () => {
  // fields say fulfilment, the tag lies 'contact'
  const lying = tTags(["ship.address"], [], "contact");
  const a = assessAnnouncementTags(lying, VOCAB);
  assertEquals(a.declaredTiers, ["contact"], "published tag read back");
  assertEquals(a.recomputed, "fulfilment", "recomputed from the fields");
  assertEquals(a.effective, "fulfilment", "reader MUST use the recomputed value");
  assertEquals(a.tierMismatch, true, "mismatch flagged");
  assert(
    a.violations.some((v) => v.includes("recompute")) &&
      a.violations.some((v) => v.includes("contact") && v.includes("fulfilment")),
    "both values are named",
  );
  // the other direction: tag too high
  const inflated = tTags(["contact.phone"], [], "sensitive");
  const b = assessAnnouncementTags(inflated, VOCAB);
  assertEquals(b.effective, "contact", "recomputed wins even when the tag is higher");
  assertEquals(b.tierMismatch, true, "inflated tag also mismatches");
});

Deno.test("exactly one tier tag: zero, two, or a non-ladder value all violate", () => {
  assertEquals(
    assessAnnouncementTags(tTags(["contact.phone"]), VOCAB).violations.length,
    1,
    "zero tier tags",
  );
  assert(
    assessAnnouncementTags(tTags(["contact.phone"]), VOCAB).violations[0].includes("exactly one"),
    "zero is named",
  );
  const two = tTags(["contact.phone"], [], "contact");
  two.push(["t", TIER_PREFIX + "financial"]);
  assert(
    assessAnnouncementTags(two, VOCAB).violations.some((v) => v.includes("exactly one")),
    "two tier tags violate",
  );
  const bogus = tTags(["contact.phone"], [], "personal");
  assert(
    assessAnnouncementTags(bogus, VOCAB).violations.some((v) => v.includes("not a ladder value")),
    "non-ladder tier violates",
  );
});

Deno.test("a tier tag with no req/opt tags violates (absent is not none)", () => {
  const a = assessAnnouncementTags([["d", "x"], ["t", "cvm:tier:none"]], VOCAB);
  assertEquals(a.declaredInputs.unclassified, true, "unclassified");
  assert(
    a.violations.some((v) => v.includes("absent is not 'none'")),
    "a tier tag without declared inputs is a violation",
  );
  assertEquals(a.effective, null, "no effective tier for an unknown appetite");
});

Deno.test("a field declared both required and optional violates", () => {
  const a = assessAnnouncementTags(tTags(["contact.phone"], ["contact.phone"], "contact"), VOCAB);
  assert(
    a.violations.some((v) => v.includes("both required and optional")),
    "overlap violates",
  );
});

Deno.test("sentinel consistency is advisory, not a hard gate", () => {
  // financial tier without the sentinel: warn, do not block
  const noSentinel = tTags(["payment.amount"], [], "financial");
  const a = assessAnnouncementTags(noSentinel, VOCAB);
  assertEquals(a.violations, [], "not a violation");
  assert(a.warnings.some((w) => w.includes("cvm:req:none sentinel")), "sentinel absence warned");

  // sentinel alongside a higher tier: warn, do not block
  const misleading = tTags(["ship.address"], [], "fulfilment");
  misleading.push(["t", "cvm:req:none"]);
  const b = assessAnnouncementTags(misleading, VOCAB);
  assertEquals(b.violations, [], "not a violation");
  assert(
    b.warnings.some((w) => w.includes("sentinel published although")),
    "misleading sentinel warned",
  );
});

Deno.test("assertAnnouncementTags throws on a violation, returns otherwise", () => {
  assertThrows(
    () => assertAnnouncementTags(tTags(["ship.address"], [], "contact"), VOCAB),
    "recompute",
  );
  const ok = assertAnnouncementTags(tTags(["ship.address"], [], "fulfilment"), VOCAB);
  assertEquals(ok.effective, "fulfilment", "conforming set returns its assessment");
});

Deno.test("the max-only tier makes the coarse filter a single server-side REQ", () => {
  assertEquals(tierPrefilter("no_personal_data"), ["cvm:tier:none", "cvm:tier:financial"]);
  assertEquals(tierPrefilter("contact_only"), [
    "cvm:tier:none",
    "cvm:tier:financial",
    "cvm:tier:contact",
  ]);
  assertThrows(() => tierPrefilter("nope"), "unknown tier shorthand");
});
