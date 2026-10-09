/**
 * fiat-store.ts — durable implementation of the fiat intent store.
 *
 * Same reasoning as gate-store.ts: an intent held only in memory is forgotten by
 * a restart, and a forgotten fiat attempt is a second fiat attempt. The claim is
 * a single conditional UPDATE, which SQLite executes atomically, so exactly one
 * caller can move a status and thus exactly one can enter the adapter.
 */
import { Database } from "bun:sqlite";
import type { FiatIntent, FiatIntentStatus, FiatIntentStore } from "./fiat-intent.ts";

export class SqliteFiatIntentStore implements FiatIntentStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS fiat_intents (
        intent_id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        caller TEXT NOT NULL,
        order_hash TEXT NOT NULL,
        rail TEXT NOT NULL,
        sats_amount INTEGER NOT NULL,
        sats_proof TEXT NOT NULL,
        fiat_cap TEXT NOT NULL,
        checkout_url TEXT NOT NULL,
        status TEXT NOT NULL,
        fiat_attempts INTEGER NOT NULL DEFAULT 0,
        adapter_result_json TEXT,
        failure_json TEXT,
        escalated_at INTEGER,
        escalation_ref TEXT,
        alert_at INTEGER,
        resolution_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
  }

  get(intentId: string): FiatIntent | undefined {
    const row = this.db
      .query(`SELECT * FROM fiat_intents WHERE intent_id = ?`)
      .get(intentId) as Record<string, unknown> | undefined;
    return row ? rowToIntent(row) : undefined;
  }

  list(): FiatIntent[] {
    const rows = this.db.query(`SELECT * FROM fiat_intents`).all() as Record<string, unknown>[];
    return rows.map(rowToIntent);
  }

  /**
   * Compare-and-set. `fiat_attempts` is incremented in the SAME statement that
   * moves the status into `fiat_in_flight`, so the attempt count can never be
   * bumped by a caller that did not win the transition.
   */
  claim(intentId: string, from: FiatIntentStatus, to: FiatIntentStatus): boolean {
    const bump = to === "fiat_in_flight" ? 1 : 0;
    const res = this.db.run(
      `UPDATE fiat_intents
          SET status = ?, updated_at = ?, fiat_attempts = fiat_attempts + ?
        WHERE intent_id = ? AND status = ?`,
      [to, Date.now(), bump, intentId, from],
    );
    return Number(res.changes ?? 0) === 1;
  }

  put(intent: FiatIntent): void {
    this.db.run(
      `INSERT INTO fiat_intents (intent_id, tool, caller, order_hash, rail, sats_amount,
                                 sats_proof, fiat_cap, checkout_url, status, fiat_attempts,
                                 adapter_result_json, failure_json, escalated_at, escalation_ref,
                                 alert_at, resolution_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(intent_id) DO UPDATE SET
         status=excluded.status,
         fiat_attempts=excluded.fiat_attempts,
         adapter_result_json=excluded.adapter_result_json,
         failure_json=excluded.failure_json,
         escalated_at=excluded.escalated_at,
         escalation_ref=excluded.escalation_ref,
         alert_at=excluded.alert_at,
         resolution_json=excluded.resolution_json,
         updated_at=excluded.updated_at`,
      [
        intent.intentId,
        intent.tool,
        intent.caller,
        intent.orderHash,
        intent.rail,
        intent.satsAmount,
        intent.satsProof,
        intent.fiatCap,
        intent.checkoutUrl,
        intent.status,
        intent.fiatAttempts,
        intent.adapterResult ? JSON.stringify(intent.adapterResult) : null,
        intent.failure ? JSON.stringify(intent.failure) : null,
        intent.escalatedAt ?? null,
        intent.escalationRef ?? null,
        intent.alertAt ?? null,
        intent.resolution ? JSON.stringify(intent.resolution) : null,
        intent.createdAt,
        intent.updatedAt,
      ],
    );
  }

  /** Release the handle so a test runner can exit. */
  close(): void {
    this.db.close();
  }
}

function rowToIntent(row: Record<string, unknown>): FiatIntent {
  const j = <T>(v: unknown): T | undefined =>
    typeof v === "string" && v.length > 0 ? (JSON.parse(v) as T) : undefined;
  return {
    intentId: String(row.intent_id),
    tool: String(row.tool),
    caller: String(row.caller),
    orderHash: String(row.order_hash),
    rail: String(row.rail),
    satsAmount: Number(row.sats_amount),
    satsProof: String(row.sats_proof),
    fiatCap: String(row.fiat_cap),
    checkoutUrl: String(row.checkout_url),
    status: String(row.status) as FiatIntent["status"],
    fiatAttempts: Number(row.fiat_attempts),
    adapterResult: j<FiatIntent["adapterResult"]>(row.adapter_result_json),
    failure: j<FiatIntent["failure"]>(row.failure_json),
    escalatedAt: row.escalated_at == null ? undefined : Number(row.escalated_at),
    escalationRef: row.escalation_ref == null ? undefined : String(row.escalation_ref),
    alertAt: row.alert_at == null ? undefined : Number(row.alert_at),
    resolution: j<FiatIntent["resolution"]>(row.resolution_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
