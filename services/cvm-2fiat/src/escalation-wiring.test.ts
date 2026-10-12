/**
 * ADR-0012 escalation, tested through the cvm-2fiat wiring (card t_89dcb160).
 *
 * The amendment's claim is a wiring claim: the escalation is initiated BY THE
 * CVM and addressed to the CVM's OPERATOR, reusing the identity the service
 * already has. So these tests do not inject a fake sink - they build the real
 * wiring (real NostrDmSink, real NIP-44 gift wrap, real SQLite barrier) and
 * then DECRYPT what was actually published, with the operator's own key. A test
 * that only asserted "ciphertext is not plaintext" would pass on a DM nobody
 * can read.
 */
import { describe, expect, test } from "bun:test";
import { nip44, verifyEvent, type Event } from "nostr-tools";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IntentTerminalError,
  orderHashOf,
  operatorPubkeyOf,
  SettlementFailedError,
  type IntentBinding,
} from "../../../src/index.ts";
import { buildTwoFiatEscalation, openEscalations } from "./escalation-wiring.ts";

const OWNER_SK = "b".repeat(64);
const CVM_SK = "a".repeat(64);
const CUSTOMER_SK = "c".repeat(64);
const OWNER_NPUB = operatorPubkeyOf(OWNER_SK); // == OWNER_NPUB_HEX
const CUSTOMER_NPUB = operatorPubkeyOf(CUSTOMER_SK);

const binding = (over: Partial<IntentBinding> = {}): IntentBinding => ({
  tool: "card.pay_checkout",
  caller: CUSTOMER_NPUB,
  orderHash: orderHashOf({ url: "https://merchant.example/checkout", amount: "12.50" }),
  amountSats: 500,
  pmi: "bitcoin-cashu",
  quote: "cashu:https://mint.example:500",
  fiatCap: 12.5,
  fiatCurrency: "EUR",
  ...over,
});

/** The service as deployed: SERVER_SECRET_KEY + OWNER_NPUB_HEX + a publisher. */
function mkService(over: { windowSeconds?: number; now?: () => number } = {}) {
  const published: Event[] = [];
  const svc = buildTwoFiatEscalation({
    ownerNpub: OWNER_NPUB,
    secretKey: CVM_SK,
    publish: async (e) => void published.push(e),
    dataDir: mkdtempSync(join(tmpdir(), "2fiat-esc-")),
    windowSeconds: over.windowSeconds ?? 3600,
    now: over.now,
  });
  return { svc, published };
}

/** Exactly what the operator can do with a delivered gift wrap. */
function readAs(skHex: string, wrap: Event): Event | undefined {
  try {
    const convKey = nip44.v2.utils.getConversationKey(
      new Uint8Array(skHex.match(/.{2}/g)!.map((b) => parseInt(b, 16))),
      wrap.pubkey,
    );
    return JSON.parse(nip44.v2.decrypt(wrap.content, convKey)) as Event;
  } catch {
    return undefined;
  }
}

/** Run one paid intent whose fiat leg fails. Returns the intent id. */
async function runFailingFiat(
  svc: ReturnType<typeof mkService>["svc"],
  intentId: string,
  over: Partial<IntentBinding> = {},
) {
  const b = binding(over);
  await aimFail(svc, intentId, b);
  return b;
}

function aimFail(
  svc: ReturnType<typeof mkService>["svc"],
  intentId: string,
  b: IntentBinding,
) {
  return svc.settlement.run({
    intentId,
    binding: b,
    proof: "cashu-token-shared",
    settle: async () => ({
      pmi: b.pmi,
      proofRef: "redeemed-proof-hash",
      amountSats: b.amountSats,
      settledAt: 1,
    }),
    run: async () => {
      throw new Error("fiat leg declined by the merchant");
    },
  });
}

const T = { timeout: 30_000 } as const;

describe("the CVM escalates to its OWNER_NPUB_HEX", () => {
  test("a failed fiat leg after settled sats DMs the operator, readable and signed by the CVM", async () => {
    const { svc, published } = mkService();

    await expect(aimFail(svc, "i-live-1", binding())).rejects.toThrow("declined");

    // ONE DM for the operator. (The customer thread is checked separately.)
    const toOwner = published.filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === OWNER_NPUB));
    expect(toOwner.length).toBe(1);

    const wrap = toOwner[0]!;
    expect(wrap.kind).toBe(1059);
    expect(verifyEvent(wrap)).toBe(true);

    const inner = readAs(OWNER_SK, wrap);
    expect(inner).toBeDefined();
    expect(inner!.pubkey).toBe(operatorPubkeyOf(CVM_SK)); // the CVM is the actor
    expect(verifyEvent(inner!)).toBe(true);

    // every fact the amendment requires
    for (const fact of [
      "i-live-1",
      binding().orderHash,
      svc.intents.get("i-live-1")!.proofHash!,
      "bitcoin-cashu",
      "500",
      "12.5 EUR",
      "fiat leg declined by the merchant",
    ]) {
      expect(inner!.content).toContain(fact);
    }
    expect(svc.intents.get("i-live-1")!.status).toBe("settlement_failed");
    svc.close();
  }, T);

  test("the payer gets a subordinate thread, and its failure cannot change the operator DM", async () => {
    const { svc, published } = mkService();
    await expect(aimFail(svc, "i-live-2", binding())).rejects.toThrow("declined");

    const toCustomer = published.filter((e) =>
      e.tags.some((t) => t[0] === "p" && t[1] === CUSTOMER_NPUB),
    );
    expect(toCustomer.length).toBe(1);
    const custText = readAs(CUSTOMER_SK, toCustomer[0]!)!.content;
    expect(custText).toContain("i-live-2");
    // hashes/ids only for the customer too, and no operator instructions
    // (the customer cannot be told how to resolve the operator's escalation)
    expect(custText).not.toContain('Reply "refunded"');
    expect(custText).not.toMatch(/(?:\d[ -]?){12,18}\d/);
    expect(svc.escalations.byIntent("i-live-2")[0]!.state).toBe("notified");
    svc.close();
  }, T);

  test("a CUSTOMER reply cannot resolve the operator's escalation", async () => {
    const { svc } = mkService();
    await expect(aimFail(svc, "i-live-8", binding())).rejects.toThrow("declined");

    const rec = await svc.machine.applyReply({
      intentId: "i-live-8",
      text: "refunded",
      from: CUSTOMER_NPUB,
    });
    expect(rec!.state).toBe("notified"); // still the operator's problem
    expect(rec!.replies[0]!.from).toBe(CUSTOMER_NPUB);
    expect(svc.intents.get("i-live-8")!.status).toBe("settlement_failed");
    expect(openEscalations(svc).length).toBe(1);

    // the operator's reply is the one that counts
    const ok = await svc.machine.applyReply({
      intentId: "i-live-8",
      text: "refunded",
      from: OWNER_NPUB,
    });
    expect(ok!.state).toBe("resolved");
    expect(svc.intents.get("i-live-8")!.status).toBe("refunded");
    expect(openEscalations(svc).length).toBe(0);
    svc.close();
  }, T);

  test("no escalation ever carries card material", async () => {
    const { svc, published } = mkService();
    await expect(aimFail(svc, "i-live-3", binding())).rejects.toThrow("declined");
    for (const wrap of published) {
      for (const inner of [readAs(OWNER_SK, wrap), readAs(CUSTOMER_SK, wrap)]) {
        if (inner) expect(inner.content).not.toMatch(/(?:\d[ -]?){12,18}\d/);
      }
    }
    svc.close();
  }, T);

  test("a retry of the failed intent is refused and never escalates twice", async () => {
    const { svc, published } = mkService();
    await expect(aimFail(svc, "i-live-4", binding())).rejects.toThrow("declined");
    const first = published.length;
    expect(first).toBeGreaterThan(1);

    // the sats are final: a retry is refused before the fiat leg is even reached
    await expect(aimFail(svc, "i-live-4", binding())).rejects.toBeInstanceOf(SettlementFailedError);
    expect(published.length).toBe(first);
    expect(svc.escalations.byIntent("i-live-4").length).toBe(1);
    svc.close();
  }, T);

  test("the escalation barrier is on disk, not in an in-memory cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "2fiat-esc-restart-"));
    const published: Event[] = [];
    const opts = {
      ownerNpub: OWNER_NPUB,
      secretKey: CVM_SK,
      publish: async (e: Event) => void published.push(e),
      dataDir: dir,
    };
    const first = buildTwoFiatEscalation(opts);
    await expect(aimFail(first, "i-live-5", binding())).rejects.toThrow("declined");
    const afterFirst = published.length;
    first.close();

    // fresh process-equivalent: same directory, brand new objects
    const second = buildTwoFiatEscalation(opts);
    await second.machine.raise({
      intentId: "i-live-5",
      kind: "fiat_action_failed",
      payload: {
        intent_id: "i-live-5",
        order_hash: binding().orderHash,
        sats_proof: "h",
        rail: "bitcoin-cashu",
        amount_sats: 500,
        fiat_cap: "12.5 EUR",
        failed: "duplicate attempt detected",
      },
    });
    expect(published.length).toBe(afterFirst); // no second DM after the restart
    second.close();
  }, T);
});

describe("operator replies and the bounded window", () => {
  test('"refunded" from the operator moves the intent to a TERMINAL refunded state', async () => {
    const { svc } = mkService();
    await expect(aimFail(svc, "i-live-6", binding())).rejects.toThrow("declined");

    const rec = await svc.machine.applyReply({ intentId: "i-live-6", text: "refunded, sorry", from: OWNER_NPUB });
    expect(rec!.resolution).toBe("refunded");
    expect(svc.intents.get("i-live-6")!.status).toBe("refunded");

    // terminal: it can never be re-armed into another fiat attempt
    await expect(aimFail(svc, "i-live-6", binding())).rejects.toBeInstanceOf(IntentTerminalError);
    svc.close();
  }, T);

  test("an unresolved escalation past the window alerts the operator, exactly once", async () => {
    let now = 1_000_000;
    const { svc, published } = mkService({ windowSeconds: 60, now: () => now });
    await expect(aimFail(svc, "i-live-7", binding())).rejects.toThrow("declined");
    expect(await svc.machine.sweep()).toEqual([]);

    now += 61_000;
    const alerted = await svc.machine.sweep();
    expect(alerted.length).toBe(1);
    expect(alerted[0]!.state).toBe("alerted");
    expect(readAs(OWNER_SK, published.at(-1)!)!.content).toContain("UNRESOLVED");
    expect(await svc.machine.sweep()).toEqual([]); // idempotent
    expect(openEscalations(svc).length).toBe(0);
    svc.close();
  }, T);
});
