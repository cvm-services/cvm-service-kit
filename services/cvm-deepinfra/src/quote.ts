/**
 * quote.ts — DeepInfra DeepSeek-V4.1-Flash cost quote (pure, no network).
 *
 * DeepInfra's OpenAI-compatible endpoint bills per token; `service_tier:"flex"`
 * bills 20% less but is best-effort (docs: may wait up to 10 minutes, may 429),
 * and `priority` bills 50% more. These are the LIST rates ($/M tokens) for
 * deepseek-ai/DeepSeek-V4.1-Flash (2026-10-12).
 *
 * Pure + injectable so the top-up CVM can quote a cost without a paid call and
 * the logic is unit-tested without the network.
 */

export interface QuoteArgs {
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache hits (billed at the cached rate). Clamped to inputTokens. */
  cachedInputTokens?: number;
  tier?: "standard" | "flex" | "priority";
}

/** DeepInfra DeepSeek-V4.1-Flash list rates ($/M tokens). */
export const DEEPINFRA_DEEPSEEK_V41_FLASH = {
  model: "deepseek-ai/DeepSeek-V4.1-Flash",
  input: 0.2,
  cached_input: 0.006,
  output: 0.6,
} as const;

/** Service-tier multipliers (flex is best-effort, priority is SLA-backed). */
export const TIER_MULTIPLIER: Record<string, number> = {
  standard: 1.0,
  flex: 0.8,
  priority: 1.5,
};

export interface QuoteResult {
  model: string;
  tier: string;
  tier_multiplier: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  usd: number;
  usd_per_m_blended: number;
}

/** Quote the USD cost for a token estimate at the list rates × tier. */
export function quoteCost(a: QuoteArgs): QuoteResult {
  const rates = DEEPINFRA_DEEPSEEK_V41_FLASH;
  const tier = a.tier ?? "standard";
  const mul = TIER_MULTIPLIER[tier] ?? 1.0;
  const input = Math.max(0, a.inputTokens);
  const cached = Math.min(Math.max(0, a.cachedInputTokens ?? 0), input);
  const missInput = input - cached;
  const output = Math.max(0, a.outputTokens);
  const usd =
    ((missInput * rates.input + cached * rates.cached_input + output * rates.output) / 1e6) * mul;
  const totalTokens = input + output;
  return {
    model: rates.model,
    tier,
    tier_multiplier: mul,
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    usd: Number(usd.toFixed(8)),
    usd_per_m_blended: totalTokens > 0
      ? Number(((usd / totalTokens) * 1e6).toFixed(6))
      : 0,
  };
}
