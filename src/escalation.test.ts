/**
 * ADR-0012 escalation state machine (card t_89dcb160).
 *
 * The escalation is part of the settlement state machine: durable, idempotent,
 * initiated by the CVM, addressed to the CVM's OPERATOR, with replies as
 * durable-state inputs and a bounded-window alert. The DM is never the replay
 * barrier for anything.
 */
import { describe, expect, test } from "bun:test";
import { nip44, verifyEvent, type Event } from "nostr-tools";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MemoryIntentStore,
  orderHashOf,
  SqliteIntentStore,
  type IntentBinding,
} from "./intent-store.ts";
import {
  assertNoCardMaterial,
  cardMaterialPattern,
  DEFAULT_ESCALATION_WINDOW_SECONDS,
  EscalationMachine,
  EscalationRefusedError,
  escalationDmText,
  MemoryEscalationStore,
  NostrDmSink,
  operatorPubkeyOf,
  SqliteEscalationStore,
  type Dm,
} from "./escalation.ts";

// Real secp256k1 x-only pubkeys: a NIP-44 conversation key needs a point on the
// curve, so a repeated-hex string is not a valid stand-in for a recipient.
const OPERATOR = operatorPubkeyOf("b".repeat(64));
const CUSTOMER = operatorPubkeyOf("c".repeat(64));

const BINDING: IntentBinding = {
  tool: "card.pay_checkout",
  caller: OPERATOR,
  orderHash: orderHashOf({ url: "https://merchant.example/checkout", amount: "12.50" }),
  amountSats: 500,
  pmi: "bitcoin-cashu",
  quote: "cashu:https://mint.example:500",
  fiatCap: 12.5,
  fiatCurrency: "EUR",
};

const PAYLOAD = {
  intent_id: "i-esc-1",
  order_hash: BINDING.orderHash,
  sats_proof: "proof-ref-abc",
  rail: "bitcoin-cashu",
  amount_sats: 500,
  fiat_cap: "12.50 EUR",
  failed: "fiat leg declined by the merchant",
};

/** Records every DM; can be made to fail, to prove records survive send errors. */
class FakeSink {
  sent: Dm[] = [];
  failFor = new Set<string>();
  async send(dm: Dm): Promise<{ eventId: string }> {
    if (this.failFor.has(dm.to)) throw new Error("relay unreachable");
    this.sent.push(dm);
    return { eventId: `ev-${this.sent.length}` };
  }
}

function mkStores() {
  const dir = mkdtempSync(join(tmpdir(), "escalation-"));
  const escalations = new SqliteEscalationStore(join(dir, "esc.sqlite"));
  const intents = new SqliteIntentStore(join(dir, "intents.sqlite"));
  return { escalations, intents, dir };
}

const T = { timeout: 30_000 } as const;

function machine(args: {
  escalations: SqliteEscalationStore | MemoryEscalationStore;
  intents?: MemoryIntentStore | SqliteIntentStore;
  sink: FakeSink;
  now?: () => number;
  customer?: string;
}) {
  return new EscalationMachine({
    store: args.escalations,
    sink: args.sink,
    operator: OPERATOR,
    customer: args.customer,
    intents: args.intents,
    windowSeconds: 60,
    now: args.now,
  });
}

describe("raising an escalation", () => {
  test("a terminal failure notifies the OPERATOR once, with every required fact", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    const m = machine({ escalations, intents, sink });
    const rec = await m.raise({ intentId: "i-esc-1", kind: "fiat_action_failed", payload: PAYLOAD });

    expect(sink.sent.length).toBe(1);
    expect(sink.sent[0]!.to).toBe(OPERATOR);
    expect(rec.state).toBe("notified");
    for (const fact of [
      PAYLOAD.intent_id,
      PAYLOAD.order_hash,
      PAYLOAD.sats_proof,
      PAYLOAD.rail,
      String(PAYLOAD.amount_sats),
      PAYLOAD.fiat_cap,
      PAYLOAD.failed,
    ]) {
      expect(sink.sent[0]!.text).toContain(fact);
    }
    expect(escalations.byIntent("i-esc-1").length).toBe(1);
    escalations.close();
    intents.close();
  }, T);

  test("the escalation DM carries no card material, and card-shaped payloads are refused", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    const m = machine({ escalations, intents, sink });

    await expect(
      m.raise({
        intentId: "i-esc-pan",
        kind: "fiat_action_failed",
        payload: { ...PAYLOAD, failed: "card 5500 0000 0000 0004 declined, code 999" },
      }),
    ).rejects.toBeInstanceOf(EscalationRefusedError);
    expect(sink.sent.length).toBe(0);
    expect(escalations.list().length).toBe(0);

    expect(cardMaterialPattern("5500000000000004")).toBeDefined();
    expect(cardMaterialPattern("4111 1111 1111 1111")).toBeDefined();
    expect(cardMaterialPattern("expires 03/28")).toBeDefined();
    expect(cardMaterialPattern("cvv 123")).toBeDefined();
    expect(cardMaterialPattern("lnbc250n1p3deadbeefdeadbeefdeadbeef")).toBeDefined();
    expect(() => assertNoCardMaterial("order 12.50 EUR, rail cashu")).not.toThrow();

    await m.raise({ intentId: "i-esc-1", kind: "fiat_action_failed", payload: PAYLOAD });
    expect(cardMaterialPattern(sink.sent[0]!.text)).toBeUndefined();
    escalations.close();
    intents.close();
  }, T);

  test("the durable record is the barrier: a second raise never sends a second DM", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    const m = machine({ escalations, intents, sink });
    const first = await m.raise({ intentId: "i-esc-2", kind: "fiat_action_failed", payload: PAYLOAD });
    const second = await m.raise({
      intentId: "i-esc-2",
      kind: "fiat_action_failed",
      payload: { ...PAYLOAD, failed: "duplicate attempt detected" },
    });
    expect(sink.sent.length).toBe(1);
    expect(second.escalationId).toBe(first.escalationId);
    // the first failure reason stands; a replayed raise cannot overwrite state
    expect(second.payload.failed).toBe(PAYLOAD.failed);
    escalations.close();
    intents.close();
  }, T);

  test("the barrier survives a restart", async () => {
    const { escalations, intents, dir } = mkStores();
    const sink = new FakeSink();
    await machine({ escalations, intents, sink }).raise({
      intentId: "i-esc-3",
      kind: "fiat_action_failed",
      payload: PAYLOAD,
    });
    expect(sink.sent.length).toBe(1);
    escalations.close();

    const reopened = new SqliteEscalationStore(join(dir, "esc.sqlite"));
    await machine({ escalations: reopened, sink }).raise({
      intentId: "i-esc-3",
      kind: "fiat_action_failed",
      payload: PAYLOAD,
    });
    expect(sink.sent.length).toBe(1); // no second DM after the restart
    reopened.close();
    intents.close();
  }, T);

  test("the record is durable BEFORE the send, so a failed relay cannot lose it", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    sink.failFor.add(OPERATOR);
    const m = machine({ escalations, intents, sink });
    const rec = await m.raise({ intentId: "i-esc-4", kind: "fiat_action_failed", payload: PAYLOAD });
    expect(rec.state).toBe("open"); // not "notified": we do not claim a delivery we did not get
    expect(escalations.get("i-esc-4:fiat_action_failed")).toBeDefined();
    escalations.close();
    intents.close();
  }, T);
});

describe("replies are durable-state inputs", () => {
  test('"refunded" moves the intent to the terminal refunded state', async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    intents.create({
      intentId: "i-esc-5",
      ...BINDING,
      status: "settlement_failed",
      createdAt: 1,
      updatedAt: 1,
    });
    const m = machine({ escalations, intents, sink });
    await m.raise({ intentId: "i-esc-5", kind: "fiat_action_failed", payload: PAYLOAD });
    const rec = await m.applyReply({ intentId: "i-esc-5", text: "refunded, sorry about that", from: OPERATOR });
    expect(rec!.state).toBe("resolved");
    expect(rec!.resolution).toBe("refunded");
    expect(intents.get("i-esc-5")!.status).toBe("refunded");
    expect(rec!.replies.length).toBe(1);
    escalations.close();
    intents.close();
  }, T);

  test("NO reply can re-arm an intent", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    intents.create({
      intentId: "i-esc-6",
      ...BINDING,
      status: "settlement_failed",
      createdAt: 1,
      updatedAt: 1,
    });
    const m = machine({ escalations, intents, sink });
    await m.raise({ intentId: "i-esc-6", kind: "fiat_action_failed", payload: PAYLOAD });
    for (const text of ["retry it", "paid", "settled", "go ahead", "ok", "", "please charge again"]) {
      const rec = await m.applyReply({ intentId: "i-esc-6", text, from: OPERATOR });
      expect(intents.get("i-esc-6")!.status).toBe("settlement_failed");
      expect(rec!.state).not.toBe("resolved");
    }
    // a captured/replayed refund reply from a non-refund intent cannot resurrect it
    expect(intents.get("i-esc-6")!.status).toBe("settlement_failed");
    escalations.close();
    intents.close();
  }, T);

  test("an UNAUTHORIZED reply is recorded but changes nothing (a customer cannot resolve their own escalation)", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    intents.create({
      intentId: "i-esc-auth",
      ...BINDING,
      status: "settlement_failed",
      createdAt: 1,
      updatedAt: 1,
    });
    const m = machine({ escalations, intents, sink, customer: CUSTOMER });
    await m.raise({
      intentId: "i-esc-auth",
      kind: "fiat_action_failed",
      payload: PAYLOAD,
      customer: CUSTOMER,
    });

    const rec = await m.applyReply({ intentId: "i-esc-auth", text: "refunded", from: CUSTOMER });
    // recorded for the audit trail, but inert: the intent stays failed and the
    // escalation stays visible to the operator (sweep still alerts on it)
    expect(rec!.replies.length).toBe(1);
    expect(rec!.replies[0]!.from).toBe(CUSTOMER);
    expect(rec!.state).toBe("notified");
    expect(rec!.resolution).toBeUndefined();
    expect(intents.get("i-esc-auth")!.status).toBe("settlement_failed");

    // ... and the operator's own reply still works
    const ok = await m.applyReply({ intentId: "i-esc-auth", text: "refunded", from: OPERATOR });
    expect(ok!.state).toBe("resolved");
    expect(intents.get("i-esc-auth")!.status).toBe("refunded");
    escalations.close();
    intents.close();
  }, T);

  test("the operator is never used as its own customer thread", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    const m = machine({ escalations, intents, sink });
    const rec = await m.raise({
      intentId: "i-esc-self",
      kind: "fiat_action_failed",
      payload: PAYLOAD,
      customer: OPERATOR,
    });
    expect(rec.customer).toBeUndefined();
    expect(sink.sent.map((d) => d.to)).toEqual([OPERATOR]); // one DM, not two
    escalations.close();
    intents.close();
  }, T);

  test('"refunded" does NOT overwrite an intent that actually settled', async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    intents.create({
      intentId: "i-esc-7",
      ...BINDING,
      status: "settled",
      createdAt: 1,
      updatedAt: 1,
    });
    const m = machine({ escalations, intents, sink });
    await m.raise({ intentId: "i-esc-7", kind: "duplicate_attempt", payload: PAYLOAD });
    await m.applyReply({ intentId: "i-esc-7", text: "refunded", from: OPERATOR });
    expect(intents.get("i-esc-7")!.status).toBe("settled");
    escalations.close();
    intents.close();
  }, T);
});

describe("bounded window", () => {
  test("an unresolved escalation past the window raises an alert, exactly once", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    let now = 1_000_000;
    const m = machine({ escalations, intents, sink, now: () => now });
    await m.raise({ intentId: "i-esc-8", kind: "fiat_action_failed", payload: PAYLOAD });
    expect(await m.sweep()).toEqual([]);

    now += 61_000;
    const alerted = await m.sweep();
    expect(alerted.length).toBe(1);
    expect(alerted[0]!.state).toBe("alerted");
    expect(alerted[0]!.alertedAt).toBe(now);
    expect(sink.sent[1]!.text).toContain("UNRESOLVED");
    expect(await m.sweep()).toEqual([]); // idempotent
    expect(sink.sent.length).toBe(2);
    escalations.close();
    intents.close();
  }, T);

  test("a resolved escalation is never alerted", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    let now = 1_000_000;
    intents.create({
      intentId: "i-esc-9",
      ...BINDING,
      status: "settlement_failed",
      createdAt: 1,
      updatedAt: 1,
    });
    const m = machine({ escalations, intents, sink, now: () => now });
    await m.raise({ intentId: "i-esc-9", kind: "fiat_action_failed", payload: PAYLOAD });
    await m.applyReply({ intentId: "i-esc-9", text: "refunded", from: OPERATOR });
    now += 10 * DEFAULT_ESCALATION_WINDOW_SECONDS * 1000;
    expect(await m.sweep()).toEqual([]);
    escalations.close();
    intents.close();
  }, T);

  test("a failing customer thread does not block or undo the operator DM", async () => {
    const { escalations, intents } = mkStores();
    const sink = new FakeSink();
    sink.failFor.add(CUSTOMER);
    const m = machine({ escalations, intents, sink, customer: CUSTOMER });
    const rec = await m.raise({ intentId: "i-esc-10", kind: "fiat_action_failed", payload: PAYLOAD });
    expect(rec.state).toBe("notified");
    expect(sink.sent.map((d) => d.to)).toEqual([OPERATOR]);
    escalations.close();
    intents.close();
  }, T);
});

describe("the real Nostr sink", () => {
  test("gift-wraps a NIP-44 DM to the recipient and signs with the CVM key", async () => {
    const sk = "a".repeat(64);
    const published: any[] = [];
    const sink = new NostrDmSink(sk, async (e) => {
      published.push(e);
    });
    const { eventId } = await sink.send({ to: OPERATOR, text: escalationDmText({
      escalationId: "x",
      intentId: PAYLOAD.intent_id,
      kind: "fiat_action_failed",
      state: "open",
      operator: OPERATOR,
      payload: PAYLOAD,
      replies: [],
      windowSeconds: 60,
      createdAt: 1,
      updatedAt: 1,
    }, "operator") });
    expect(eventId).toBeTruthy();
    expect(published.length).toBe(1);
    expect(published[0].kind).toBe(1059);
    expect(published[0].tags).toEqual([["p", OPERATOR]]);
    expect(published[0].pubkey).not.toBe(operatorPubkeyOf(sk)); // ephemeral wrapper key
    expect(published[0].content).not.toContain(PAYLOAD.failed); // it is encrypted
  }, T);

  test("the sink refuses card-shaped text before it can be encrypted and sent", async () => {
    const published: any[] = [];
    const sink = new NostrDmSink("a".repeat(64), async (e) => {
      published.push(e);
    });
    await expect(sink.send({ to: OPERATOR, text: "card 4111111111111111" })).rejects.toBeInstanceOf(
      EscalationRefusedError,
    );
    expect(published.length).toBe(0);
  }, T);

  /**
   * The whole point of the escalation: the OPERATOR must be able to READ it.
   * A gift wrap that encrypts to the recipient with one key and signs with
   * another is undecryptable - and a test that only asserts "the content is not
   * plaintext" passes happily on such a DM. This test decrypts.
   */
  test("the operator can DECRYPT the DM, and it is signed by the CVM (the CVM is the actor)", async () => {
    const ownerSk = "b".repeat(64); // OPERATOR's key
    const cvmSk = "a".repeat(64); // the service's own identity
    const owner = operatorPubkeyOf(ownerSk);
    expect(owner).toBe(OPERATOR);

    const published: Event[] = [];
    const sink = new NostrDmSink(cvmSk, async (e) => {
      published.push(e as Event);
    });
    await sink.send({ to: owner, text: "intent i-esc-live needs a manual refund" });

    const wrap = published[0]!;
    expect(wrap.kind).toBe(1059);
    expect(verifyEvent(wrap)).toBe(true);

    // Exactly what the operator does with their own key and the wrapper pubkey.
    const convKey = nip44.v2.utils.getConversationKey(
      hexBytes(ownerSk),
      wrap.pubkey,
    );
    const inner = JSON.parse(nip44.v2.decrypt(wrap.content, convKey)) as Event;
    expect(inner.content).toContain("i-esc-live");
    // the inner event is the CVM's: the operator can tell WHO escalated
    expect(inner.pubkey).toBe(operatorPubkeyOf(cvmSk));
    expect(verifyEvent(inner)).toBe(true);
  }, T);
});

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}
