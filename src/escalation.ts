/**
 * ADR-0012 escalation state machine (card t_89dcb160).
 *
 * The escalation is INITIATED BY THE CVM and its recipient is the CVM's
 * OPERATOR - the identity the service already has (`OWNER_NPUB_HEX`, the key
 * `assertOwner()` gates owner-only `card.balance` on). No second npub.
 *
 * It is part of the settlement state machine, not a logging helper:
 *
 *  - raising is DURABLE and idempotent per (intent, kind), so the durable
 *    record - never the DM - is the replay barrier;
 *  - a DM reply ("refunded") is an INPUT that updates durable state, and it can
 *    only ever move an intent to a TERMINAL state, never re-arm one;
 *  - an escalation unresolved inside a bounded window raises an alert;
 *  - no card material ever leaves: the payload is ids/hashes/amounts only, and
 *    anything card-shaped is refused before it is stored or sent.
 */
import { Database } from "bun:sqlite";
import { finalizeEvent, getPublicKey, nip44, type Event } from "nostr-tools";
import type { IntentStore } from "./intent-store.ts";

export type EscalationKind = "fiat_action_failed" | "duplicate_attempt";
export type EscalationState = "open" | "notified" | "resolved" | "alerted";

/** The six facts the operator needs to act. Never a PAN, CVV, expiry or token. */
export interface EscalationPayload {
  intent_id: string;
  order_hash: string;
  sats_proof: string;
  rail: string;
  amount_sats: number;
  fiat_cap: string;
  failed: string;
}

export interface EscalationRecord {
  /** Deterministic: `${intentId}:${kind}` - the durable dedupe key. */
  escalationId: string;
  intentId: string;
  kind: EscalationKind;
  state: EscalationState;
  /** The CVM operator (cvm-2fiat: OWNER_NPUB_HEX). */
  operator: string;
  /** Optional customer thread, subordinate to the operator DM. */
  customer?: string;
  payload: EscalationPayload;
  replies: Array<{ text: string; at: number }>;
  windowSeconds: number;
  notifiedAt?: number;
  alertedAt?: number;
  resolvedAt?: number;
  resolution?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Dm {
  to: string;
  text: string;
}

export interface DmSink {
  send(dm: Dm): Promise<{ eventId: string }>;
}

export interface EscalationStore {
  get(escalationId: string): EscalationRecord | undefined;
  byIntent(intentId: string): EscalationRecord[];
  list(): EscalationRecord[];
  /** Insert if absent. Returns false when the id already exists (durable dedupe). */
  create(rec: EscalationRecord): boolean;
  put(rec: EscalationRecord): void;
}

/** A payload carried card material, or an escalation could not be recorded. */
export class EscalationRefusedError extends Error {
  readonly code = -32010;
}

export const DEFAULT_ESCALATION_WINDOW_SECONDS = 60 * 60 * 24;

export class MemoryEscalationStore implements EscalationStore {
  private readonly m = new Map<string, EscalationRecord>();
  get(id: string) {
    return this.m.get(id);
  }
  byIntent(intentId: string) {
    return this.list().filter((r) => r.intentId === intentId);
  }
  list() {
    return [...this.m.values()];
  }
  create(rec: EscalationRecord): boolean {
    if (this.m.has(rec.escalationId)) return false;
    this.m.set(rec.escalationId, { ...rec });
    return true;
  }
  put(rec: EscalationRecord): void {
    this.m.set(rec.escalationId, { ...rec });
  }
}

export class SqliteEscalationStore implements EscalationStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS escalations (
        escalation_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        operator TEXT NOT NULL,
        customer TEXT,
        payload_json TEXT NOT NULL,
        replies_json TEXT NOT NULL,
        window_seconds INTEGER NOT NULL,
        notified_at INTEGER,
        alerted_at INTEGER,
        resolved_at INTEGER,
        resolution TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
  }

  get(id: string): EscalationRecord | undefined {
    const r = this.db.query(`SELECT * FROM escalations WHERE escalation_id = ?`).get(id) as any;
    return r ? rowToRecord(r) : undefined;
  }

  byIntent(intentId: string): EscalationRecord[] {
    return (this.db
      .query(`SELECT * FROM escalations WHERE intent_id = ? ORDER BY created_at`)
      .all(intentId) as any[]).map(rowToRecord);
  }

  list(): EscalationRecord[] {
    return (this.db.query(`SELECT * FROM escalations ORDER BY created_at`).all() as any[]).map(
      rowToRecord,
    );
  }

  create(rec: EscalationRecord): boolean {
    const res = this.db.run(
      `INSERT OR IGNORE INTO escalations
         (escalation_id, intent_id, kind, state, operator, customer, payload_json,
          replies_json, window_seconds, notified_at, alerted_at, resolved_at,
          resolution, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rec.escalationId,
        rec.intentId,
        rec.kind,
        rec.state,
        rec.operator,
        rec.customer ?? null,
        JSON.stringify(rec.payload),
        JSON.stringify(rec.replies),
        rec.windowSeconds,
        rec.notifiedAt ?? null,
        rec.alertedAt ?? null,
        rec.resolvedAt ?? null,
        rec.resolution ?? null,
        rec.createdAt,
        rec.updatedAt,
      ],
    );
    return Number(res.changes ?? 0) === 1;
  }

  put(rec: EscalationRecord): void {
    this.db.run(
      `UPDATE escalations
          SET state = ?, replies_json = ?, notified_at = ?, alerted_at = ?,
              resolved_at = ?, resolution = ?, updated_at = ?
        WHERE escalation_id = ?`,
      [
        rec.state,
        JSON.stringify(rec.replies),
        rec.notifiedAt ?? null,
        rec.alertedAt ?? null,
        rec.resolvedAt ?? null,
        rec.resolution ?? null,
        rec.updatedAt,
        rec.escalationId,
      ],
    );
  }

  close(): void {
    this.db.close();
  }
}

export interface EscalationMachineOptions {
  store: EscalationStore;
  sink: DmSink;
  /** The CVM's operator key (cvm-2fiat: OWNER_NPUB_HEX). */
  operator: string;
  customer?: string;
  windowSeconds?: number;
  /** The durable intent table: a "refunded" reply writes a terminal state. */
  intents?: IntentStore;
  now?: () => number;
}

export class EscalationMachine {
  constructor(private readonly o: EscalationMachineOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /**
   * Raise (or re-fetch) the escalation for an intent. At most ONE DM per
   * (intent, kind) is ever sent: the durable row is written first and is what
   * later calls see. A DM is never the barrier for anything.
   */
  async raise(args: {
    intentId: string;
    kind: EscalationKind;
    payload: EscalationPayload;
  }): Promise<EscalationRecord> {
    assertNoCardMaterial(JSON.stringify(args.payload));
    const escalationId = `${args.intentId}:${args.kind}`;
    const existing = this.o.store.get(escalationId);
    if (existing) return existing; // durable dedupe: no second DM, ever

    const t = this.now();
    const rec: EscalationRecord = {
      escalationId,
      intentId: args.intentId,
      kind: args.kind,
      state: "open",
      operator: this.o.operator,
      customer: this.o.customer,
      payload: args.payload,
      replies: [],
      windowSeconds: this.o.windowSeconds ?? DEFAULT_ESCALATION_WINDOW_SECONDS,
      createdAt: t,
      updatedAt: t,
    };
    // Durable BEFORE the DM: a send that fails must not lose the escalation.
    if (!this.o.store.create(rec)) return this.o.store.get(escalationId)!;

    const text = escalationDmText(rec, "operator");
    try {
      await this.o.sink.send({ to: rec.operator, text });
      rec.state = "notified";
      rec.notifiedAt = this.now();
      this.o.store.put(rec);
    } catch {
      // stays "open": sweep() will alert on the unresolved window.
    }

    // The customer thread is a recommendation, subordinate to the operator DM:
    // its failure must not (and cannot) change the operator notification.
    if (rec.customer) {
      try {
        await this.o.sink.send({
          to: rec.customer,
          text: escalationDmText(rec, "customer"),
        });
      } catch {
        /* subordinate: ignored on purpose */
      }
    }
    return rec;
  }

  /**
   * A DM reply is an INPUT that updates durable state. It can only ever move an
   * intent to a TERMINAL state - no reply text can re-arm an intent, so a
   * captured/replayed reply is inert.
   */
  async applyReply(args: { intentId: string; text: string }): Promise<EscalationRecord | undefined> {
    const recs = this.o.store.byIntent(args.intentId);
    if (recs.length === 0) return undefined;
    const rec = recs[recs.length - 1];
    rec.replies.push({ text: args.text, at: this.now() });
    rec.updatedAt = this.now();

    const refunded = /\brefund(ed|ing)?\b/i.test(args.text);
    if (refunded && this.o.intents) {
      const intent = this.o.intents.get(args.intentId);
      if (intent && intent.status !== "settled") {
        // Terminal only. Never back to awaiting_payment / settled_reserved.
        this.o.intents.finish(args.intentId, "refunded");
      }
      rec.state = "resolved";
      rec.resolution = "refunded";
      rec.resolvedAt = this.now();
    }
    this.o.store.put(rec);
    return rec;
  }

  /** Bounded window: an unresolved escalation raises an alert (once). */
  async sweep(): Promise<EscalationRecord[]> {
    const now = this.now();
    const alerted: EscalationRecord[] = [];
    for (const rec of this.o.store.list()) {
      if (rec.state !== "open" && rec.state !== "notified") continue;
      const since = rec.notifiedAt ?? rec.createdAt;
      if (now - since < rec.windowSeconds * 1000) continue;
      rec.state = "alerted";
      rec.alertedAt = now;
      rec.updatedAt = now;
      this.o.store.put(rec);
      alerted.push(rec);
      try {
        await this.o.sink.send({
          to: rec.operator,
          text: escalationDmText(rec, "alert"),
        });
      } catch {
        /* the durable "alerted" state stands; a later sweep does not re-alert */
      }
    }
    return alerted;
  }
}

export function escalationDmText(
  rec: EscalationRecord,
  audience: "operator" | "customer" | "alert",
): string {
  const id = rec.intentId.slice(0, 16);
  const head =
    audience === "alert"
      ? `[cvm] ESCALATION UNRESOLVED past ${rec.windowSeconds}s - operator action still required`
      : audience === "customer"
        ? `[cvm] we are resolving an issue with your payment (intent ${id}...)`
        : `[cvm] FIAT SETTLEMENT FAILED (${rec.kind}) - manual action required`;
  const body = [
    `intent_id: ${rec.payload.intent_id}`,
    `order_hash: ${rec.payload.order_hash}`,
    `sats_proof: ${rec.payload.sats_proof}`,
    `rail: ${rec.payload.rail}`,
    `amount_sats: ${rec.payload.amount_sats}`,
    `fiat_cap: ${rec.payload.fiat_cap}`,
    `failed: ${rec.payload.failed}`,
  ];
  const foot =
    audience === "customer"
      ? ["Reply to this thread with any question; support answers.", "no card details are ever requested here"]
      : [
          `Reply "refunded" once the fiat leg is refunded; that reply updates durable state.`,
          `escalation: ${rec.escalationId}`,
        ];
  return [head, ...body, ...foot].join("\n");
}

/**
 * Refuse anything card-shaped. Hashes/ids/amounts only: no PAN (13-19 digits,
 * optionally spaced/dashed), no expiry, no CVV, no Cashu token / BOLT11 string.
 */
export function assertNoCardMaterial(text: string): void {
  const hit = cardMaterialPattern(text);
  if (hit) throw new EscalationRefusedError(`refusing to escalate card-shaped material: ${hit}`);
}

export function cardMaterialPattern(text: string): string | undefined {
  // 13-19 digits with optional space/dash grouping (PAN / long account number)
  if (/\b(?:\d[ -]?){12,18}\d\b/.test(text)) return "pan-shaped digit run";
  // Cashu token / BOLT11 / bc1 addresses must never appear either
  if (/cashu[AB][0-9A-Za-z._-]{20,}/.test(text)) return "cashu token";
  if (/\blnbc[0-9a-z]{20,}\b/i.test(text)) return "bolt11 invoice";
  if (/\bcvv\b|\bcvc\b|security code/i.test(text)) return "cvv reference";
  if (/\b(0[1-9]|1[0-2])\/\d{2,4}\b/.test(text)) return "expiry-shaped date";
  return undefined;
}

/** Publish one already-signed Nostr event. `CvmServer.publishEvent` satisfies this. */
export type PublishEvent = (event: Event) => Promise<void>;

/**
 * The real DM sink: NIP-44 gift-wrapped kind 1059 to the recipient, signed with
 * the CVM's own key. The CVM is the actor (ADR-0012 PR #33).
 */
export class NostrDmSink implements DmSink {
  private readonly sk: Uint8Array;
  constructor(
    secretKey: string | Uint8Array,
    private readonly publish: PublishEvent,
  ) {
    this.sk =
      typeof secretKey === "string"
        ? new Uint8Array(secretKey.trim().match(/.{2}/g)!.map((b) => parseInt(b, 16)))
        : secretKey;
  }

  async send(dm: Dm): Promise<{ eventId: string }> {
    assertNoCardMaterial(dm.text);
    const now = Math.floor(Date.now() / 1000);
    const inner = finalizeEvent(
      {
        kind: 14,
        created_at: now,
        tags: [["p", dm.to]],
        content: dm.text,
      },
      this.sk,
    );
    const convKey = nip44.v2.utils.getConversationKey(this.sk, dm.to);
    const content = nip44.v2.encrypt(JSON.stringify(inner), convKey);
    const wrapSk = new Uint8Array(32);
    crypto.getRandomValues(wrapSk);
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: now,
        tags: [["p", dm.to]],
        content,
      } as any,
      wrapSk,
    );
    await this.publish(wrap);
    return { eventId: wrap.id };
  }
}

/** The CVM's own pubkey for a given secret key, so callers can log who spoke. */
export function operatorPubkeyOf(secretKey: string | Uint8Array): string {
  const sk =
    typeof secretKey === "string"
      ? new Uint8Array(secretKey.trim().match(/.{2}/g)!.map((b) => parseInt(b, 16)))
      : secretKey;
  return getPublicKey(sk);
}

function rowToRecord(r: any): EscalationRecord {
  return {
    escalationId: r.escalation_id,
    intentId: r.intent_id,
    kind: r.kind,
    state: r.state,
    operator: r.operator,
    customer: r.customer ?? undefined,
    payload: JSON.parse(r.payload_json),
    replies: r.replies_json ? JSON.parse(r.replies_json) : [],
    windowSeconds: r.window_seconds,
    notifiedAt: r.notified_at ?? undefined,
    alertedAt: r.alerted_at ?? undefined,
    resolvedAt: r.resolved_at ?? undefined,
    resolution: r.resolution ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
