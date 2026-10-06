import { describe, expect, test } from "bun:test";
import { FakeLnWallet } from "../../../src/index.ts";
import { Sms4SatsClient } from "./upstream.ts";

interface Route {
  method?: string;
  match: string;
  handler: (init: any) => { status?: number; body: any; headers?: Record<string, string> };
}

function mockFetch(routes: Route[]) {
  const calls: string[] = [];
  const f = async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const route = routes.find((r) => (r.method ?? "GET") === method && url.includes(r.match));
    const r = route ? route.handler(init) : { status: 404, body: { error: "not found" } };
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      headers: new Headers(r.headers ?? {}),
      text: async () => JSON.stringify(r.body),
    } as any;
  };
  return { f, calls };
}

describe("Sms4SatsClient", () => {
  test("services passthrough", async () => {
    const { f } = mockFetch([{ method: "GET", match: "/v2/l402/services", handler: () => ({ body: { services: [{ code: "tg" }] } }) }]);
    const c = new Sms4SatsClient({ fetchImpl: f as any });
    const r = await c.services();
    expect(r.body.services[0].code).toBe("tg");
  });

  test("requestOrder captures 402 challenge without paying", async () => {
    const { f } = mockFetch([
      {
        method: "POST",
        match: "/v2/l402/order",
        handler: () => ({
          status: 402,
          body: { macaroon: "mac", invoice: "lnbc10n1x", priceSats: 50, orderId: "ord-1" },
        }),
      },
    ]);
    const c = new Sms4SatsClient({ fetchImpl: f as any });
    const q = await c.requestOrder({ type: "receive-sms", country: "US", service: "tg" });
    expect(q.status).toBe(402);
    expect(q.orderId).toBe("ord-1");
    expect(q.costSats).toBe(50);
    expect(q.challenge).toEqual({ macaroon: "mac", invoice: "lnbc10n1x" });
  });

  test("payAndPoll pays then polls to terminal", async () => {
    let polls = 0;
    const { f } = mockFetch([
      {
        method: "GET",
        match: "/v2/l402/order/ord-2",
        handler: () => {
          polls++;
          return { body: { status: polls >= 2 ? "completed" : "waiting_for_sms", code: "1234" } };
        },
      },
    ]);
    const c = new Sms4SatsClient({ fetchImpl: f as any });
    const wallet = new FakeLnWallet();
    const res = await c.payAndPoll(
      "ord-2",
      { macaroon: "m", invoice: "lnbc10n1x" },
      wallet,
      { intervalMs: 1 },
    );
    expect(wallet.paid).toEqual(["lnbc10n1x"]);
    expect(res.status).toBe("completed");
    expect(res.code).toBe("1234");
  });
});
