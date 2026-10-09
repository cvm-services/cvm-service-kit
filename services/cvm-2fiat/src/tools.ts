/**
 * tools.ts — the cvm-2fiat tool surface. Four tools, no more.
 *
 * Ordering rules that are properties, not policies (each has a RED test):
 *
 *  1. OWNER CHECK FIRST: card.balance refuses a non-owner pubkey before any
 *     adapter work happens (the adapter is the only thing that could touch a
 *     session, and it must not even be entered for a stranger).
 *  2. GATE BEFORE WORK: when the service runs in paid mode, the adapter call
 *     sits downstream of ExplicitGate.gate(); an unpaid call throws
 *     payment_required and the adapter is never entered.
 *  3. NOTHING CARD-SHAPED LEAVES: every response passes hygieneWrap; no tool
 *     accepts a card field, and the schema never mentions one.
 */
import { createHash } from "node:crypto";
import {
  HUMAN_STEP,
  payCheckoutGated,
  refuse,
  type Escalator,
  type ExplicitGate,
  type FiatIntentStore,
  type PayCheckoutAdapter,
  type Tool,
} from "../../../src/index.ts";
import type { LocalBalanceAdapter } from "./adapter.ts";
import { CONTRACT_TEXT } from "./contract.ts";
import {
  hygieneWrap,
  REFUSAL_LIST,
} from "./hygiene.ts";
import {
  TWOFIAT_ABOUT,
  TWOFIAT_SERVICE_CLASS,
} from "./announce-content.ts";

export interface TwoFiatDeps {
  /** The LOCAL adapter (operator's machine). undefined = unconfigured. */
  adapter?: LocalBalanceAdapter;
  /** Allow-listed owner pubkey (hex). Only this key may read the balance. */
  ownerNpub: string;
  /** Recording array the tests use to prove the adapter was (not) entered. */
  adapterCalls?: string[];
  /** Paid mode: >0 = card.balance costs this much and sits behind the gate. */
  priceSats?: number;
  /** The kit's ExplicitGate; required when priceSats > 0. */
  gate?: ExplicitGate;
  /**
   * The gated fiat path (card t_63be63f1). Absent = `card.pay_checkout` refuses
   * rail_unavailable: without these the sats cannot be settled, and a fiat spend
   * that cannot be proven settled must never happen.
   */
  fiat?: {
    /** Durable fiat intent store (the settlement state machine's fiat half). */
    store: FiatIntentStore;
    /** ADR-0012 escalator: DMs the CVM's own operator, never a new npub. */
    escalator: Escalator;
    /** Upper bound in sats on one checkout this service will settle for. */
    maxCheckoutSats?: number;
    /** Bounded window before an unresolved intent raises an operator alert. */
    unresolvedWindowMs?: number;
  };
}

const HANDOFF_INSTRUCTIONS =
  "Open the merchant checkout URL and pay with your own card (a 2fiat " +
  "prepaid Mastercard or any personal card). Card details go only into the " +
  "merchant's hosted payment page - never into a prompt, repo, or tool. " +
  "Answer any 3DS prompt yourself.";

function assertOwner(caller: string, ownerNpub: string, tool: string): void {
  if (caller !== ownerNpub) {
    refuse("payment_required", {
      note: `${tool} answers to the service owner's key only`,
    });
    // refuse() throws; this line is unreachable and exists for the type checker.
    throw new Error("owner check failed");
  }
}

function validCheckoutUrl(raw: unknown): URL {
  const s = typeof raw === "string" ? raw.trim() : "";
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error("checkout_url must be a valid https:// merchant checkout URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("checkout_url must be a valid https:// merchant checkout URL");
  }
  return url;
}

function requireString(raw: unknown, field: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) throw new Error(`${field} must be a non-empty string`);
  return s;
}

function requireSats(raw: unknown, field: string): number {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? ""));
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${field} must be a positive integer number of sats`);
  }
  return n;
}

/** Money is not binary: a fiat amount is a decimal string, at most 2 places. */
function requireDecimal(raw: unknown, field: string): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+(\.\d{1,2})?$/.test(s) || Number(s) <= 0) {
    throw new Error(`${field} must be a positive decimal with at most 2 places, e.g. '24.90'`);
  }
  return s;
}

export function buildTwoFiatTools(d: TwoFiatDeps): Tool[] {
  const record = (name: string) => d.adapterCalls?.push(name);

  const railInfo: Tool = {
    definition: {
      name: "card.rail_info",
      description:
        "What the 2fiat payment rail is and is NOT: informational, " +
        "best-effort, human-in-the-loop. No card-number disclosure, no " +
        "payment authorization, no charging - ever.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: (_args, _ctx) =>
      hygieneWrap({
        rail: "2fiat-card",
        class: `cvm:service:${TWOFIAT_SERVICE_CLASS}`,
        informational: true,
        tier: null,
        best_effort: true,
        what_it_is: TWOFIAT_ABOUT,
        what_it_is_not: [
          "no card-number disclosure: no PAN, CVV, expiry or last-4 is ever stored, logged or returned",
          "no payment authorization: no tool can charge anything; the human answers 3DS at the merchant checkout",
          "no card creation, no funding, no spend of any kind by this service",
        ],
        human_in_the_loop: "3DS at the merchant checkout",
        refusals: REFUSAL_LIST,
      }),
  };

  const quote: Tool = {
    definition: {
      name: "payment.quote",
      description:
        "Validate a merchant checkout URL and return the amount plus the " +
        "credential-free own-card hand-off instructions. Free. The charge " +
        "happens at the merchant's hosted checkout, not here.",
      inputSchema: {
        type: "object",
        required: ["checkout_url"],
        properties: {
          checkout_url: {
            type: "string",
            description: "https:// URL of the merchant's hosted checkout",
          },
          amount: { type: "string", description: "human-checked amount, e.g. '12.50'" },
          currency: { type: "string", description: "ISO 4217, e.g. 'EUR'" },
          merchant: { type: "string", description: "merchant name, optional label" },
        },
      },
    },
    handler: (args, _ctx) => {
      const url = validCheckoutUrl(args.checkout_url);
      return hygieneWrap({
        rail: "2fiat-card",
        checkout_url: url.toString(),
        amount: args.amount !== undefined ? String(args.amount) : undefined,
        currency: args.currency !== undefined ? String(args.currency) : undefined,
        merchant: args.merchant !== undefined ? String(args.merchant) : url.hostname,
        mode: "own-card hand-off (credential-free)",
        instructions: HANDOFF_INSTRUCTIONS,
        refusals: REFUSAL_LIST,
      });
    },
  };

  const balance: Tool = {
    definition: {
      name: "card.balance",
      description:
        "OWNER KEY ONLY: read the operator's card balance/status through a " +
        "LOCAL adapter. Returns {currency, amount, as_of}; no last-4, no PAN, " +
        "no CVV - ever. Refuses rail_unavailable when the adapter is not " +
        "configured; never invents a balance.",
      ...(d.priceSats && d.priceSats > 0 ? { priceSats: d.priceSats } : {}),
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "idempotency key for a paid call" },
          cashu_token: { type: "string", description: "Cashu token proving payment" },
        },
      },
    },
    handler: async (args, ctx) => {
      // 1. Owner check BEFORE any work - a stranger must not even cause an
      //    adapter dial.
      assertOwner(ctx.caller, d.ownerNpub, "card.balance");

      const doRead = async () => {
        // 2. Unconfigured adapter = honest refusal, never a fabricated number.
        if (!d.adapter) {
          refuse("rail_unavailable", {
            note: "the local balance adapter is not configured on this host",
          });
        }
        record("adapter.balance");
        const b = await d.adapter!.balance();
        return hygieneWrap({
          balance: { currency: b.currency, amount: b.amount, as_of: b.as_of },
          source: "local-adapter",
          owner_only: true,
        });
      };

      // 3. Paid mode: the adapter read sits DOWNSTREAM of the gate. An unpaid
      //    caller gets payment_required and the adapter is never entered.
      if (d.priceSats && d.priceSats > 0) {
        if (!d.gate) throw new Error("paid mode requires a gate");
        const orderId = String(
          args.order_id ??
            createHash("sha256")
              .update(`card.balance\n${ctx.caller}\n${new Date().toISOString().slice(0, 10)}`)
              .digest("hex")
              .slice(0, 32),
        );
        return d.gate.gate({
          tool: "card.balance",
          caller: ctx.caller,
          amountSats: d.priceSats,
          orderId,
          proof: typeof args.cashu_token === "string" ? args.cashu_token : undefined,
          run: doRead,
        });
      }
      return doRead();
    },
  };

  /**
   * The gated fiat leg (card t_63be63f1, ADR-0008). The card is the OPERATOR's
   * own money, so the owner check comes first and the sats gate comes before any
   * adapter work: this tool is the service boundary at which "no fiat spend
   * before the sats have settled" is true. The adapter itself knows nothing
   * about payments and is entered at most once per sats settlement.
   */
  const payCheckout: Tool = {
    definition: {
      name: "card.pay_checkout",
      description:
        "OWNER KEY ONLY: drive ONE checkout with the operator's own 2fiat card, " +
        "and only after the caller's sats payment has SETTLED. Enters the LOCAL " +
        "adapter at most once per sats settlement; a failed fiat leg is terminal " +
        "and escalates to the operator over Nostr DM (ADR-0012). The last step " +
        "(3DS/SCA and the 2fiat OTP) is completed by the operator in a browser: " +
        "no unattended fiat payment exists. Returns {status, order_id}; no card " +
        "material is ever accepted, stored, logged or returned.",
      inputSchema: {
        type: "object",
        required: [
          "order_id",
          "order_hash",
          "amount_sats",
          "sats_proof",
          "checkout_url",
          "max_amount",
        ],
        properties: {
          order_id: { type: "string", description: "idempotency key: one sats payment, one intent" },
          order_hash: {
            type: "string",
            description: "sha256 over the canonical order; binds the intent to what was ordered",
          },
          rail: { type: "string", description: "fiat rail that pays the venue, e.g. '2fiat-card'" },
          amount_sats: { type: "integer", description: "sats that must settle before any fiat spend" },
          sats_proof: {
            type: "string",
            description: "payment hash / proof reference of that sats payment (hashes only)",
          },
          cashu_token: { type: "string", description: "Cashu token proving the sats payment, if that is the pmi" },
          checkout_url: {
            type: "string",
            description: "https:// URL of the venue's own hosted checkout",
          },
          max_amount: {
            type: "string",
            description: "hard fiat cap for this checkout, e.g. '24.90' (never card material)",
          },
        },
      },
    },
    handler: async (args, ctx) => {
      // 1. The card is the operator's own money: owner first, before any work.
      assertOwner(ctx.caller, d.ownerNpub, "card.pay_checkout");

      // 2. Fail closed. Without a configured adapter, a durable intent store, or
      //    the gate that proves settlement, there is NO fiat path - never a
      //    fabricated outcome.
      if (!d.adapter || !d.fiat) {
        refuse("rail_unavailable", {
          note: "the local card adapter / fiat settlement path is not configured on this host",
        });
      }
      if (!d.gate) {
        refuse("rail_unavailable", {
          note: "no payment gate is configured: the sats payment cannot be verified, so no fiat spend may happen",
        });
      }

      const checkoutUrl = validCheckoutUrl(args.checkout_url);
      const orderId = requireString(args.order_id, "order_id");
      const orderHash = requireString(args.order_hash, "order_hash");
      const satsProof = requireString(args.sats_proof, "sats_proof");
      const rail = args.rail === undefined ? "2fiat-card" : requireString(args.rail, "rail");
      const amountSats = requireSats(args.amount_sats, "amount_sats");
      const maxAmount = requireDecimal(args.max_amount, "max_amount");
      const ceiling = d.fiat.maxCheckoutSats;
      if (ceiling !== undefined && amountSats > ceiling) {
        refuse("amount_too_large", {
          note: `amount_sats exceeds the configured checkout ceiling of ${ceiling} sats`,
        });
      }

      // 3. The adapter call, wrapped so the tests can prove whether it was
      //    entered. payCheckoutGated (the kit) owns the ordering: gate first,
      //    then at most one adapter entry.
      const adapter: PayCheckoutAdapter = {
        pay_checkout: (url, cap) => {
          record("adapter.pay_checkout");
          return d.adapter!.pay_checkout(url, cap);
        },
      };

      const out = await payCheckoutGated(
        {
          gate: d.gate,
          store: d.fiat.store,
          adapter,
          escalator: d.fiat.escalator,
          // ADR-0012: the operator identity ALREADY used by assertOwner().
          operatorNpub: d.ownerNpub,
          unresolvedWindowMs: d.fiat.unresolvedWindowMs,
        },
        {
          intentId: orderId,
          tool: "card.pay_checkout",
          caller: ctx.caller,
          orderHash,
          rail,
          satsAmount: amountSats,
          satsProof,
          fiatCap: maxAmount,
          checkoutUrl: checkoutUrl.toString(),
          proof: typeof args.cashu_token === "string" ? args.cashu_token : undefined,
        },
      );

      return hygieneWrap({
        status: out.status,
        order_id: out.order_id,
        intent_id: out.intent_id,
        rail,
        settled_sats: amountSats,
        fiat_cap: maxAmount,
        human_step: out.human_step ?? HUMAN_STEP,
        owner_only: true,
      });
    },
  };

  const docs: Tool = {
    definition: {
      name: "docs",
      description: "The cvm-2fiat contract (llms.txt), verbatim.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: (_args, _ctx) => hygieneWrap({ content: CONTRACT_TEXT }),
  };

  return [railInfo, quote, balance, payCheckout, docs];
}
