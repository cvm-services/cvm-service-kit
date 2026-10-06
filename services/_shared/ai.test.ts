import { describe, expect, test } from "bun:test";
import {
  ExplicitGate,
  PaymentRequiredError,
  RateLimiter,
  type Invoice,
  type PaymentProcessor,
  type Tool,
} from "../../src/index.ts";
import { buildAiTools, type AiDeps } from "./ai.ts";

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "bitcoin-cashu";
  constructor(private paid: boolean) {}
  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return { orderId: a.orderId, paymentHash: "h", amountSats: a.amountSats, request: "cashu:x", pmi: this.pmi };
  }
  async verify(): Promise<boolean> {
    return this.paid;
  }
}

function mockChat() {
  return (async (url: string, init: any) =>
    ({
      status: 200,
      ok: true,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({ model: "m", choices: [{ message: { content: "hello" } }], usage: { total_tokens: 3 } }),
    }) as any);
}

function deps(paid: boolean, priceSats = 5): AiDeps {
  return {
    service: "test",
    cfg: { baseUrl: "https://api.test/v1" },
    priceSats,
    defaultModel: "m",
    gate: new ExplicitGate(new FakeProcessor(paid)),
    limiter: new RateLimiter({ capacity: 10, refillPerSec: 1 }),
    fetchImpl: mockChat(),
  };
}

const tool = (d: AiDeps, name: string): Tool => buildAiTools(d).find((t) => t.definition.name === name)!;

describe("buildAiTools", () => {
  test("paid chat returns the completion", async () => {
    const r: any = await tool(deps(true), "chat").handler(
      { prompt: "hi", cashu_token: "tok", order_id: "o1" },
      { caller: "npub1x" },
    );
    expect(r.content).toBe("hello");
    expect(r.usage.total_tokens).toBe(3);
  });

  test("unpaid chat is refused", async () => {
    await expect(
      tool(deps(false), "chat").handler({ prompt: "hi" }, { caller: "npub1x" }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  test("free tool (price 0) runs without payment", async () => {
    const d = deps(false, 0);
    delete (d as any).gate;
    const r: any = await tool(d, "chat").handler({ prompt: "hi" }, { caller: "npub1x" });
    expect(r.content).toBe("hello");
  });

  test("missing prompt/messages errors", async () => {
    await expect(tool(deps(true), "chat").handler({}, { caller: "c" })).rejects.toThrow(/messages or prompt/);
  });
});
