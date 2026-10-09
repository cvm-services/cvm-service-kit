/**
 * announce.test.ts — the ANNOUNCEMENT CONTRACT for this service.
 *
 * The service's honesty claim is that it collects nothing: both input lists are
 * empty, so `recomputeTier` must land on `none` via the sentinel path, no `cap`
 * tag may exist (every tool is free), and a caller must not be able to influence
 * the tier. This test pins exactly that, so a later edit that quietly adds a
 * priced tool or a collected field fails here instead of shipping.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { emitAnnouncementTags, type AnnounceInput } from "../../../src/announce.ts";
import { parseVocab, type Vocab } from "../../../src/vocab.ts";

const VOCAB: Vocab = parseVocab(
  JSON.parse(readFileSync(new URL("../../../vocab/service-inputs.json", import.meta.url), "utf8")),
);

const INPUT: AnnounceInput = {
  serviceClass: "market",
  d: "no-server-deals-01",
  required: [],
  optional: [],
  // every tool is free — the tool map is deliberately absent
};

function tagValues(tags: string[][], letter: string): string[] {
  return tags.filter((t) => t[0] === letter).map((t) => t[1]);
}

describe("no-server-deals announcement", () => {
  test("tier is COMPUTED as none for an empty input list", () => {
    const { tier, tags } = emitAnnouncementTags(INPUT, VOCAB);
    expect(tier).toBe("none");
    expect(tagValues(tags, "t")).toContain("cvm:tier:none");
  });

  test("class tag is the namespaced kebab class", () => {
    const { tags } = emitAnnouncementTags(INPUT, VOCAB);
    expect(tagValues(tags, "t")).toContain("cvm:service:market");
    expect(tagValues(tags, "d")).toEqual(["no-server-deals-01"]);
  });

  test("NO cap tag anywhere: the whole tool surface is free", () => {
    const { tags } = emitAnnouncementTags(INPUT, VOCAB);
    expect(tags.filter((t) => t[0] === "cap")).toEqual([]);
  });

  test("exactly one tier tag", () => {
    const { tags } = emitAnnouncementTags(INPUT, VOCAB);
    expect(tags.filter((t) => t[0] === "t" && String(t[1]).startsWith("cvm:tier:"))).toHaveLength(1);
  });

  test("no collected field is announced", () => {
    const { tags } = emitAnnouncementTags(INPUT, VOCAB);
    const declared = tags.filter(
      (t) => t[0] === "t" && (String(t[1]).startsWith("cvm:req:") || String(t[1]).startsWith("cvm:opt:")),
    );
    // The register requires a `cvm:req:none` sentinel for a zero-field service.
    expect(declared.map((t) => t[1])).toEqual(["cvm:req:none"]);
  });

  test("a priced tool WOULD add a cap tag — proving the assertion above has teeth", () => {
    const { tags } = emitAnnouncementTags({ ...INPUT, tools: { search_listings: { amount: 5 } } }, VOCAB);
    const caps = tags.filter((t) => t[0] === "cap");
    expect(caps.length).toBe(1);
    expect(caps[0][1]).toBe("tool:search_listings");
  });

  test("the tier is not caller-suppliable (no field exists to lie with)", () => {
    const asAny = { ...INPUT, tier: "none", cvmTier: "none" } as AnnounceInput;
    const { tier } = emitAnnouncementTags(asAny, VOCAB);
    expect(tier).toBe("none");
    // An injected tier field must be ignored, not echoed: assert the emitted tag
    // set is identical to the clean input's tag set.
    const clean = emitAnnouncementTags(INPUT, VOCAB);
    expect(emitAnnouncementTags(asAny, VOCAB).tags).toEqual(clean.tags);
  });
});
