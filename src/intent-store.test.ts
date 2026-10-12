/**
 * Durable payment-intent invariants (card t_89dcb160).
 *
 * RED first: every test here failed before src/intent-store.ts existed, and the
 * probe in src/evidence/red_before.ts shows the *behavioural* leak the binding
 * closes (an order id reused with a bigger fiat order rode a smaller payment).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBindingMatches,
  BINDING_FIELDS,
  IntentConflictError,
  MemoryIntentStore,
  newIntentId,
  orderHashOf,
  SqliteIntentStore,
  type IntentBinding,
  type PaymentIntent,
} from "./intent-store.ts";

const binding = (over: Partial<IntentBinding> = {}): IntentBinding => ({
  tool: "card.balance",
  caller: "npub1owner",
  orderHash: orderHashOf({ url: "https://merchant.example/checkout", amount: "12.50" }),
  amountSats: 250,
  pmi: "bitcoin-cashu",
  quote: "cashu:https://mint.example:250",
  fiatCap: 12.5,
  fiatCurrency: "EUR",
  ...over,
});

const intent = (id: string, over: Partial<PaymentIntent> = {}): PaymentIntent => ({
  intentId: id,
  ...binding(),
  status: "awaiting_payment",
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/** A fresh on-disk store per test, so a stale file can never mask a result. */
function mkStore(): { store: SqliteIntentStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "intent-store-")), "intents.sqlite");
  return { store: new SqliteIntentStore(path), path };
}

/** Generous timeout: these tests do real file I/O on a shared, busy box. */
const T = { timeout: 30_000 } as const;

describe("intent identity", () => {
  test("an intent id is cryptographically unique, not a counter", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(newIntentId());
    expect(ids.size).toBe(10_000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{64}$/);
  }, T);

  test("the order hash is canonical: key order does not matter, content does", () => {
    expect(orderHashOf({ a: 1, b: [2, { c: 3, d: 4 }] })).toBe(
      orderHashOf({ b: [2, { d: 4, c: 3 }], a: 1 }),
    );
    expect(orderHashOf({ amount: "12.50" })).not.toBe(orderHashOf({ amount: "12.51" }));
    expect(orderHashOf({ url: "https://m/x", amount: "1" })).toMatch(/^[0-9a-f]{64}$/);
  }, T);
});

describe("binding: one intent id may not be re-used for a different thing", () => {
  const mutations: Array<[string, IntentBinding]> = [
    ["tool", binding({ tool: "card.pay" })],
    ["caller", binding({ caller: "npub1mallory" })],
    ["orderHash", binding({ orderHash: orderHashOf({ url: "https://evil.example/x" }) })],
    ["amountSats", binding({ amountSats: 500 })],
    ["pmi", binding({ pmi: "lightning" })],
    ["quote", binding({ quote: "cashu:https://mint.example:500" })],
    ["fiatCap", binding({ fiatCap: 500 })],
    ["fiatCurrency", binding({ fiatCurrency: "USD" })],
  ];

  test("every bound field is checked, and every mismatch is refused", () => {
    expect(mutations.map(([f]) => f).sort()).toEqual([...BINDING_FIELDS].sort());
    for (const [field, mutated] of mutations) {
      expect(() => assertBindingMatches(binding(), mutated)).toThrow(IntentConflictError);
      // and the refusal names the field that differs
      try {
        assertBindingMatches(binding(), mutated);
      } catch (e) {
        expect((e as IntentConflictError).field).toBe(field);
      }
    }
  }, T);

  test("the identical binding is not a conflict", () => {
    expect(() => assertBindingMatches(binding(), binding())).not.toThrow();
  }, T);
});

describe("reserve: awaiting_payment -> settled_reserved, exactly once", () => {
  test("memory store: one winner, the next attempt loses", () => {
    const s = new MemoryIntentStore();
    s.create(intent("i1"));
    expect(s.reserve("i1", "awaiting_payment", "settled_reserved", "proof-A")).toBe("won");
    expect(s.get("i1")!.status).toBe("settled_reserved");
    expect(s.reserve("i1", "awaiting_payment", "settled_reserved", "proof-A")).toBe("lost");
  }, T);

  test("sqlite store: one winner, the next attempt loses", () => {
    const { store } = mkStore();
    store.create(intent("i1"));
    expect(store.reserve("i1", "awaiting_payment", "settled_reserved", "proof-A")).toBe("won");
    expect(store.get("i1")!.status).toBe("settled_reserved");
    expect(store.reserve("i1", "awaiting_payment", "settled_reserved", "proof-A")).toBe("lost");
    store.close();
  }, T);

  test("an unknown intent is reported as missing, not as a win", () => {
    const { store } = mkStore();
    expect(store.reserve("nope", "awaiting_payment", "settled_reserved")).toBe("missing");
    expect(new MemoryIntentStore().reserve("nope", "awaiting_payment", "settled_reserved")).toBe(
      "missing",
    );
    store.close();
  }, T);

  test("two independent connections to the same file: one winner only", () => {
    const { store, path } = mkStore();
    store.create(intent("i1"));
    const other = new SqliteIntentStore(path);
    expect(store.reserve("i1", "awaiting_payment", "settled_reserved", "proof-A")).toBe("won");
    // the second connection read the row as awaiting_payment before the winner
    // committed; its reserve must still lose because the UPDATE is conditional
    expect(other.reserve("i1", "awaiting_payment", "settled_reserved", "proof-B")).toBe("lost");
    // and the loser's proof was NOT consumed (its claim rolled back)
    expect(other.proofSpentBy("proof-B")).toBeUndefined();
    store.close();
    other.close();
  }, T);

  test("a terminal intent cannot be resurrected by a reserve", () => {
    const { store } = mkStore();
    store.create(intent("i1"));
    store.reserve("i1", "awaiting_payment", "settled_reserved", "proof-A");
    store.finish("i1", "settlement_failed", { failure: { message: "downstream 500", at: 2 } });
    expect(store.reserve("i1", "awaiting_payment", "settled_reserved", "proof-B")).toBe("lost");
    expect(store.get("i1")!.status).toBe("settlement_failed");
    store.close();
  }, T);
});

describe("the proof-reuse barrier is durable", () => {
  test("one proof cannot settle two intents", () => {
    const s = new MemoryIntentStore();
    s.create(intent("i1"));
    s.create(intent("i2"));
    expect(s.reserve("i1", "awaiting_payment", "settled_reserved", "proof-A")).toBe("won");
    expect(s.reserve("i2", "awaiting_payment", "settled_reserved", "proof-A")).toBe("proof_spent");
    // the refused intent is untouched - it is NOT half-claimed
    expect(s.get("i2")!.status).toBe("awaiting_payment");
    expect(s.proofSpentBy("proof-A")).toBe("i1");
  }, T);

  test("a restart does not restore a consumed proof or an unconsumed-looking intent", () => {
    const { store, path } = mkStore();
    store.create(intent("i1"));
    store.create(intent("i2"));
    expect(store.reserve("i1", "awaiting_payment", "settled_reserved", "proof-A")).toBe("won");
    store.close();

    // same file, brand new process-equivalent object
    const reopened = new SqliteIntentStore(path);
    expect(reopened.get("i1")!.status).toBe("settled_reserved");
    expect(reopened.get("i1")!.proofHash).toBe("proof-A");
    expect(reopened.proofSpentBy("proof-A")).toBe("i1");
    // the in-memory-only barrier would have forgotten this; the durable one does not
    expect(reopened.reserve("i2", "awaiting_payment", "settled_reserved", "proof-A")).toBe(
      "proof_spent",
    );
    expect(reopened.get("i2")!.status).toBe("awaiting_payment");
    reopened.close();
  }, T);
});
