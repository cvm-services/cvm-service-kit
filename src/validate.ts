/**
 * validate.ts — the reader side of the tag contract.
 *
 * "The field list is the truth": this module recomputes the tier from the
 * declared `cvm:req:*`/`cvm:opt:*` fields and reports any disagreement with the
 * published `cvm:tier:<max>` tag. The recomputed value is the EFFECTIVE one —
 * a lying aggregate is exactly the failure the register exists to prevent
 * (docs/spec/service-inputs.md, "The tier tag").
 */

import {
  type DeclaredInputs,
  declaredInputs,
  isTier,
  OPT_PREFIX,
  rankOf,
  recomputeTier,
  REQ_PREFIX,
  tagValues,
  type Tier,
  TIER_PREFIX,
  TIER_RANKS,
  type Vocab,
} from "./vocab.ts";

export interface Assessment {
  /** `cvm:tier:*` values found, in tag order, deduped, sorted */
  declaredTiers: string[];
  /** max over the declared fields; `null` = unknown appetite (unclassified) */
  recomputed: Tier | null;
  /** the value a conforming reader must use: recomputed wins, never the tag */
  effective: Tier | null;
  /** the published tag disagrees with the recomputed value */
  tierMismatch: boolean;
  declaredInputs: DeclaredInputs;
  /** declared field names the register does not know */
  unknownFields: string[];
  /** hard contract breaches — an announcement with any is non-conforming */
  violations: string[];
  /** advisory findings a UI should surface but that do not break the contract */
  warnings: string[];
}

export function assessAnnouncementTags(tags: string[][], vocab: Vocab): Assessment {
  const inputs = declaredInputs(tags);
  const rec = recomputeTier(inputs, vocab);
  const declaredTiers = [
    ...new Set(
      tagValues(tags, "t")
        .filter((v) => v.startsWith(TIER_PREFIX))
        .map((v) => v.slice(TIER_PREFIX.length)),
    ),
  ].sort();

  const violations: string[] = [];
  const warnings: string[] = [];

  for (const t of declaredTiers) {
    if (!isTier(t)) violations.push(`cvm:tier:${t} is not a ladder value`);
  }
  const known = declaredTiers.filter(isTier);

  if (inputs.unclassified) {
    if (declaredTiers.length > 0) {
      violations.push(
        "a cvm:tier tag is published but no cvm:req:*/cvm:opt:* tag exists (absent is not 'none')",
      );
    }
  } else if (known.length !== 1) {
    violations.push(`expected exactly one cvm:tier tag, found ${known.length}`);
  }

  const tierMismatch = !inputs.unclassified && known.length === 1 && rec.tier !== null &&
    known[0] !== rec.tier;
  if (tierMismatch) {
    violations.push(
      `tier tag says '${known[0]}' but the declared fields recompute to '${rec.tier}' ` +
        "(the field list is the truth; use the recomputed value)",
    );
  }

  if (rec.unknown.length > 0) {
    violations.push(
      `unknown requirement field(s): ${rec.unknown.join(", ")} ` +
        "(unknown fails loud and is never counted as cvm:req:none)",
    );
  }

  const both = inputs.required.filter((f) => inputs.optional.includes(f));
  if (both.length > 0) {
    violations.push(`field(s) declared both required and optional: ${both.join(", ")}`);
  }

  // Advisory only: the spec publishes the sentinel as the tag form of
  // "tiers none/financial only" (the coffee-kiosk example carries
  // `cvm:req:none` together with `cvm:req:payment.amount`), but it does not
  // make the sentinel's presence a MUST for the reader. Surface, do not block.
  const effective = rec.tier;
  if (!inputs.unclassified && effective !== null) {
    const noPersonalData = TIER_RANKS[effective] <= TIER_RANKS.financial;
    if (noPersonalData && !inputs.noneSentinel) {
      warnings.push(
        "tier is none/financial but no cvm:req:none sentinel is published " +
          "(the shorthand reads cvm:req:none as 'none/financial only')",
      );
    }
    if (!noPersonalData && inputs.noneSentinel) {
      warnings.push(
        `cvm:req:none sentinel published although the recomputed tier is '${effective}'`,
      );
    }
  }

  return {
    declaredTiers,
    recomputed: rec.tier,
    effective,
    tierMismatch,
    declaredInputs: inputs,
    unknownFields: rec.unknown,
    violations,
    warnings,
  };
}

/** Throws on a non-conforming announcement; returns the assessment otherwise. */
export function assertAnnouncementTags(tags: string[][], vocab: Vocab): Assessment {
  const a = assessAnnouncementTags(tags, vocab);
  if (a.violations.length > 0) {
    throw new Error("announcement violates the tag contract:\n - " + a.violations.join("\n - "));
  }
  return a;
}

/**
 * A reader that meets an unrecognised `cvm:req:*` value must surface it as an
 * unknown requirement (rule 3) — never silently drop it. This is the list a UI
 * renders, with the unknown names kept visible.
 */
export function surfacedRequirements(a: Assessment): {
  required: string[];
  optional: string[];
  unknown: string[];
  unclassified: boolean;
} {
  return {
    required: a.declaredInputs.required,
    optional: a.declaredInputs.optional,
    unknown: a.unknownFields,
    unclassified: a.declaredInputs.unclassified,
  };
}

/** The declared field names as they appear on the wire (for diagnostics). */
export function declaredFieldTags(tags: string[][]): string[] {
  return [
    ...new Set(
      tagValues(tags, "t").filter((v) => v.startsWith(REQ_PREFIX) || v.startsWith(OPT_PREFIX)),
    ),
  ].sort();
}

export { rankOf };
