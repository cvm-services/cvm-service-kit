import { createHash } from "node:crypto";
import {
  chatCompletions,
  listModels,
  type ExplicitGate,
  type FetchLike,
  type OpenAiConfig,
  type RateLimiter,
  type Tool,
} from "../../src/index.ts";

export interface AiDeps {
  service: string;
  cfg: OpenAiConfig;
  /** Fixed client price per chat call (sats). 0 = free. */
  priceSats: number;
  defaultModel: string;
  gate?: ExplicitGate;
  limiter?: RateLimiter;
  fetchImpl?: FetchLike;
}

function orderIdFor(caller: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${caller}\n${JSON.stringify(args.messages ?? args.prompt ?? "")}`)
    .digest("hex")
    .slice(0, 32);
}

/** Tools shared by OpenAI-compatible AI wrappers (NanoGPT, PayPerQ, …). */
export function buildAiTools(d: AiDeps): Tool[] {
  const chat: Tool = {
    definition: {
      name: "chat",
      description: "Chat completion via the proxied AI provider (paid per call).",
      priceSats: d.priceSats > 0 ? d.priceSats : undefined,
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: { role: { type: "string" }, content: { type: "string" } },
              required: ["role", "content"],
            },
          },
          prompt: { type: "string", description: "shorthand for a single user message" },
          model: { type: "string" },
          max_tokens: { type: "number" },
          order_id: { type: "string", description: "idempotency key for a paid call" },
          cashu_token: { type: "string" },
        },
      },
    },
    handler: async (args, ctx) => {
      d.limiter?.assert(ctx.caller);
      const messages =
        (args.messages as unknown[]) ??
        (args.prompt ? [{ role: "user", content: String(args.prompt) }] : []);
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("messages or prompt is required");
      }
      const run = async () => {
        const out = await chatCompletions(
          d.cfg,
          {
            model: String(args.model ?? d.defaultModel),
            messages,
            ...(args.max_tokens ? { max_tokens: Number(args.max_tokens) } : {}),
          },
          d.fetchImpl,
        );
        return {
          content: out?.choices?.[0]?.message?.content ?? out,
          model: out?.model ?? args.model ?? d.defaultModel,
          usage: out?.usage ?? null,
        };
      };
      if (!d.gate || d.priceSats <= 0) return run();
      const orderId = String(args.order_id ?? orderIdFor(ctx.caller, args));
      return d.gate.gate({
        tool: "chat",
        caller: ctx.caller,
        amountSats: d.priceSats,
        orderId,
        proof: typeof args.cashu_token === "string" ? args.cashu_token : undefined,
        run,
      });
    },
  };

  const models: Tool = {
    definition: {
      name: "models",
      description: "List available models from the provider.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: () => listModels(d.cfg, d.fetchImpl),
  };

  const availability: Tool = {
    definition: {
      name: "availability",
      description: "Report whether the AI service is configured and priced.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: () => ({
      status: d.cfg.apiKey ? "ok" : "unconfigured",
      service: d.service,
      price_sats: d.priceSats,
      default_model: d.defaultModel,
    }),
  };

  return [chat, models, availability];
}
