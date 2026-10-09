/**
 * fiat.test.ts — the cvm-2fiat half of card t_63be63f1 (ADR-0008 + ADR-0012).
 *
 * Written BEFORE the `card.pay_checkout` tool existed: the tool was absent from
 * the surface, so an unpaid call could not be refused and there was no path at
 * all. That is the RED this file starts from.
 *
 * Properties:
 *  1. the tool exists, takes no card field, and refuses a non-owner caller
 *  2. unpaid caller -> refused by the state machine and the adapter is NOT entered
 *  3. sats settled -> the adapter is entered EXACTLY once (also under concurrency)
 *  4. sats settled + fiat leg failed -> terminal + ADR-0012 escalation; the
 *     retry never enters the adapter again
 *  5. no fiat path configured -> honest refusal, never a fabricated outcome
 */
import { describe, expect, test } from "bun:test";
import {
  CvmRefusalError,
  ExplicitGate,
  MemoryFiatIntentStore,
  MemoryOrderStore,
  PaymentRequiredError,
  RecordingEscalator,
  type Escalator,
  type FiatIntentStore,
  type Invoice,
  type PaymentProcessor,
} from "../../../src/index.ts";
import { FiatTerminalError } from "../../../src/index.ts";
import type { AdapterBalance, AdapterCapabilities, AdapterCheckoutResult, LocalBalanceAdapter } from "./adapter.ts";
import { buildTwoFiatTools, type TwoFiatDeps } from "./tools.ts";

const OPERATOR = "b".repeat(64);
const STRANGER = "c".repeat(64);
const CALLER = "a".repeat(64);
const ORDER_HASH = "9f".repeat(32);
const SATS_PROOF = "payhash-4f2a9c11d0e5b7a3";

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "cashu";
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
    return Promise.resolve(this.paid);
  }
}

class FakeLocalAdapter implements LocalBalanceAdapter {
  readonly payCalls: Array<{ url: string; max_amount: string }> = [];
  constructor(
    private readonly behaviour: "completed" | "human_required" | "failed" | "throw" = "completed",
  ) {}
  balance(): Promise<AdapterBalance> {
    return Promise.resolve({ currency: "EUR", amount: "20.00", as_of: "2026-10-10T00:00:00Z" });
  }
  capabilities(): Promise<AdapterCapabilities> {
    return Promise.resolve({
      card_present: true,
      can_authorize: false,
      needs_human_3ds: true,
      adapter: "local",
    });
  }
  pay_checkout(url: string, max_amount: string): Promise<AdapterCheckoutResult> {
    this.payCalls.push({ url, max_amount });
    if (this.behaviour === "throw") throw new Error("3DS prompt timed out");
    return Promise.resolve({ status: this.behaviour as AdapterCheckoutResult["status"], order_id: "venue-1" });
  }
}

function harness(opts: {
  paid?: boolean;
  behaviour?: "completed" | "human_required" | "failed" | "throw";
  adapter?: LocalBalanceAdapter | undefined;
  fiat?: TwoFiatDeps["fiat"] | undefined;
  withFiat?: boolean;
} = {}) {
  const adapterCalls: string[] = [];
  const adapter = "adapter" in opts ? opts.adapter : new FakeLocalAdapter(opts.behaviour ?? "completed");
  const gate = new ExplicitGate(new FakeProcessor(opts.paid ?? true), new MemoryOrderStore());
  const store: FiatIntentStore = new MemoryFiatIntentStore();
  const escalator: Escalator = new RecordingEscalator();
  const deps: TwoFiatDeps = {
    adapter,
    ownerNpub: OPERATOR,
    adapterCalls,
    gate,
    fiat:
      opts.withFiat === false
        ? undefined
        : (opts.fiat ?? { store, escalator, maxCheckoutSats: 100_000 }),
  };
  const tools = buildTwoFiatTools(deps);
  const call = (name: string, args: Record<string, unknown>, caller = OPERATOR) => {
    const tool = tools.find((t) => t.definition.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool.handler(args, { caller });
  };
  return { deps, tools, call, adapterCalls, store, escalator, gate, adapter };
}

const ARGS = {
  order_id: "intent-1",
  order_hash: ORDER_HASH,
  rail: "2fiat-card",
  amount_sats: 2500,
  sats_proof: SATS_PROOF,
  cashu_token: "cashuB-test-token",
  checkout_url: "https://venue.example/checkout/abc",
  max_amount: "24.90",
};

describe("1. the surface", () => {
  test("card.pay_checkout is advertised and accepts no card field", () => {
    const { tools } = harness();
    const tool = tools.find((t) => t.definition.name === "card.pay_checkout");
    expect(tool).toBeDefined();
    const schema = JSON.stringify(tool!.definition.inputSchema).toLowerCase();
    for (const forbidden of ["pan", "cvv", "cvc", "expiry", "card_number"]) {
      expect(schema).not.toContain(forbidden);
    }
  });

  test("a non-owner caller is refused BEFORE the adapter or the gate is reached", async () => {
    const { call, adapterCalls } = harness({ paid: true });
    await expect(call("card.pay_checkout", ARGS, STRANGER)).rejects.toBeInstanceOf(CvmRefusalError);
    expect(adapterCalls.length).toBe(0);
  });
});

describe("2. unpaid call: refused, adapter NOT entered", () => {
  test("an unpaid call is refused and the adapter is never entered", async () => {
    const { call, adapterCalls, store } = harness({ paid: false });
    await expect(call("card.pay_checkout", ARGS)).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(adapterCalls).not.toContain("adapter.pay_checkout");
    expect(store.get("intent-1")?.status).toBe("awaiting_sats");
    expect(store.get("intent-1")?.fiatAttempts).toBe(0);
  });
});

describe("3. settled call: adapter entered exactly once", () => {
  test("a settled call completes and enters the adapter once", async () => {
    const { call, adapterCalls } = harness({ paid: true, behaviour: "completed" });
    const out = (await call("card.pay_checkout", ARGS)) as Record<string, unknown>;
    expect(out.status).toBe("completed");
    expect(out.order_id).toBe("venue-1");
    expect(String(out.human_step)).toContain("3DS");
    expect(adapterCalls.filter((c) => c === "adapter.pay_checkout").length).toBe(1);
  });

  test("concurrent settled calls enter the adapter exactly once", async () => {
    const { call, adapterCalls } = harness({ paid: true, behaviour: "completed" });
    const results = await Promise.allSettled([
      call("card.pay_checkout", ARGS),
      call("card.pay_checkout", ARGS),
    ]);
    expect(adapterCalls.filter((c) => c === "adapter.pay_checkout").length).toBe(1);
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);
  });
});

describe("4. settled then failed fiat leg", () => {
  test("the failure is terminal, escalated once, and never retried into the adapter", async () => {
    const { call, adapterCalls, store, escalator } = harness({ paid: true, behaviour: "throw" });
    await expect(call("card.pay_checkout", ARGS)).rejects.toBeInstanceOf(FiatTerminalError);
    const rec = escalator as RecordingEscalator;
    expect(rec.notices.length).toBe(1);
    expect(rec.notices[0].recipient).toBe(OPERATOR);
    expect(rec.notices[0].amountSats).toBe(2500);
    expect(rec.notices[0].fiatCap).toBe("24.90");
    expect(store.get("intent-1")?.status).toBe("fiat_failed_terminal");
    await expect(call("card.pay_checkout", ARGS)).rejects.toBeInstanceOf(FiatTerminalError);
    expect(adapterCalls.filter((c) => c === "adapter.pay_checkout").length).toBe(1);
    expect(rec.notices.length).toBe(1);
  });
});

describe("5. fail closed when unconfigured", () => {
  test("no fiat path configured -> rail_unavailable, never a fabricated outcome", async () => {
    const { call, adapterCalls } = harness({ adapter: undefined, withFiat: false });
    await expect(call("card.pay_checkout", ARGS)).rejects.toBeInstanceOf(CvmRefusalError);
    expect(adapterCalls.length).toBe(0);
  });

  test("no gate configured -> rail_unavailable (the sats must be verifiable, or nothing happens)", async () => {
    const { adapterCalls } = harness({ withFiat: true });
    // A gate is required for a fiat spend; drop it.
    const noGate = buildTwoFiatTools({
      adapter: new FakeLocalAdapter(),
      ownerNpub: OPERATOR,
      adapterCalls,
      fiat: { store: new MemoryFiatIntentStore(), escalator: new RecordingEscalator() },
    });
    const tool = noGate.find((t) => t.definition.name === "card.pay_checkout")!;
    expect(tool).toBeDefined();
    await expect(tool.handler(ARGS, { caller: OPERATOR })).rejects.toBeInstanceOf(CvmRefusalError);
    expect(adapterCalls.length).toBe(0);
  });
});
