/**
 * announce.ts — the CEP-6 announcement emitter.
 *
 * The emitter builds the discoverable surface of a ContextVM service: the
 * namespaced class tag, the declared input tags, and the tier tag. It is the
 * build-side counterpart of `validate.ts`, and it deliberately has ONE rule that
 * cannot be worked around:
 *
 *   **the caller cannot supply the tier.** `AnnounceInput` carries the declared
 *   fields; the emitter computes `cvm:tier:<max>` from them with the same
 *   `recomputeTier` a reader uses. A caller that could pass a tier could publish
 *   a lying aggregate, which is the exact failure the register exists to
 *   prevent (docs/spec/service-inputs.md).
 *
 * Everything is dependency-free and deterministic: the same input yields a
 * byte-identical tag list, which is what makes a re-publish idempotent.
 */

import {
  ANNOUNCEMENT_KIND,
  CLASS_PREFIX,
  type DeclaredInputs,
  NONE_SENTINEL,
  OPT_PREFIX,
  recomputeTier,
  REQ_PREFIX,
  type Tier,
  TIER_PREFIX,
  TIER_RANKS,
  type Vocab,
} from "./vocab.ts";
import { assessAnnouncementTags } from "./validate.ts";

/** `["cap","tool:<name>","<amount>","<unit>"]` — P4: per-tool prices. */
export interface ToolCap {
  amount: number;
  /** defaults to "sats"; the client asserts the invoice equals this cap */
  unit?: string;
}

export interface AnnounceInput {
  /** short lowercase kebab class, e.g. "restaurant", "ev-charger" */
  serviceClass: string;
  /** stable, human-meaningful slug — ADR-0001 / P1 */
  d: string;
  /**
   * Pre-computed geohash precisions of ONE point (P2: `#g` is exact match, so
   * precision must be baked in by the publisher). Two or more are required when
   * the service has a fixed location; omit entirely for no fixed location.
   */
  geohashes?: string[];
  /** `cvm:req:<field>` — required by the flow */
  required?: string[];
  /** `cvm:opt:<field>` — accepted, not required */
  optional?: string[];
  /** per-tool `cap` prices */
  tools?: Record<string, ToolCap>;
  /** claimed registries, as `30000:<curator-hex-or-npub>:<slug>` (P2/P12) */
  registries?: string[];
  /** `["r","<url>"]` docs/endpoint links */
  urls?: string[];
  /** plain human `t` words (["burgers","berlin"]); MUST NOT be namespaced */
  humanTags?: string[];
  /** JSON content for the 11316 (name, about, items, rail, ...) */
  content?: unknown;
  /**
   * Emit a field the register does not know instead of refusing. Off by
   * default: an unknown field means the register needs a new entry, and the
   * honest failure is to stop, not to publish a tag no reader can classify.
   */
  allowUnknownFields?: boolean;
}

export interface EmittedAnnouncement {
  kind: number;
  /** deterministic: ["d"], classes, human, req, opt, sentinel, tier, g, cap, a, r */
  tags: string[][];
  content: string;
  /** the computed tier — always the recomputed max, never a caller's claim */
  tier: Tier;
  warnings: string[];
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

export function emitAnnouncement(
  input: AnnounceInput,
  vocab: Vocab,
): EmittedAnnouncement {
  const { tags, warnings, tier } = emitAnnouncementTags(input, vocab);
  return {
    kind: ANNOUNCEMENT_KIND,
    tags,
    content: input.content === undefined ? "" : JSON.stringify(input.content),
    tier,
    warnings,
  };
}

export function emitAnnouncementTags(
  input: AnnounceInput,
  vocab: Vocab,
): { tags: string[][]; warnings: string[]; tier: Tier } {
  const warnings: string[] = [];

  // --- class + slug -------------------------------------------------------
  const serviceClass = (input.serviceClass ?? "").trim();
  if (!KEBAB.test(serviceClass) || serviceClass.includes(":")) {
    throw new Error(
      `serviceClass '${input.serviceClass}' is not a short lowercase kebab token (P2)`,
    );
  }
  const d = (input.d ?? "").trim();
  if (!d || /\s/.test(d)) {
    throw new Error(`d slug '${input.d}' is empty or contains whitespace (P1)`);
  }

  // --- declared fields ----------------------------------------------------
  const required = cleanFields(input.required ?? [], "required", warnings);
  const optional = cleanFields(input.optional ?? [], "optional", warnings);
  const both = required.filter((f) => optional.includes(f));
  if (both.length > 0) {
    throw new Error(`field(s) declared both required and optional: ${both.join(", ")}`);
  }
  for (const f of [...required, ...optional]) {
    if (!(f in vocab.fields)) {
      if (!input.allowUnknownFields) {
        throw new Error(
          `unknown requirement field '${f}': not in the register ` +
            `(vocab/service-inputs.json). Add it to the register, or pass ` +
            `allowUnknownFields to emit it at the most restrictive tier — never as 'none'.`,
        );
      }
      warnings.push(
        `unknown requirement field '${f}': emitted at the most restrictive tier and flagged ` +
          "(rule 3: unknown fails loud, never cvm:req:none)",
      );
    }
  }

  // --- the tier is COMPUTED, never supplied ------------------------------
  const declared: DeclaredInputs = {
    required,
    optional,
    // sentinel presence does not affect the recompute (it contributes no field)
    noneSentinel: required.length === 0,
    unclassified: false,
  };
  const rec = recomputeTier(declared, vocab);
  const tier = rec.tier ?? "none";

  // --- geohash precisions -------------------------------------------------
  const geohashes = (input.geohashes ?? []).map((g) => g.trim());
  if (geohashes.length === 1) {
    throw new Error(
      "geohashes: exactly one precision given — #g is exact match, publish two or more " +
        "precisions of the same point (P2), or none if the service has no fixed location",
    );
  }
  if (geohashes.length > 1) {
    const longest = [...geohashes].sort((a, b) => b.length - a.length)[0];
    for (const g of geohashes) {
      if (!g || !/^[0-9b-hjkmnp-z]+$/.test(g)) throw new Error(`geohash '${g}' is not a geohash`);
      if (!longest.startsWith(g)) {
        throw new Error(
          `geohash '${g}' is not a prefix of '${longest}': the precisions must describe ONE point`,
        );
      }
    }
  }

  // --- assemble, deterministic order --------------------------------------
  const tags: string[][] = [];
  tags.push(["d", d]);
  tags.push(["t", CLASS_PREFIX + serviceClass]);
  for (const w of dedupeLower(input.humanTags ?? [])) {
    if (w.includes(":")) throw new Error(`human t word '${w}' is namespaced; use the class field`);
    tags.push(["t", w]);
  }
  for (const f of required) tags.push(["t", REQ_PREFIX + f]);
  for (const f of optional) tags.push(["t", OPT_PREFIX + f]);
  // Sentinel rule: the sentinel is the tag form of "tiers none/financial only"
  // (spec, "The tier tag" + filter shorthand). Emit it exactly when the
  // recomputed tier is none or financial; never alongside a higher tier.
  if (TIER_RANKS[tier] <= TIER_RANKS.financial) tags.push(["t", NONE_SENTINEL]);
  tags.push(["t", TIER_PREFIX + tier]);
  for (
    const g of [...new Set(geohashes)].sort((a, b) => a.length - b.length || a.localeCompare(b))
  ) {
    tags.push(["g", g]);
  }
  for (
    const [tool, cap] of Object.entries(input.tools ?? {}).sort(([a], [b]) => a.localeCompare(b))
  ) {
    if (!tool.trim()) throw new Error("cap: tool name is empty");
    if (!Number.isFinite(cap?.amount) || cap.amount < 0) {
      throw new Error(`cap: tool '${tool}' has a non-finite or negative amount`);
    }
    tags.push(["cap", `tool:${tool}`, String(cap.amount), cap.unit ?? "sats"]);
  }
  for (const a of input.registries ?? []) tags.push(["a", a]);
  for (const r of dedupeLower(input.urls ?? [])) tags.push(["r", r]);

  // --- self-check: the emitter can never emit a non-conforming set --------
  const assessment = assessAnnouncementTags(tags, vocab);
  // The one documented, explicit exception: `allowUnknownFields` already made
  // the caller opt in to an unknown field, and `warnings` reports it loud. It
  // is not a kit bug, so it does not abort the self-check here.
  const violations = assessment.violations.filter((v) =>
    !(input.allowUnknownFields && v.startsWith("unknown requirement field"))
  );
  if (violations.length > 0) {
    throw new Error(
      "emitter produced a non-conforming announcement (this is a kit bug):\n - " +
        violations.join("\n - "),
    );
  }
  if (assessment.tierMismatch || assessment.effective !== tier) {
    throw new Error("emitter produced a tier that does not recompute (this is a kit bug)");
  }
  warnings.push(...assessment.warnings);
  return { tags, warnings, tier };
}

function cleanFields(fields: string[], side: string, warnings: string[]): string[] {
  const out: string[] = [];
  for (const raw of fields) {
    const f = String(raw).trim();
    if (f === "none") {
      // the sentinel is not a field; the emitter derives it from the tier
      warnings.push(
        `'cvm:req:none' passed as a ${side} field: ignored (the emitter derives the sentinel)`,
      );
      continue;
    }
    if (!FIELD.test(f)) {
      throw new Error(`${side} field '${raw}' is not domain.field lowercase snake_case`);
    }
    if (!out.includes(f)) out.push(f);
  }
  return out.sort();
}

function dedupeLower(xs: string[]): string[] {
  return [...new Set(xs.map((x) => String(x).trim()).filter(Boolean))];
}
