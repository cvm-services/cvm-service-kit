/**
 * deepinfra_quote_test.ts — the cvm-deepinfra cost-quote contract.
 *
 * The top-up CVM must quote a DeepInfra cost from list rates WITHOUT a paid
 * call: flex is 20% cheaper (best-effort), priority 1.5x, cached prompt tokens
 * bill at the cached rate. Pure module, so no network is needed.
 *
 * Run: deno test --allow-read
 */
import {
  DEEPINFRA_DEEPSEEK_V41_FLASH,
  quoteCost,
  TIER_MULTIPLIER,
} from "../services/cvm-deepinfra/src/quote.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

Deno.test("quote: uncached input + output at list rates", () => {
  const q = quoteCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  const expected = 0.2 + 0.6; // $/M input + output
  assert(approx(q.usd, expected), `got ${q.usd}, want ${expected}`);
  assert(q.tier === "standard", `tier ${q.tier}`);
  assert(q.model === DEEPINFRA_DEEPSEEK_V41_FLASH.model, "model id");
});

Deno.test("quote: flex is exactly 20% cheaper", () => {
  const base = { inputTokens: 2_000_000, outputTokens: 500_000 };
  const std = quoteCost(base);
  const flex = quoteCost({ ...base, tier: "flex" });
  assert(TIER_MULTIPLIER.flex === 0.8, "flex multiplier");
  assert(approx(flex.usd, std.usd * 0.8, 1e-8), `flex ${flex.usd} vs ${std.usd * 0.8}`);
});

Deno.test("quote: priority is 1.5x", () => {
  const base = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  const std = quoteCost(base);
  const prio = quoteCost({ ...base, tier: "priority" });
  assert(approx(prio.usd, std.usd * 1.5, 1e-8), `priority ${prio.usd}`);
});

Deno.test("quote: cached input bills at the cached rate and clamps to input", () => {
  const q = quoteCost({
    inputTokens: 1_000_000,
    cachedInputTokens: 1_500_000, // over input -> clamped to 1M
    outputTokens: 0,
  });
  assert(q.cached_input_tokens === 1_000_000, `cached ${q.cached_input_tokens}`);
  assert(approx(q.usd, 0.006), `all-cached input ${q.usd} (want 0.006)`);
});

Deno.test("quote: zero tokens is zero", () => {
  const q = quoteCost({ inputTokens: 0, outputTokens: 0 });
  assert(q.usd === 0, `usd ${q.usd}`);
  assert(q.usd_per_m_blended === 0, "blended zero");
});
