import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExplicitGate,
  FakeLnWallet,
  fetchWithL402,
  SqliteOrderStore,
  Treasury,
  type Invoice,
  type PaymentProcessor,
} from "../../src/index.ts";
import { Sms4SatsClient } from "../cvm-sms4sats/src/upstream.ts";
import { buildSmsTools, type SmsDeps } from "../cvm-sms4sats/src/tools.ts";
import { startMockL402 } from "./mock-l402.ts";

const servers: Array<{ stop: () => void }> = [];
afterAll(() => servers.forEach((s) => s.stop()));

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

describe("mock L402 upstream", () => {
  test("fetchWithL402 pays the challenge and replays", async () => {
    const mock = startMockL402();
    servers.push(mock);
    // Create an order to get an id, then hit the protected GET (402 → pay → 200).
    const created = (await (await fetch(`${mock.url}/v2/l402/order`, { method: "POST" })).json()) as any;
    const wallet = new FakeLnWallet();
    const res = await fetchWithL402(`${mock.url}/v2/l402/order/${created.orderId}`, {}, wallet);
    expect(res.preimage).toBeDefined();
    expect((res.response as any).status).toBe(200);
    expect(res.body.code).toBe("1234");
    expect(wallet.paid).toEqual(["lnbc50n1mock"]);
  });

  test("full create_sms_order flow against the mock returns the code", async () => {
    const mock = startMockL402({ priceSats: 50, code: "9999" });
    servers.push(mock);
    const wallet = new FakeLnWallet(100_000);
    const d: SmsDeps = {
      client: new Sms4SatsClient({ baseUrl: mock.url }),
      wallet,
      treasury: new Treasury(wallet, { floorSats: 0 }),
      orders: new SqliteOrderStore(join(mkdtempSync(join(tmpdir(), "mock-")), "o.sqlite")),
      pricing: { markup: 0.2, minSats: 1 },
      gate: new ExplicitGate(new FakeProcessor(true)),
      poll: { intervalMs: 1, attempts: 3 },
    };
    const tool = buildSmsTools(d).find((t) => t.definition.name === "create_sms_order")!;
    const r: any = await tool.handler(
      { service: "tg", country: "US", cashu_token: "tok", order_id: "m1", refund_invoice: "lnbc1test" },
      { caller: "npub1buyer" },
    );
    expect(r.code).toBe("9999");
    expect(d.orders.get("m1")!.status).toBe("fulfilled");
    expect(wallet.paid).toEqual(["lnbc50n1mock"]);
  });
});
