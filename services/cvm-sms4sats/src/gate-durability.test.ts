/**
 * `cvm-sms4sats` was the one consumer of the shared CEP-8 gate that built it
 * WITHOUT a store (`new ExplicitGate(processor)`), so the gate fell back to
 * `MemoryOrderStore` - an in-process Map. Every restart erased "this payment is
 * already settled", and a replayed proof was re-verified against a
 * still-settled invoice, letting the paid tool run twice on one payment.
 *
 * These tests pin the wiring, not the gate: the gate's own CAS invariants live
 * in `src/money_safety.test.ts`. The first test is the falsification control -
 * it proves this scenario REALLY catches an in-memory store, so the second test
 * passing is evidence and not a tautology.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExplicitGate,
  type Invoice,
  type PaymentProcessor,
} from "../../../src/index.ts";
import { buildGate, configFromEnv } from "./server.ts";

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "pmi:fake";
  paid = true;
  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return {
      orderId: a.orderId,
      paymentHash: "hash-" + a.orderId,
      amountSats: a.amountSats,
      request: "lnbc-fake-" + a.orderId,
      pmi: this.pmi,
    };
  }
  async verify(): Promise<boolean> {
    return this.paid;
  }
}

const gateArgs = (orderId: string, run: () => Promise<string>) => ({
  tool: "create_sms_order",
  caller: "npub1customer",
  amountSats: 2100,
  orderId,
  proof: "cashu-proof",
  run,
});

const gateDbPath = () => join(mkdtempSync(join(tmpdir(), "sms4sats-gate-")), "gate.sqlite");

describe("cvm-sms4sats gate store wiring", () => {
  test("CONTROL: an in-memory gate store really does lose settlement across a restart", async () => {
    // The pre-fix shape: no store argument at all.
    const gate1 = new ExplicitGate(new FakeProcessor());
    let runs = 0;
    const first = async () => {
      runs++;
      return "sent-1";
    };
    expect(await gate1.gate(gateArgs("mem", first))).toBe("sent-1");

    // "Restart": a brand-new gate, no state carried over.
    const gate2 = new ExplicitGate(new FakeProcessor());
    const second = async () => {
      runs++;
      return "sent-2";
    };
    // The replay is NOT recognised, so the paid tool runs a second time on the
    // same payment. This is the defect; if this assertion ever stops holding the
    // test below proves nothing.
    expect(await gate2.gate(gateArgs("mem", second))).toBe("sent-2");
    expect(runs).toBe(2);
  });

  test("buildGate gives the gate a durable store: a replay after restart never re-runs", async () => {
    const db = gateDbPath();
    const gate1 = buildGate(new FakeProcessor(), db);
    let runs = 0;
    const first = async () => {
      runs++;
      return "sent-1";
    };
    expect(await gate1.gate(gateArgs("dur", first))).toBe("sent-1");
    expect(runs).toBe(1);

    // Same database file, new gate object: what a service restart looks like.
    const gate2 = buildGate(new FakeProcessor(), db);
    const second = async () => {
      runs++;
      return "sent-2";
    };
    expect(await gate2.gate(gateArgs("dur", second))).toBe("sent-1");
    expect(runs).toBe(1);
  });

  test("the gate database defaults into the service state dir and honours GATE_DB", () => {
    const base = { SERVER_SECRET_KEY: "ab".repeat(32) };
    expect(configFromEnv(base).gateDb).toBe("/var/lib/loom/cvm-sms4sats/gate.sqlite");
    expect(configFromEnv({ ...base, GATE_DB: "/srv/x/gate.sqlite" }).gateDb).toBe(
      "/srv/x/gate.sqlite",
    );
  });
});
