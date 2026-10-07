import { randomUUID } from "node:crypto";

export interface MockL402Options {
  priceSats?: number;
  code?: string;
  macaroon?: string;
  /** Bind port; 0 (default) picks a free port (tests). */
  port?: number;
  hostname?: string;
}

export interface MockL402 {
  url: string;
  port: number;
  /** Orders by id → whether the L402 challenge was satisfied. */
  orders: Map<string, { paid: boolean }>;
  stop: () => void;
}

/**
 * A minimal upstream that speaks the L402 challenge flow the way sms4sats does:
 * POST /v2/l402/order → 402 {macaroon, invoice, priceSats, orderId};
 * GET /v2/l402/order/:id with `Authorization: L402 <mac>:<preimage>` →
 * {status:"completed", code}. Trust mode: any non-empty preimage is accepted,
 * so it exercises the wrapper + l402 client + gate without real money.
 */
export function startMockL402(opts: MockL402Options = {}): MockL402 {
  const priceSats = opts.priceSats ?? 50;
  const code = opts.code ?? "1234";
  const macaroon = opts.macaroon ?? "mock-macaroon";
  const orders = new Map<string, { paid: boolean }>();

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      if (req.method === "POST" && url.pathname === "/v2/l402/order") {
        const orderId = "ord-" + randomUUID();
        orders.set(orderId, { paid: false });
        return Response.json(
          { macaroon, invoice: `lnbc${priceSats}n1mock`, priceSats, orderId },
          { status: 402, headers: { "WWW-Authenticate": `L402 macaroon="${macaroon}", invoice="lnbc${priceSats}n1mock"` } },
        );
      }

      const m = /^\/v2\/l402\/order\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const orderId = m[1];
        const order = orders.get(orderId);
        if (!order) return new Response("not found", { status: 404 });
        const auth = req.headers.get("authorization") ?? "";
        const am = /^L402\s+([^:]+):(.+)$/.exec(auth);
        if (!am || am[1] !== macaroon || am[2].length === 0) {
          return Response.json({ macaroon, invoice: `lnbc${priceSats}n1mock`, priceSats, orderId }, { status: 402 });
        }
        order.paid = true;
        return Response.json({ status: "completed", code, orderId });
      }

      if (req.method === "POST" && /^\/v2\/l402\/order\/(.+)\/cancel$/.test(url.pathname)) {
        return Response.json({ status: "cancelled" });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const port: number = server.port ?? 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    orders,
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? "8899");
  const mock = startMockL402({ port, priceSats: Number(process.env.PRICE_SATS ?? "50") });
  console.error(`[mock-l402] listening on ${mock.url} (price ${process.env.PRICE_SATS ?? 50} sats)`);
}

