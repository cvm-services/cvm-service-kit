import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteOrderStore } from "./orders.ts";

function store() {
  return new SqliteOrderStore(join(mkdtempSync(join(tmpdir(), "orders-")), "o.sqlite"));
}

describe("SqliteOrderStore", () => {
  test("createOrGet is idempotent", () => {
    const s = store();
    const a = s.createOrGet({
      orderId: "o1", service: "sms", tool: "create_sms_order", caller: "npub1x",
      costSats: 100, priceSats: 125, status: "pending_payment",
      upstreamRef: null, resultJson: null, error: null,
    });
    const b = s.createOrGet({
      orderId: "o1", service: "sms", tool: "create_sms_order", caller: "npub1x",
      costSats: 999, priceSats: 999, status: "pending_payment",
      upstreamRef: null, resultJson: null, error: null,
    });
    expect(a.orderId).toBe("o1");
    expect(b.costSats).toBe(100); // existing row, not overwritten
  });

  test("update persists status and result", () => {
    const s = store();
    s.createOrGet({
      orderId: "o2", service: "sms", tool: "t", caller: "c",
      costSats: 50, priceSats: 60, status: "pending_payment",
      upstreamRef: null, resultJson: null, error: null,
    });
    s.update("o2", { status: "fulfilled", upstreamRef: "up-9", resultJson: '{"code":"1234"}' });
    const o = s.get("o2")!;
    expect(o.status).toBe("fulfilled");
    expect(o.upstreamRef).toBe("up-9");
    expect(JSON.parse(o.resultJson!).code).toBe("1234");
  });

  test("update on unknown order throws", () => {
    expect(() => store().update("nope", { status: "failed" })).toThrow(/unknown order/);
  });
});
