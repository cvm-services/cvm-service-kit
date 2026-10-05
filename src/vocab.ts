/**
 * vocab.ts — the service-input register (docs/spec/service-inputs.md,
 * vocab/service-inputs.json in `contextvm-services`), expressed as the rules the
 * kit actually enforces.
 *
 * Everything here is pure and dependency-free so the emitter, the validator and
 * a reader share one implementation of the tier rules. The rules, verbatim from
 * the spec:
 *
 *  - the tier tag is `["t","cvm:tier:<tier>"]`, exactly ONE per announcement;
 *  - it MUST equal the recomputed MAX of the declared `cvm:req:*`/`cvm:opt:*`
 *    fields (ranks none 0 < financial 1 < contact 2 < fulfilment 3 < legal 4 <
 *    sensitive 5);
 *  - "the field list is the truth": a reader that finds a disagreement uses the
 *    RECOMPUTED value and surfaces the mismatch;
 *  - absent is not `none`: no `cvm:req:*`/`cvm:opt:*` tag at all is an UNKNOWN
 *    appetite (`recomputeTier` returns `null`), never `none`;
 *  - unknown field names fail loud: surfaced, treated at the most restrictive
 *    rank, never counted as `cvm:req:none`.
 */

/** The disclosure ladder. Ordered; the ranks are fixed by the spec. */
export const TIER_LADDER = [
  "none",
  "financial",
  "contact",
  "fulfilment",
  "legal",
  "sensitive",
] as const;

export type Tier = typeof TIER_LADDER[number];

/**
 * Upper-bound ordering used for filtering only. It is NOT a juridical claim:
 * rank 3 is not "worse" than rank 2, it is merely higher in the upper-bound
 * sense a "no personal data" filter needs.
 */
export const TIER_RANKS: Record<Tier, number> = {
  none: 0,
  financial: 1,
  contact: 2,
  fulfilment: 3,
  legal: 4,
  sensitive: 5,
};

/** Namespaced values carried on the single-letter `t` tag (ADR-0001 D2/D3). */
export const CLASS_PREFIX = "cvm:service:";
export const REQ_PREFIX = "cvm:req:";
export const OPT_PREFIX = "cvm:opt:";
export const TIER_PREFIX = "cvm:tier:";

/** `cvm:req:none` — the sentinel; the tag form of "tiers none/financial only". */
export const NONE_SENTINEL = "cvm:req:none";

/** CEP-6 server announcement (replaceable). */
export const ANNOUNCEMENT_KIND = 11316;

/**
 * Server-side prefilter values for a UI shorthand (vocab.filter_shorthand).
 * Several `#t` values in one REQ are OR, which is exactly the semantics wanted
 * here — that is why the tier is published max-only.
 */
export const TIER_SHORTHAND: Record<string, Tier[]> = {
  no_personal_data: ["none", "financial"],
  contact_only: ["none", "financial", "contact"],
};

export interface VocabField {
  tier: string;
  type?: string;
  values?: string[];
  note?: string;
}

export interface Vocab {
  version?: number;
  updated?: string;
  status?: string;
  tiers: Record<string, string>;
  tier_tag?: { ranks: Record<string, number>; [k: string]: unknown };
  filter_shorthand?: Record<string, string[]>;
  fields: Record<string, VocabField>;
  deprecated?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// ladder helpers
// ---------------------------------------------------------------------------

export function isTier(v: string): v is Tier {
  return (TIER_LADDER as readonly string[]).includes(v);
}

/** Rank of a ladder value, or `null` for an unrecognised string. */
export function rankOf(tier: string): number | null {
  return isTier(tier) ? TIER_RANKS[tier] : null;
}

export function higherTier(a: Tier, b: Tier): Tier {
  return TIER_RANKS[a] >= TIER_RANKS[b] ? a : b;
}

/** The tier a field name carries, or `null` when the register does not know it. */
export function fieldTier(field: string, vocab: Vocab): Tier | null {
  const t = vocab.fields[field]?.tier;
  return t !== undefined && isTier(t) ? t : null;
}

// ---------------------------------------------------------------------------
// the register itself
// ---------------------------------------------------------------------------

/** Structural parse of a register document. Throws; content checks are separate. */
export function parseVocab(raw: unknown): Vocab {
  if (typeof raw !== "object" || raw === null) throw new Error("vocab: not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.fields !== "object" || o.fields === null) throw new Error("vocab: missing 'fields'");
  if (typeof o.tiers !== "object" || o.tiers === null) throw new Error("vocab: missing 'tiers'");
  return raw as Vocab;
}

/**
 * Content checks that make the tier rules meaningful. A register whose ladder
 * disagrees with this module's is not usable: the ranks are fixed by the spec,
 * and an inferred ladder is exactly how two implementations drift apart.
 */
export function vocabErrors(vocab: Vocab): string[] {
  const errors: string[] = [];
  for (const tier of TIER_LADDER) {
    if (!(tier in vocab.tiers)) errors.push(`tiers is missing '${tier}'`);
  }
  const ranks = vocab.tier_tag?.ranks;
  if (!ranks) {
    errors.push("tier_tag.ranks is missing (the ladder must be published, not inferred)");
  } else {
    for (const tier of TIER_LADDER) {
      if (ranks[tier] !== TIER_RANKS[tier]) {
        errors.push(
          `tier_tag.ranks['${tier}'] = ${ranks[tier]}, want ${
            TIER_RANKS[tier]
          } (the ladder is fixed)`,
        );
      }
    }
  }
  for (const [name, f] of Object.entries(vocab.fields)) {
    if (!f || typeof f.tier !== "string") {
      errors.push(`field '${name}' has no tier`);
      continue;
    }
    if (!isTier(f.tier)) errors.push(`field '${name}' has unknown tier '${f.tier}'`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// tags -> declared inputs
// ---------------------------------------------------------------------------

export function tagValues(tags: string[][], name: string): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === name && typeof t[1] === "string") out.push(t[1]);
  }
  return out;
}

export function uniqSorted(xs: string[]): string[] {
  return [...new Set(xs)].sort();
}

export interface DeclaredInputs {
  /** `cvm:req:<field>` values, sentinel stripped, sorted, deduped. */
  required: string[];
  /** `cvm:opt:<field>` values, sentinel stripped, sorted, deduped. */
  optional: string[];
  /** the `cvm:req:none` sentinel is present */
  noneSentinel: boolean;
  /** ADR-0001 D14 / rule 4: no `cvm:req:*` and no `cvm:opt:*` tag at all */
  unclassified: boolean;
}

export function declaredInputs(tags: string[][]): DeclaredInputs {
  const t = tagValues(tags, "t");
  const reqAll = t.filter((v) => v.startsWith(REQ_PREFIX)).map((v) => v.slice(REQ_PREFIX.length));
  const optAll = t.filter((v) => v.startsWith(OPT_PREFIX)).map((v) => v.slice(OPT_PREFIX.length));
  return {
    required: uniqSorted(reqAll.filter((f) => f !== "none")),
    optional: uniqSorted(optAll.filter((f) => f !== "none")),
    noneSentinel: reqAll.includes("none"),
    unclassified: reqAll.length === 0 && optAll.length === 0,
  };
}

// ---------------------------------------------------------------------------
// the recompute — "the field list is the truth"
// ---------------------------------------------------------------------------

export interface TierRecompute {
  /** `null` = unknown appetite (unclassified), NOT `none`. */
  tier: Tier | null;
  /** declared fields the register does not know (they fail loud) */
  unknown: string[];
  /** the fields the recompute was taken over, sorted */
  basis: string[];
}

export function recomputeTier(d: DeclaredInputs, vocab: Vocab): TierRecompute {
  if (d.unclassified) return { tier: null, unknown: [], basis: [] };
  const basis = uniqSorted([...d.required, ...d.optional]);
  const unknown = basis.filter((f) => !(f in vocab.fields));
  if (basis.length === 0) {
    // only the sentinel: nothing user-supplied -> the bottom of the ladder
    return { tier: "none", unknown: [], basis: [] };
  }
  let best: Tier = "none";
  for (const f of basis) {
    const declared = fieldTier(f, vocab);
    // an unknown field is never 'none': treat it at the most restrictive rank
    const tier: Tier = declared ?? "sensitive";
    best = higherTier(best, tier);
  }
  return { tier: best, unknown, basis };
}

/** Convenience: recompute straight from a tag list. */
export function recomputeTierFromTags(tags: string[][], vocab: Vocab): TierRecompute {
  return recomputeTier(declaredInputs(tags), vocab);
}

/** Server-side `#t` values for a UI shorthand, e.g. `no_personal_data`. */
export function tierPrefilter(shorthand: string): string[] {
  const tiers = TIER_SHORTHAND[shorthand];
  if (!tiers) throw new Error(`unknown tier shorthand '${shorthand}'`);
  return tiers.map((tier) => TIER_PREFIX + tier);
}
