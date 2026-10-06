import { describe, expect, test } from "bun:test";
import { CvmServer, secretKeyFrom } from "./transport.ts";
import { PaymentRequiredError } from "./payment.ts";

function mkServer(tools: any[] = []) {
  return new CvmServer({
    secretKey: "01".repeat(32),
    relays: [],
    name: "test",
    tools: tools.length
      ? tools
      : [
          {
            definition: { name: "echo", description: "echo", inputSchema: {} },
            handler: (args: any) => ({ echoed: args.x }),
          },
        ],
  });
}

describe("secretKeyFrom", () => {
  test("accepts 64 hex chars", () => expect(secretKeyFrom("ab".repeat(32)).length).toBe(32));
  test("rejects nsec", () => expect(() => secretKeyFrom("nsec1abc")).toThrow(/hex/));
  test("rejects short hex", () => expect(() => secretKeyFrom("abcd")).toThrow(/hex/));
});

describe("handleRpc", () => {
  test("tools/list", async () => {
    const r = await mkServer().handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "ff");
    expect(r.result.tools[0].name).toBe("echo");
  });

  test("tools/call returns JSON text content", async () => {
    const r = await mkServer().handleRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { x: 7 } } },
      "ff",
    );
    expect(JSON.parse(r.result.content[0].text)).toEqual({ echoed: 7 });
  });

  test("unknown tool is a JSON-RPC error", async () => {
    const r = await mkServer().handleRpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } },
      "ff",
    );
    expect(r.error.code).toBe(-32602);
  });

  test("PaymentRequiredError becomes a payment_required error", async () => {
    const s = mkServer([
      {
        definition: { name: "paid", description: "paid", inputSchema: {} },
        handler: () => {
          throw new PaymentRequiredError("payment_required", {
            orderId: "o1",
            invoice: "lnbc...",
            amountSats: 10,
            paymentHash: "aa",
            pmi: "bitcoin-lightning-bolt11",
          });
        },
      },
    ]);
    const r = await s.handleRpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "paid", arguments: {} } },
      "ff",
    );
    expect(r.error.message).toBe("payment_required");
    expect(r.error.data.amountSats).toBe(10);
  });

  test("notification (no id) yields no response", async () => {
    const r = await mkServer().handleRpc({ jsonrpc: "2.0", method: "tools/list" }, "ff");
    expect(r).toBeUndefined();
  });
});
