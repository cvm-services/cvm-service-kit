import { createHash } from "node:crypto";
import {
  costToClient,
  type ExplicitGate,
  type LnWallet,
  type OrderStore,
  type PricingConfig,
  type Tool,
  type Treasury,
} from "../../../src/index.ts";
import type { Sms4SatsClient } from "./upstream.ts";

export interface SmsDeps {
  client: Sms4SatsClient;
  wallet: LnWallet;
  treasury: Treasury;
  orders: OrderStore;
  pricing: PricingConfig;
  gate: ExplicitGate;
  poll?: { intervalMs?: number; attempts?: number };
}

function deriveOrderId(caller: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${caller}\n${args.country}\n${args.service}\n${args.type ?? "receive-sms"}`)
    .digest("hex")
    .slice(0, 32);
}

export function buildSmsTools(d: SmsDeps): Tool[] {
  const orderIdFor = (caller: string, args: Record<string, unknown>) =>
    String(args.order_id ?? deriveOrderId(caller, args));

  const availability: Tool = {
    definition: {
      name: "availability",
      description: "Report whether the service can currently fulfil orders.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      const balance = await d.treasury.balanceSats();
      const ok = await d.treasury.canSpend(d.pricing.minSats);
      return { status: ok ? "ok" : "low_treasury", treasury_balance_sats: balance };
    },
  };

  const listServices: Tool = {
    definition: {
      name: "list_services",
      description: "List the service codes sms4sats supports (tg, go, wa, …).",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      const r = await d.client.services();
      return r.body ?? r.raw;
    },
  };

  const catalog: Tool = {
    definition: {
      name: "catalog",
      description: "List SMS/rent offers by country and service code.",
      inputSchema: {
        type: "object",
        properties: {
          country: { type: "string" },
          service: { type: "string" },
        },
      },
    },
    handler: (args) =>
      d.client.catalog(
        args.country ? String(args.country) : undefined,
        args.service ? String(args.service) : undefined,
      ).then((r) => r.body ?? r.raw),
  };

  const create: Tool = {
    definition: {
      name: "create_sms_order",
      description:
        "Order a one-time SMS verification number and return the received code. Paid via CEP-8 (Cashu).",
      priceSats: undefined, // variable price; see payment_required response
      inputSchema: {
        type: "object",
        required: ["service"],
        properties: {
          service: { type: "string", description: "service code, e.g. tg" },
          country: { type: "string", description: "ISO code or 'auto'" },
          refund_invoice: { type: "string", description: "no-amount BOLT11 for refunds" },
          order_id: { type: "string", description: "idempotency key" },
          cashu_token: { type: "string", description: "Cashu token proving payment" },
        },
      },
    },
    handler: async (args, ctx) => {
      const orderId = orderIdFor(ctx.caller, args);

      let order = d.orders.get(orderId);
      if (!order) {
        const quote = await d.client.requestOrder({
          type: "receive-sms",
          country: args.country ?? "auto",
          service: args.service,
          ...(args.refund_invoice ? { refundInvoice: args.refund_invoice } : {}),
        });
        if (quote.status !== 402 || !quote.challenge || !quote.orderId) {
          throw new Error(`upstream rejected order: ${JSON.stringify(quote.raw)}`);
        }
        const priced = costToClient(quote.costSats, d.pricing);
        order = d.orders.createOrGet({
          orderId,
          service: "sms4sats",
          tool: "create_sms_order",
          caller: ctx.caller,
          costSats: quote.costSats,
          priceSats: priced.priceSats,
          status: "pending_payment",
          upstreamRef: JSON.stringify({
            orderId: quote.orderId,
            macaroon: quote.challenge.macaroon,
            invoice: quote.challenge.invoice,
          }),
          resultJson: null,
          error: null,
        });
      }

      await d.treasury.assertCanSpend(order.costSats ?? 0);
      const upstream = JSON.parse(order.upstreamRef!);

      return d.gate.gate({
        tool: "create_sms_order",
        caller: ctx.caller,
        amountSats: order.priceSats,
        orderId,
        proof: typeof args.cashu_token === "string" ? args.cashu_token : undefined,
        run: async () => {
          d.treasury.recordSpend(order!.costSats ?? 0);
          d.orders.update(orderId, { status: "fulfilling" });
          const res = await d.client.payAndPoll(
            upstream.orderId,
            { macaroon: upstream.macaroon, invoice: upstream.invoice },
            d.wallet,
            d.poll,
          );
          const done = res?.status === "completed" || res?.status === "code_received";
          d.orders.update(orderId, {
            status: done ? "fulfilled" : "failed",
            resultJson: JSON.stringify(res),
            error: done ? null : (res?.status ?? "unknown"),
          });
          return res;
        },
      });
    },
  };

  const status: Tool = {
    definition: {
      name: "order_status",
      description: "Return the status/result of a previously created SMS order.",
      inputSchema: {
        type: "object",
        required: ["order_id"],
        properties: { order_id: { type: "string" } },
      },
    },
    handler: (args) => {
      const o = d.orders.get(String(args.order_id));
      if (!o) return { error: "unknown order_id" };
      return {
        order_id: o.orderId,
        status: o.status,
        price_sats: o.priceSats,
        result: o.resultJson ? JSON.parse(o.resultJson) : null,
        error: o.error,
      };
    },
  };

  return [availability, listServices, catalog, create, status];
}
