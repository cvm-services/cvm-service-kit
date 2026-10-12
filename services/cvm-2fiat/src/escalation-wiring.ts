/**
 * escalation-wiring.ts — ADR-0012 escalation, wired into cvm-2fiat.
 *
 * The amendment is a wiring requirement, not a library one: the escalation is
 * INITIATED BY THE CVM and its recipient is the CVM's OPERATOR. Reuse the
 * identity the service already has -
 *
 *   OWNER_NPUB_HEX — the key `assertOwner()` gates owner-only card.balance on;
 *   SERVER_SECRET_KEY — the CVM's own Nostr identity.
 *
 * No second support npub is minted (there is nothing to rotate, and nothing to
 * lose). The customer-facing thread is subordinate: the payer of the intent
 * gets a thread when it is not the operator, and a failed customer DM cannot
 * change or undo the operator DM.
 *
 * Everything durable lives on disk next to the gate store, so the barrier is
 * the SQLite row — never the DM, and never an in-memory event-id cache.
 */
import { join } from "node:path";
import {
  EscalationMachine,
  type EscalationPayload,
  type EscalationRecord,
  FiatSettlementMachine,
  NostrDmSink,
  type PaymentIntent,
  type PublishEvent,
  SqliteEscalationStore,
  SqliteIntentStore,
  type SettlementMachineOptions,
} from "../../../src/index.ts";

export interface TwoFiatEscalationDeps {
  /** OWNER_NPUB_HEX — the operator/payer-of-last-resort key (lowercase hex). */
  ownerNpub: string;
  /** SERVER_SECRET_KEY — the CVM's own identity; the CVM is the actor. */
  secretKey: string | Uint8Array;
  /** Publishes an already-signed event. `CvmServer.publishEvent` does. */
  publish: PublishEvent;
  /** Directory for intents.sqlite + escalations.sqlite (e.g. /var/lib/loom/cvm-2fiat). */
  dataDir: string;
  /** Bounded window: unresolved past this raises an alert. Default 24h. */
  windowSeconds?: number;
  now?: () => number;
}

export interface TwoFiatEscalation {
  intents: SqliteIntentStore;
  escalations: SqliteEscalationStore;
  machine: EscalationMachine;
  /** The hook `FiatSettlementMachine` calls when the sats are final and the fiat leg failed. */
  escalate: NonNullable<SettlementMachineOptions["escalate"]>;
  /** The settlement machine, already wired to the escalation path. */
  settlement: FiatSettlementMachine;
  close(): void;
}

/**
 * The six facts the operator needs, and nothing else. There is no field for a
 * card number, an expiry, a CVV or a raw token: a raw token could not be stored
 * here even by accident, because the intent table only ever holds its hash.
 */
export function escalationPayloadFrom(intent: PaymentIntent, failed: string): EscalationPayload {
  return {
    intent_id: intent.intentId,
    order_hash: intent.orderHash,
    sats_proof: intent.proofHash ?? "no-proof-recorded",
    rail: intent.pmi,
    amount_sats: intent.amountSats,
    fiat_cap: `${intent.fiatCap} ${intent.fiatCurrency}`,
    failed,
  };
}

export function buildTwoFiatEscalation(d: TwoFiatEscalationDeps): TwoFiatEscalation {
  const owner = d.ownerNpub.trim().toLowerCase();
  const intents = new SqliteIntentStore(join(d.dataDir, "intents.sqlite"));
  const escalations = new SqliteEscalationStore(join(d.dataDir, "escalations.sqlite"));
  const machine = new EscalationMachine({
    store: escalations,
    sink: new NostrDmSink(d.secretKey, d.publish),
    operator: owner,
    intents,
    windowSeconds: d.windowSeconds,
    now: d.now,
  });

  const escalate: TwoFiatEscalation["escalate"] = async ({ intentId, kind, reason, intent }) => {
    // The payer of THIS intent is the customer, not a service constant.
    await machine.raise({
      intentId,
      kind,
      payload: escalationPayloadFrom(intent, reason),
      customer: intent.caller,
    });
  };

  return {
    intents,
    escalations,
    machine,
    escalate,
    settlement: new FiatSettlementMachine(intents, { escalate }),
    close() {
      intents.close();
      escalations.close();
    },
  };
}

/** Escalations still awaiting operator action — for a sweep loop or a health check. */
export function openEscalations(e: TwoFiatEscalation): EscalationRecord[] {
  return e.escalations
    .list()
    .filter((r) => r.state === "open" || r.state === "notified");
}
