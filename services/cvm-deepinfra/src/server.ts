import {
  callHttp,
  CashuProcessor,
  ExplicitGate,
  RateLimiter,
  SqliteGateStore,
  type Tool,
} from "../../../src/index.ts";
import { buildAiTools } from "../../_shared/ai.ts";
import { startService } from "../../_shared/start.ts";
import { quoteCost } from "./quote.ts";

async function main() {
  const env = process.env;
  const baseUrl = env.DEEPINFRA_BASE ?? "https://api.deepinfra.com/v1/openai";
  const apiKey = env.DEEPINFRA_API_KEY;
  const priceSats = Number(env.PRICE_CHAT_SATS ?? "5");
  const paymentMode = env.PAYMENT_MODE ?? "cashu";
  const tier = (env.DEEPINFRA_SERVICE_TIER ?? "standard") as
    | "standard"
    | "flex"
    | "priority";

  const gate =
    paymentMode === "cashu" && priceSats > 0
      ? new ExplicitGate(
          new CashuProcessor({ mintUrl: env.CASHU_MINT_URL ?? "https://testnut.cashu.exchange" }),
          new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-deepinfra/gate.sqlite"),
        )
      : undefined;

  const tools: Tool[] = buildAiTools({
    service: "deepinfra",
    cfg: { baseUrl, apiKey, timeoutMs: 120_000 },
    priceSats,
    defaultModel: env.DEFAULT_MODEL ?? "deepseek-ai/DeepSeek-V4.1-Flash",
    gate,
    limiter: new RateLimiter({
      capacity: Number(env.RATE_CAPACITY ?? "10"),
      refillPerSec: Number(env.RATE_REFILL_PER_SEC ?? "1"),
    }),
  });

  // balance — DeepInfra exposes NO public balance endpoint (verified 2026-10-12:
  // /v1/user/balance, /v1/balance, /v1/usage all 404). Report account status via
  // /v1/me and state plainly that the credit balance is not readable.
  tools.push({
    definition: {
      name: "balance",
      description: "Report DeepInfra account status (credit balance is NOT exposed by upstream).",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      if (!apiKey) return { status: "unconfigured" };
      const apiRoot = baseUrl.replace(/\/v1\/openai\/?$/, "");
      try {
        const r = await callHttp(
          { method: "GET", url: `${apiRoot}/v1/me`, headers: { Authorization: `Bearer ${apiKey}` } },
          {},
          { substitute: false },
        );
        return r.body ?? { status: "error", upstream_status: r.status };
      } catch (e) {
        return { status: "error", error: String(e) };
      }
    },
  });

  // cost_quote — the top-up decision tool: price a token estimate at the list
  // rates + a service tier (flex is 20% cheaper).
  tools.push({
    definition: {
      name: "cost_quote",
      description: "Quote the DeepInfra cost (USD) for a token estimate (flex tier = -20%).",
      inputSchema: {
        type: "object",
        properties: {
          input_tokens: { type: "number" },
          cached_input_tokens: { type: "number" },
          output_tokens: { type: "number" },
          tier: { type: "string", enum: ["standard", "flex", "priority"] },
        },
        required: ["input_tokens", "output_tokens"],
      },
    },
    handler: (args) =>
      quoteCost({
        inputTokens: Number(args.input_tokens ?? 0),
        cachedInputTokens: Number(args.cached_input_tokens ?? 0),
        outputTokens: Number(args.output_tokens ?? 0),
        tier: (args.tier as "standard" | "flex" | "priority") ?? tier,
      }),
  });

  // topup — human-in-the-loop handoff (card/3DS). NOT account creation.
  tools.push({
    definition: {
      name: "topup",
      description: "Payment handoff URL + amount guidance for topping up DeepInfra.",
      inputSchema: { type: "object", properties: { amount_usd: { type: "number" } } },
    },
    handler: (args) => ({
      action: "human_required",
      reason: "DeepInfra top-up is a card/3DS step; no account API performs it.",
      billing_url: env.DEEPINFRA_BILLING_URL ?? "https://deepinfra.com/dash/billing",
      amount_usd: args.amount_usd ?? null,
      note: "Creation/charging cannot be automated (3DS/SCA wall); this service quotes and hands off.",
    }),
  });

  await startService({
    name: "cvm-deepinfra",
    serviceClass: "ai",
    about:
      "DeepInfra inference (DeepSeek-V4.1-Flash, flex tier) + cost quote, paid over ContextVM (CEP-8).",
    keywords: ["ai", "llm", "deepinfra", "deepseek"],
    tools,
    defaultD: "cvm-deepinfra-01",
    env,
    healthReport: () => ({
      status: apiKey ? "ok" : "unconfigured",
      price_sats: priceSats,
      service_tier: tier,
    }),
  });
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
