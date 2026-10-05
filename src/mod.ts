/**
 * cvm-service-kit — public surface.
 *
 * Build side: `emitAnnouncement` / `emitAnnouncementTags`.
 * Read side:  `assessAnnouncementTags` / `assertAnnouncementTags` /
 *             `recomputeTier` — one implementation of "the field list is the
 *             truth", shared by the emitter and any client.
 */

export {
  ANNOUNCEMENT_KIND,
  CLASS_PREFIX,
  declaredInputs,
  fieldTier,
  higherTier,
  isTier,
  NONE_SENTINEL,
  OPT_PREFIX,
  parseVocab,
  rankOf,
  recomputeTier,
  recomputeTierFromTags,
  REQ_PREFIX,
  tagValues,
  TIER_LADDER,
  TIER_PREFIX,
  TIER_RANKS,
  TIER_SHORTHAND,
  tierPrefilter,
  uniqSorted,
  uniqStrings,
  vocabErrors,
} from "./vocab.ts";

export type { DeclaredInputs, Tier, TierRecompute, Vocab, VocabField } from "./vocab.ts";

export { emitAnnouncement, emitAnnouncementTags } from "./announce.ts";
export type { AnnounceInput, EmittedAnnouncement, ToolCap } from "./announce.ts";

export {
  assertAnnouncementTags,
  assessAnnouncementTags,
  declaredFieldTags,
  surfacedRequirements,
} from "./validate.ts";
export type { Assessment } from "./validate.ts";
