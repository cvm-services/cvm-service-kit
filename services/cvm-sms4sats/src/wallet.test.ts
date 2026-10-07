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
    client: new Sms4SatsClient({ baseUrl: "http://upstream.invalid" }),
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
    const { deps, orders } = depsFor({});
    const tools = buildSmsTools(deps);
    const create = tools.find((t) => t.definition.name === "create_sms_order")!;
    const caller = "b".repeat(64);
    await refusalOf(() => Promise.resolve(create.handler({ service: "tg" }, { caller })));
    // No order id may exist for this caller+args: nothing was half-sold.
    const derived = createHash("sha256")
      .update(`${caller}\ntg\nundefined\nreceive-sms`)
      .digest("hex")
      .slice(0, 32);
    expect(orders.get(derived)).toBeNull();
    expect(orders.get("tg")).toBeNull();
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
