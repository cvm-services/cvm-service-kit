import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExplicitGate,
  FakeLnWallet,
  PaymentRequiredError,
  SqliteOrderStore,
  Treasury,
  type Invoice,
  type PaymentProcessor,
} from "../../../src/index.ts";
import { Sms4SatsClient } from "./upstream.ts";
import { buildSmsTools, type SmsDeps } from "./tools.ts";

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "bitcoin-cashu";
  constructor(private paid: boolean) {}
  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return { orderId: a.orderId, paymentHash: "h", amountSats: a.amountSats, request: "cashu:test", pmi: this.pmi };
  }
  async verify(): Promise<boolean> {
    return this.paid;
  }
}

function res(status: number, body: any) {
  return { status, ok: status < 400, headers: new Headers(), text: async () => JSON.stringify(body) } as any;
}

function mkClient() {
  const f = async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    if (method === "POST" && url.includes("/v2/l402/order")) {
      return res(402, { macaroon: "mac", invoice: "lnbc50n1x", priceSats: 50, orderId: "ord-1" });
    }
    if (method === "GET" && url.includes("/v2/l402/order/ord-1")) {
      return res(200, { status: "completed", code: "1234" });
    }
    return res(404, { error: "no route" });
  };
  return new Sms4SatsClient({ fetchImpl: f as any });
}

function deps(paid: boolean, pricing = { markup: 0.2, minSats: 1 }): { d: SmsDeps; wallet: FakeLnWallet } {
  const wallet = new FakeLnWallet(100_000);
  const d: SmsDeps = {
    client: mkClient(),
    wallet,
    treasury: new Treasury(wallet, { floorSats: 0 }),
    orders: new SqliteOrderStore(join(mkdtempSync(join(tmpdir(), "sms-")), "o.sqlite")),
    pricing,
    gate: new ExplicitGate(new FakeProcessor(paid)),
    poll: { intervalMs: 1, attempts: 3 },
  };
  return { d, wallet };
}

const tool = (d: SmsDeps, name: string) => buildSmsTools(d).find((t) => t.definition.name === name)!;

describe("create_sms_order", () => {
  test("paid: pays upstream, returns the code, order fulfilled", async () => {
    const { d, wallet } = deps(true);
    const r: any = await tool(d, "create_sms_order").handler(
      { service: "tg", country: "US", cashu_token: "tok", order_id: "o1" },
      { caller: "npub1buyer" },
    );
    expect(r.code).toBe("1234");
    expect(wallet.paid).toEqual(["lnbc50n1x"]);
    const o = d.orders.get("o1")!;
    expect(o.status).toBe("fulfilled");
    expect(o.priceSats).toBe(60); // 50 * 1.2
    expect(JSON.parse(o.resultJson!).code).toBe("1234");
  });

  test("unpaid: payment_required, upstream untouched, order pending", async () => {
    const { d, wallet } = deps(false);
    await expect(
      tool(d, "create_sms_order").handler({ service: "tg", order_id: "o2" }, { caller: "npub1buyer" }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(wallet.paid.length).toBe(0);
    expect(d.orders.get("o2")!.status).toBe("pending_payment");
  });

  test("min-price floor is applied to the client price", async () => {
    const { d } = deps(false, { markup: 0.2, minSats: 500 });
    await Promise.resolve(
      tool(d, "create_sms_order").handler({ service: "tg", order_id: "o3" }, { caller: "c" }),
    ).catch(() => {});
    expect(d.orders.get("o3")!.priceSats).toBe(500);
  });
});

describe("availability", () => {
  test("flags low treasury", async () => {
    const wallet = new FakeLnWallet(1);
    const d: SmsDeps = {
      client: mkClient(),
      wallet,
      treasury: new Treasury(wallet, { floorSats: 1000 }),
      orders: new SqliteOrderStore(join(mkdtempSync(join(tmpdir(), "sms-")), "o.sqlite")),
      pricing: { markup: 0.2, minSats: 10 },
      gate: new ExplicitGate(new FakeProcessor(true)),
    };
    const r: any = await tool(d, "availability").handler({}, { caller: "x" });
    expect(r.status).toBe("low_treasury");
  });
});
