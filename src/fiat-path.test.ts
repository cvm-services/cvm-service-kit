/**
 * fiat-path.test.ts — the money-safety properties of the gated fiat path
 * (card t_63be63f1, ADR-0008 + ADR-0012).
 *
 * These were written BEFORE the path existed: the `card.pay_checkout` tool did
 * not exist and an unpaid call could not be refused, because there was no path
 * to refuse. They must never be weakened to make a build pass.
 *
 * The properties:
 *  1. unpaid call  -> refused, and the adapter is NOT entered
 *  2. settled call -> adapter entered EXACTLY once (also under concurrency)
 *  3. settled then fiat leg failed -> TERMINAL + operator escalation, never a
 *     silent loss, never a retry into a second attempt
 *  4. restart-safe, and nothing card-shaped ever reaches the escalation DM
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExplicitGate,
  MemoryOrderStore,
  PaymentRequiredError,
  SettlementFailedError,
  SettlementInProgressError,
  type Invoice,
  type PaymentProcessor,
} from "./payment.ts";
import { SqliteGateStore } from "./gate-store.ts";
import {
  applyOperatorReply,
  FiatRetryRefusedError,
  payCheckoutGated,
  type FiatCheckoutRequest,
  type PayCheckoutAdapter,
} from "./fiat-path.ts";
import {
  FiatIntentMismatchError,
  FiatTerminalError,
  MemoryFiatIntentStore,
  type FiatIntentStore,
} from "./fiat-intent.ts";
import { SqliteFiatIntentStore } from "./fiat-store.ts";
import { CardMaterialInEscalationError, RecordingEscalator } from "./escalation.ts";

const OPERATOR = "b".repeat(64);
const CALLER = "a".repeat(64);
const ORDER_HASH = "9f".repeat(32);
const SATS_PROOF = "payhash-4f2a9c11d0e5b7a3";

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "cashu";
  verifyCalls = 0;
  constructor(private readonly paid: boolean) {}
  createInvoice(args: { orderId: string; amountSats: number }): Promise<Invoice> {
    return Promise.resolve({
      orderId: args.orderId,
      paymentHash: SATS_PROOF,
      amountSats: args.amountSats,
      request: "cashuB-test-request",
      pmi: this.pmi,
    });
  }
  verify(): Promise<boolean> {
    this.verifyCalls++;
    return Promise.resolve(this.paid);
  }
}

type AdapterBehaviour = "completed" | "human_required" | "failed" | "throw";

class RecordingAdapter implements PayCheckoutAdapter {
  readonly calls: Array<{ url: string; max_amount: string }> = [];
  constructor(private readonly behaviour: AdapterBehaviour, private readonly error?: string) {}
  pay_checkout(url: string, max_amount: string) {
    this.calls.push({ url, max_amount });
    if (this.behaviour === "throw") throw new Error(this.error ?? "browser died");
    return Promise.resolve({
      status: this.behaviour as "completed" | "human_required" | "failed",
      order_id: "venue-order-1",
    });
  }
}

function request(overrides: Partial<FiatCheckoutRequest> = {}): FiatCheckoutRequest {
  return {
    intentId: "intent-1",
    tool: "card.pay_checkout",
    caller: CALLER,
    orderHash: ORDER_HASH,
    rail: "2fiat-card",
    satsAmount: 2500,
    satsProof: SATS_PROOF,
    fiatCap: "24.90",
    checkoutUrl: "https://venue.example/checkout/abc",
    proof: "cashuB-test-token",
    ...overrides,
  };
}

function harness(opts: {
  paid: boolean;
  behaviour: AdapterBehaviour;
  adapterError?: string;
  store?: FiatIntentStore;
}) {
  const processor = new FakeProcessor(opts.paid);
  const gate = new ExplicitGate(processor, new MemoryOrderStore());
  const store = opts.store ?? new MemoryFiatIntentStore();
  const adapter = new RecordingAdapter(opts.behaviour, opts.adapterError);
  const escalator = new RecordingEscalator();
  const deps = { gate, store, adapter, escalator, operatorNpub: OPERATOR };
  return { deps, store, adapter, escalator, processor };
}

describe("1. unpaid call: refused, adapter NOT entered", () => {
  test("an unpaid call is refused and the adapter is never entered", async () => {
    const { deps, store, adapter, escalator } = harness({ paid: false, behaviour: "completed" });
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(adapter.calls.length).toBe(0);
    expect(store.get("intent-1")?.status).toBe("awaiting_sats");
    expect(store.get("intent-1")?.fiatAttempts).toBe(0);
    expect(escalator.notices.length).toBe(0);
  });

  test("the refusal is the state machine's own protocol error (no second gate)", async () => {
    const { deps, adapter, processor } = harness({ paid: false, behaviour: "completed" });
    let code = 0;
    try {
      await payCheckoutGated(deps, request());
    } catch (e) {
      code = (e as PaymentRequiredError).code;
    }
    expect(code).toBe(-32002);
    expect(processor.verifyCalls).toBe(1);
    expect(adapter.calls.length).toBe(0);
  });
});

describe("2. settled call: adapter entered exactly once", () => {
  test("a settled call enters the adapter once and records the outcome", async () => {
    const { deps, store, adapter, escalator } = harness({ paid: true, behaviour: "completed" });
    const out = await payCheckoutGated(deps, request());
    expect(out.status).toBe("completed");
    expect(out.order_id).toBe("venue-order-1");
    expect(adapter.calls).toEqual([
      { url: "https://venue.example/checkout/abc", max_amount: "24.90" },
    ]);
    const intent = store.get("intent-1")!;
    expect(intent.status).toBe("fiat_completed");
    expect(intent.fiatAttempts).toBe(1);
    expect(escalator.notices.length).toBe(0);
  });

  test("concurrent settled calls enter the adapter exactly once", async () => {
    const { deps, adapter } = harness({ paid: true, behaviour: "completed" });
    const results = await Promise.allSettled([
      payCheckoutGated(deps, request()),
      payCheckoutGated(deps, request()),
    ]);
    expect(adapter.calls.length).toBe(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      SettlementInProgressError,
    );
  });

  test("replaying a settled call returns the recorded outcome without re-entering the adapter", async () => {
    const { deps, adapter } = harness({ paid: true, behaviour: "completed" });
    await payCheckoutGated(deps, request());
    const again = await payCheckoutGated(deps, request());
    expect(again.order_id).toBe("venue-order-1");
    expect(adapter.calls.length).toBe(1);
  });

  test("an intent id may not be re-used for a different quote", async () => {
    const { deps, store, adapter } = harness({ paid: true, behaviour: "completed" });
    await payCheckoutGated(deps, request());
    expect(store.get("intent-1")?.fiatCap).toBe("24.90");
    await expect(
      payCheckoutGated(deps, request({ fiatCap: "240.00" })),
    ).rejects.toBeInstanceOf(FiatIntentMismatchError);
    expect(adapter.calls.length).toBe(1);
  });
});

describe("3. settled then failed fiat leg: terminal + escalation, never a second attempt", () => {
  test("a failed fiat leg is terminal, escalates once, and is never retried into a second attempt", async () => {
    const { deps, store, adapter, escalator } = harness({
      paid: true,
      behaviour: "throw",
      adapterError: "3DS prompt timed out",
    });
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);

    const intent = store.get("intent-1")!;
    expect(intent.status).toBe("fiat_failed_terminal");
    expect(intent.fiatAttempts).toBe(1);
    expect(intent.failure?.message).toContain("3DS prompt timed out");
    expect(intent.escalatedAt).toBeGreaterThan(0);
    expect(escalator.notices.length).toBe(1);

    // ADR-0012: what the DM must carry.
    const n = escalator.notices[0];
    expect(n.kind).toBe("fiat_failed_terminal");
    expect(n.intentId).toBe("intent-1");
    expect(n.orderHash).toBe(ORDER_HASH);
    expect(n.satsProof).toBe(SATS_PROOF);
    expect(n.rail).toBe("2fiat-card");
    expect(n.amountSats).toBe(2500);
    expect(n.fiatCap).toBe("24.90");
    expect(n.whatFailed).toContain("3DS prompt timed out");
    expect(n.recipient).toBe(OPERATOR);

    // The retry: refused, no second adapter entry, no second DM.
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);
    expect(adapter.calls.length).toBe(1);
    expect(escalator.notices.length).toBe(1);
    expect(store.get("intent-1")?.fiatAttempts).toBe(1);
  });

  test("an adapter that reports failed (not throws) is equally terminal", async () => {
    const { deps, store, adapter, escalator } = harness({ paid: true, behaviour: "failed" });
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);
    expect(store.get("intent-1")?.status).toBe("fiat_failed_terminal");
    expect(escalator.notices.length).toBe(1);
    expect(adapter.calls.length).toBe(1);
  });

  test("human_required is not a failure: no escalation, and the retry is refused without a second attempt", async () => {
    const { deps, store, adapter, escalator } = harness({ paid: true, behaviour: "human_required" });
    const out = await payCheckoutGated(deps, request());
    expect(out.status).toBe("human_required");
    expect(out.human_step).toContain("3DS");
    expect(store.get("intent-1")?.status).toBe("fiat_human_required");
    expect(escalator.notices.length).toBe(0);
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatRetryRefusedError);
    expect(adapter.calls.length).toBe(1);
  });
});

describe("4. restart-safe, and durable escalation", () => {
  test("a restart does not restore a spent intent (sqlite stores, one payment = one attempt)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fiat-restart-"));
    const gateDb = join(dir, "gate.sqlite");
    const intentDb = join(dir, "intents.sqlite");

    {
      const gateStore = new SqliteGateStore(gateDb);
      const intentStore = new SqliteFiatIntentStore(intentDb);
      const gate = new ExplicitGate(new FakeProcessor(true), gateStore);
      const adapter = new RecordingAdapter("throw", "adapter died mid-checkout");
      const escalator = new RecordingEscalator();
      const deps = { gate, store: intentStore, adapter, escalator, operatorNpub: OPERATOR };
      await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);
      expect(adapter.calls.length).toBe(1);
      gateStore.close();
      intentStore.close();
    }

    // "Restart": brand-new store objects over the same files.
    const gateStore2 = new SqliteGateStore(gateDb);
    const intentStore2 = new SqliteFiatIntentStore(intentDb);
    expect(intentStore2.get("intent-1")?.status).toBe("fiat_failed_terminal");
    expect(intentStore2.get("intent-1")?.fiatAttempts).toBe(1);

    const gate2 = new ExplicitGate(new FakeProcessor(true), gateStore2);
    const adapter2 = new RecordingAdapter("completed");
    const escalator2 = new RecordingEscalator();
    const deps2 = { gate: gate2, store: intentStore2, adapter: adapter2, escalator: escalator2, operatorNpub: OPERATOR };
    // The fiat layer refuses first: the intent is already terminal, so the gate
    // (and the adapter) are never even reached.
    await expect(payCheckoutGated(deps2, request())).rejects.toBeInstanceOf(FiatTerminalError);
    expect(adapter2.calls.length).toBe(0);
    expect(escalator2.notices.length).toBe(0); // already escalated before the restart
    gateStore2.close();
    intentStore2.close();
  });

  test("the bounded-window sweep alerts an unresolved intent once and is idempotent", async () => {
    const { deps, store, escalator } = harness({ paid: true, behaviour: "human_required" });
    await payCheckoutGated(deps, request());
    const { sweepUnresolved } = await import("./fiat-path.ts");
    const sweepDeps = { ...deps, unresolvedWindowMs: 60_000, now: () => Date.now() + 10 * 60_000 };
    const first = await sweepUnresolved(sweepDeps);
    expect(first.alertsRaised).toBe(1);
    expect(escalator.notices.length).toBe(1);
    expect(escalator.notices[0].kind).toBe("unresolved");
    expect(store.get("intent-1")?.alertAt).toBeGreaterThan(0);
    const second = await sweepUnresolved(sweepDeps);
    expect(second.alertsRaised).toBe(0);
    expect(escalator.notices.length).toBe(1);
  });

  test("sats settled but no fiat action yet (crash) is escalated by the sweep, never re-run", async () => {
    const { deps, store, adapter, escalator } = harness({ paid: true, behaviour: "completed" });
    // Simulate a crash after the gate claimed but before the adapter: the intent
    // is durable in sats_settled with attempts = 0.
    store.put({
      intentId: "intent-1",
      tool: "card.pay_checkout",
      caller: CALLER,
      orderHash: ORDER_HASH,
      rail: "2fiat-card",
      satsAmount: 2500,
      satsProof: SATS_PROOF,
      fiatCap: "24.90",
      checkoutUrl: "https://venue.example/checkout/abc",
      status: "sats_settled",
      fiatAttempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const { sweepUnresolved } = await import("./fiat-path.ts");
    const sweepDeps = { ...deps, unresolvedWindowMs: 60_000, now: () => Date.now() + 10 * 60_000 };
    const res = await sweepUnresolved(sweepDeps);
    expect(res.alertsRaised).toBe(1);
    expect(escalator.notices[0].kind).toBe("unresolved");
    expect(adapter.calls.length).toBe(0);
  });
});

describe("5. operator replies are inputs to durable state, never actions", () => {
  test("'refunded' resolves the intent terminally; the adapter is never re-entered", async () => {
    const { deps, store, adapter } = harness({ paid: true, behaviour: "throw", adapterError: "boom" });
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);
    const out = await applyOperatorReply(deps, {
      intentId: "intent-1",
      from: OPERATOR,
      text: "refunded",
    });
    expect(out.outcome).toBe("resolved");
    expect(out.resolution).toBe("refunded");
    expect(store.get("intent-1")?.status).toBe("refunded");
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);
    expect(adapter.calls.length).toBe(1);
  });

  test("a reply asking for another attempt is refused and escalated as a duplicate attempt", async () => {
    const { deps, store, adapter, escalator } = harness({
      paid: true,
      behaviour: "throw",
      adapterError: "boom",
    });
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);
    const out = await applyOperatorReply(deps, {
      intentId: "intent-1",
      from: OPERATOR,
      text: "please retry the card",
    });
    expect(out.outcome).toBe("refused_attempt_request");
    expect(store.get("intent-1")?.status).toBe("fiat_failed_terminal");
    expect(adapter.calls.length).toBe(1);
    expect(escalator.notices.map((n) => n.kind)).toEqual([
      "fiat_failed_terminal",
      "duplicate_attempt",
    ]);
    // And the state machine still refuses the retry.
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);
    expect(adapter.calls.length).toBe(1);
  });

  test("a reply from anyone but the operator is refused", async () => {
    const { deps } = harness({ paid: true, behaviour: "throw", adapterError: "boom" });
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);
    await expect(
      applyOperatorReply(deps, { intentId: "intent-1", from: "c".repeat(64), text: "refunded" }),
    ).rejects.toBeInstanceOf(FiatIntentMismatchError);
  });
});

describe("6. nothing card-shaped reaches the escalation DM", () => {
  test("a credential-shaped failure string is redacted before it is escalated", async () => {
    const { deps, escalator } = harness({
      paid: true,
      behaviour: "throw",
      adapterError: "card 4111 1111 1111 1111 declined at the venue",
    });
    await expect(payCheckoutGated(deps, request())).rejects.toBeInstanceOf(FiatTerminalError);
    expect(escalator.notices.length).toBe(1);
    const what = escalator.notices[0].whatFailed;
    expect(what).not.toContain("4111");
    expect(what).toContain("[redacted:card-shaped]");
  });

  test("the escalator refuses outright if card material survives into the notice", async () => {
    const esc = new RecordingEscalator();
    await expect(
      esc.escalate({
        kind: "fiat_failed_terminal",
        intentId: "intent-1",
        orderHash: ORDER_HASH,
        satsProof: SATS_PROOF,
        rail: "2fiat-card",
        amountSats: 2500,
        fiatCap: "24.90",
        whatFailed: "4111111111111111",
        recipient: OPERATOR,
        at: Date.now(),
        resolutionHint: "",
      }),
    ).rejects.toBeInstanceOf(CardMaterialInEscalationError);
    expect(esc.notices.length).toBe(0);
  });
});
