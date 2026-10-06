import {
  CashuProcessor,
  ExplicitGate,
  RateLimiter,
  SqliteGateStore,
} from "../../../src/index.ts";
import { buildAiTools } from "../../_shared/ai.ts";
import { startService } from "../../_shared/start.ts";

async function main() {
  const env = process.env;
  const priceSats = Number(env.PRICE_CHAT_SATS ?? "5");
  const paymentMode = env.PAYMENT_MODE ?? "cashu";
  const gate =
    paymentMode === "cashu" && priceSats > 0
      ? new ExplicitGate(
          new CashuProcessor({ mintUrl: env.CASHU_MINT_URL ?? "https://testnut.cashu.exchange" }),
          new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-nanogpt/gate.sqlite"),
        )
      : undefined;

  const tools = buildAiTools({
    service: "nanogpt",
    cfg: {
      baseUrl: env.NANOGPT_BASE ?? "https://nano-gpt.com/api/v1",
      apiKey: env.NANOGPT_API_KEY,
      timeoutMs: 120_000,
    },
    priceSats,
    defaultModel: env.DEFAULT_MODEL ?? "openai/gpt-4.1-nano",
    gate,
    limiter: new RateLimiter({
      capacity: Number(env.RATE_CAPACITY ?? "10"),
      refillPerSec: Number(env.RATE_REFILL_PER_SEC ?? "1"),
    }),
  });

  await startService({
    name: "cvm-nanogpt",
    serviceClass: "ai",
    about: "Chat completions across 1000+ models, paid over ContextVM (CEP-8).",
    keywords: ["ai", "llm", "chat"],
    tools,
    defaultD: "cvm-nanogpt-01",
    env,
  });
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
