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

async function main() {
  const env = process.env;
  const baseUrl = env.PPQ_BASE ?? "https://api.ppq.ai/v1";
  const apiKey = env.PPQ_API_KEY;
  const priceSats = Number(env.PRICE_CHAT_SATS ?? "5");
  const paymentMode = env.PAYMENT_MODE ?? "cashu";

  const gate =
    paymentMode === "cashu" && priceSats > 0
      ? new ExplicitGate(
          new CashuProcessor({ mintUrl: env.CASHU_MINT_URL ?? "https://testnut.cashu.exchange" }),
          new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-ppq/gate.sqlite"),
        )
      : undefined;

  const tools: Tool[] = buildAiTools({
    service: "ppq",
    cfg: { baseUrl, apiKey, timeoutMs: 120_000 },
    priceSats,
    defaultModel: env.DEFAULT_MODEL ?? "deepseek/deepseek-v3.2",
    gate,
    limiter: new RateLimiter({
      capacity: Number(env.RATE_CAPACITY ?? "10"),
      refillPerSec: Number(env.RATE_REFILL_PER_SEC ?? "1"),
    }),
  });

  // PPQ-specific: report the real prepaid balance (reseller treasury signal).
  tools.push({
    definition: {
      name: "balance",
      description: "Report the upstream PPQ prepaid credit balance (USD).",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      const r = await callHttp(
        {
          method: "POST",
          url: `${baseUrl}/credits/balance`,
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
          body: {},
        },
        {},
        { substitute: false },
      );
      return r.body ?? { error: `upstream ${r.status}` };
    },
  });

  await startService({
    name: "cvm-ppq",
    serviceClass: "ai",
    about: "Pay-per-query AI inference (500+ models), paid over ContextVM (CEP-8).",
    keywords: ["ai", "llm", "chat"],
    tools,
    defaultD: "cvm-ppq-01",
    env,
  });
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
