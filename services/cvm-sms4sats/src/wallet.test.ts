import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  CashuProcessor,
  ExplicitGate,
  SqliteOrderStore,
  Treasury,
  REFUSALS,
  walletFromEnv,
} from "../../../src/index.ts";
import { buildSmsTools, treasuryHealthReport, type SmsDeps } from "./tools.ts";
import { Sms4SatsClient } from "./upstream.ts";

/**
 * The production honesty contract for the treasury rail:
 *
 *  (a) with no wallet configured, the PAID path refuses rail_unavailable —
 *      it must never mint a client invoice it cannot back with real sats,
 *      and must never "pay" an upstream invoice with a fake preimage;
 *  (b) availability/health must not invent a treasury balance;
 *  (c) with a real wallet configured, the real balance is stated.
 */

function depsFor(opts: {
  nwcUrl?: string;
  walletBalanceSats?: number;
  /** Upstream client; defaults to an unreachable host. */
  client?: Sms4SatsClient;
}): { deps: SmsDeps; orders: SqliteOrderStore } {
  // Production shape: the treasury is built from walletFromEnv — real wallet
  // when NWC_URL is set, NO wallet otherwise (never a fake stand-in).
  const sel = walletFromEnv(opts.nwcUrl ? { NWC_URL: opts.nwcUrl } : {});
  // A test double stands in for NwcLnWallet (which needs a live relay);
  // it is injected through the same seam the server uses.
  const wallet = opts.walletBalanceSats !== undefined ? fakeWallet(opts.walletBalanceSats) : sel.wallet;
  const treasury = new Treasury(wallet, { floorSats: 1000 });
  const orders = new SqliteOrderStore(":memory:");
  const deps: SmsDeps = {
    client: opts.client ?? new Sms4SatsClient({ baseUrl: "http://upstream.invalid" }),
    wallet,
    treasury,
    orders,
    pricing: { markup: 0.2, minSats: 1 },
    gate: new ExplicitGate(new CashuProcessor({ mintUrl: "https://mint.invalid" })),
    rail: sel.rail,
  };
  return { deps, orders };
}

function fakeWallet(balance: number) {
  return {
    async payInvoice() {
      return { preimage: "test" };
    },
    async makeInvoice(sats: number) {
      return { bolt11: `lnbc${sats}n1test`, paymentHash: "test" };
    },
    async balanceSats() {
      return balance;
    },
  };
}

const REAL_NWC_URI =
  "nostr+walletconnect://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?relay=wss%3A%2F%2Fwallet.example&secret=000102030405060708090a0b0c0d0e0f&encryption=nip44";

/**
 * An upstream that WOULD mint an order (402 quote) over the same fetchImpl
 * seam tools.test.ts uses. The mint-guard tests must run against a reachable
 * upstream: an unreachable one can never mint anything, so "no order exists"
 * would pass vacuously regardless of the guard.
 */
function answeringClient(calls: { requestOrder: number }) {
  const fetchImpl = async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/v2/l402/order")) {
      calls.requestOrder++;
      return {
        status: 402,
        ok: false,
        headers: new Headers(),
        text: async () =>
          JSON.stringify({ macaroon: "mac", invoice: "lnbc50n1x", priceSats: 50, orderId: "up-1" }),
      } as any;
    }
    return {
      status: 404,
      ok: false,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: "no route" }),
    } as any;
  };
  return new Sms4SatsClient({ fetchImpl: fetchImpl as any });
}

interface RailRefusal {
  code: number;
  reason: string;
  data: Record<string, unknown>;
}

async function refusalOf(fn: () => Promise<unknown>): Promise<RailRefusal | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    const r = e as { reason?: string; code?: number; data?: Record<string, unknown> };
    if (r && r.reason === "rail_unavailable") {
      return { code: r.code!, reason: r.reason!, data: r.data ?? {} };
    }
    throw e;
  }
}

describe("(a) unconfigured wallet — the paid path refuses rail_unavailable", () => {
  test("create_sms_order refuses rail_unavailable BEFORE minting any order", async () => {
    const { deps } = depsFor({}); // no NWC_URL at all
    const tools = buildSmsTools(deps);
    const create = tools.find((t) => t.definition.name === "create_sms_order")!;
    expect(create).toBeTruthy();

    const r = await refusalOf(() =>
      Promise.resolve(create.handler({ service: "tg" }, { caller: "a".repeat(64) }))
    );
    expect(r).not.toBeNull();
    expect(r!.code).toBe(REFUSALS.rail_unavailable.code);
    expect(r!.data.rail).toBe("nwc");
  });

  test("an unconfigured service mints NO order (nothing half-sold)", async () => {
    // Reachable upstream that WOULD answer a 402 quote — otherwise this test
    // is vacuous: an unreachable host can never mint an order anyway.
    const calls = { requestOrder: 0 };
    const { deps, orders } = depsFor({ client: answeringClient(calls) });
    const tools = buildSmsTools(deps);
    const create = tools.find((t) => t.definition.name === "create_sms_order")!;
    const caller = "b".repeat(64);
    await refusalOf(() => Promise.resolve(create.handler({ service: "tg" }, { caller })));
    // No order id may exist for this caller+args: nothing was half-sold.
    // Digest field order must mirror deriveOrderId exactly:
    //   `${caller}\n${args.country}\n${args.service}\n${args.type ?? "receive-sms"}`
    // — for handler({service:"tg"}) that is `caller\nundefined\ntg\nreceive-sms`.
    const derived = createHash("sha256")
      .update(`${caller}\nundefined\ntg\nreceive-sms`)
      .digest("hex")
      .slice(0, 32);
    expect(orders.get(derived)).toBeNull();
    // And the upstream was never even asked for a quote: the guard fires
    // BEFORE requestOrder, so no order can be half-sold on the upstream side.
    expect(calls.requestOrder).toBe(0);
  });

  test("control: the same upstream DOES mint when the rail is configured", async () => {
    // Non-vacuity control for the test above: with a real wallet selected,
    // the same answering client mints an order and requestOrder IS called.
    // This proves the fixture can be won — "mints NO order" above fails on
    // guard placement, not on an upstream that could never mint anything.
    const calls = { requestOrder: 0 };
    const { deps, orders } = depsFor({
      nwcUrl: REAL_NWC_URI,
      walletBalanceSats: 250_000,
      client: answeringClient(calls),
    });
    const tools = buildSmsTools(deps);
    const create = tools.find((t) => t.definition.name === "create_sms_order")!;
    const caller = "c".repeat(64);
    // Unpaid caller: the gate demands payment AFTER the order is minted —
    // PaymentRequiredError is expected and swallowed (refusalOf rethrows it).
    // refund_invoice is REQUIRED by the live upstream API (see PR #9); the
    // field check runs before the gate, so it must be present for the order
    // to be minted at all.
    await refusalOf(() =>
      Promise.resolve(
        create.handler(
          { service: "tg", country: "US", refund_invoice: "lnbc1noamountvalid30m" },
          { caller },
        ),
      )
    ).catch(() => {});
    const derived = createHash("sha256")
      .update(`${caller}\nUS\ntg\nreceive-sms`)
      .digest("hex")
      .slice(0, 32);
    expect(calls.requestOrder).toBe(1);
    expect(orders.get(derived)?.status).toBe("pending_payment");
  });
});

describe("(b) availability does not invent a balance", () => {
  test("no wallet -> rail_unavailable status, NO treasury_balance_sats key", async () => {
    const { deps } = depsFor({});
    const tools = buildSmsTools(deps);
    const availability = tools.find((t) => t.definition.name === "availability")!;
    const out = (await availability.handler({}, { caller: "cc".repeat(32) })) as Record<string, unknown>;

    expect("treasury_balance_sats" in out).toBe(false);
    expect(out.status).toBe("rail_unavailable");
    expect(out.rail).toBe("nwc");
  });

  test("the health payload builder never states a fabricated balance", async () => {
    const { deps: d1 } = depsFor({});
    const { deps: d2 } = depsFor({ nwcUrl: REAL_NWC_URI, walletBalanceSats: 1234 });

    // treasuryHealthReport is the ONE builder both the /health endpoint and
    // the availability tool use; test it directly so the shapes cannot drift.
    const unconfigured = await treasuryHealthReport(d1.treasury, 1);
    expect("treasury_balance_sats" in unconfigured).toBe(false);
    expect(unconfigured.status).toBe("rail_unavailable");
    expect(unconfigured.rail).toBe("nwc");

    const configured = await treasuryHealthReport(d2.treasury, 1);
    expect(configured.treasury_balance_sats).toBe(1234);
    expect(configured.status).toBe("ok");
  });
});

describe("(c) configured wallet — the real balance is stated", () => {
  test("availability reports the wallet's real balance", async () => {
    const { deps } = depsFor({ nwcUrl: REAL_NWC_URI, walletBalanceSats: 250_000 });
    const tools = buildSmsTools(deps);
    const availability = tools.find((t) => t.definition.name === "availability")!;
    const out = (await availability.handler({}, { caller: "dd".repeat(32) })) as Record<string, unknown>;
    expect(out.treasury_balance_sats).toBe(250_000);
    expect(out.status).toBe("ok");
  });

  test("low real balance is reported as low_treasury, still the real number", async () => {
    const { deps } = depsFor({ nwcUrl: REAL_NWC_URI, walletBalanceSats: 500 }); // below floor 1000
    const tools = buildSmsTools(deps);
    const availability = tools.find((t) => t.definition.name === "availability")!;
    const out = (await availability.handler({}, { caller: "ee".repeat(32) })) as Record<string, unknown>;
    expect(out.status).toBe("low_treasury");
    expect(out.treasury_balance_sats).toBe(500);
  });
});
