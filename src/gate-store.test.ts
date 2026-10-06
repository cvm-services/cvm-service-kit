import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteGateStore } from "./gate-store.ts";
import type { GateOrder } from "./payment.ts";

const invoice = { orderId: "o1", paymentHash: "h", amountSats: 10, request: "cashu:x", pmi: "bitcoin-cashu" };

function mk() {
  return new SqliteGateStore(join(mkdtempSync(join(tmpdir(), "gate-")), "g.sqlite"));
}

describe("SqliteGateStore", () => {
  test("put/get round-trips invoice and result", () => {
    const s = mk();
    const o: GateOrder = {
      orderId: "o1", tool: "run_code", caller: "npub1x", amountSats: 10,
      invoice, status: "settled", result: { stdout: "42" }, createdAt: 1, updatedAt: 1,
    };
    s.put(o);
    const got = s.get("o1")!;
    expect(got.invoice.request).toBe("cashu:x");
    expect(got.result).toEqual({ stdout: "42" });
  });

  test("upsert updates status without losing invoice", () => {
    const s = mk();
    s.put({ orderId: "o2", tool: "t", caller: "c", amountSats: 5, invoice: { ...invoice, orderId: "o2" }, status: "awaiting_payment", createdAt: 1, updatedAt: 1 });
    s.put({ orderId: "o2", tool: "t", caller: "c", amountSats: 5, invoice: { ...invoice, orderId: "o2" }, status: "settled", result: 7, createdAt: 1, updatedAt: 2 });
    const got = s.get("o2")!;
    expect(got.status).toBe("settled");
    expect(got.result).toBe(7);
    expect(got.invoice.pmi).toBe("bitcoin-cashu");
  });

  test("missing order returns undefined", () => {
    expect(mk().get("nope")).toBeUndefined();
  });
});
