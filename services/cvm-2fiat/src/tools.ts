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
  refuse,
  type ExplicitGate,
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
}

const HANDOFF_INSTRUCTIONS =
  "Open the merchant checkout URL and pay with your own card (a 2fiat " +
  "prepaid Mastercard or any personal card). Card details go only into the " +
  "merchant's hosted payment page - never into a prompt, repo, or tool. " +
  "Answer any 3DS prompt yourself.";

function assertOwner(caller: string, ownerNpub: string): void {
  if (caller !== ownerNpub) {
    refuse("payment_required", {
      note: "card.balance answers to the service owner's key only",
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
      assertOwner(ctx.caller, d.ownerNpub);

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

  const docs: Tool = {
    definition: {
      name: "docs",
      description: "The cvm-2fiat contract (llms.txt), verbatim.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: (_args, _ctx) => hygieneWrap({ content: CONTRACT_TEXT }),
  };

  return [railInfo, quote, balance, docs];
}
