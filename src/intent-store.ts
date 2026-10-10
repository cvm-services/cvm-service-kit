/**
 * Durable payment-intent table for the fiat settlement state machine.
 *
 * Why this exists on top of `ExplicitGate`: the gate (fixed in PR #13) claims
 * exactly once and fails terminally, but it binds NOTHING to the order id. One
 * order id reused with a different caller, tool, amount or order reuses the
 * stored invoice, so a 100-sat invoice can fund a 500-sat fiat attempt. This
 * table binds tool + caller + exact order hash + sats amount + processor/quote
 * + fiat cap, and keeps a durable proof-reuse barrier so one payment can never
 * settle two intents - across restarts.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

/** Everything the intent is bound to. A mismatch on ANY field is a refusal. */
export interface IntentBinding {
  /** Tool the intent was minted for; a different tool may not reuse the id. */
  tool: string;
  /** The caller's pubkey. A different caller may not reuse the id. */
  caller: string;
  /** sha256 of the exact order the sats are paying for. */
  orderHash: string;
  amountSats: number;
  /** Processor identifier ("bitcoin-cashu", "lightning", ...). */
  pmi: string;
  /** The processor's payment request / quote this intent is settled against. */
  quote: string;
  /** Hard ceiling on the fiat the downstream action may spend. */
  fiatCap: number;
  fiatCurrency: string;
}

export type IntentStatus =
  /** Created; the sats are not confirmed yet. */
  | "awaiting_payment"
  /** Sats final + this caller holds the exclusive right to run the action. */
  | "settled_reserved"
  /** The downstream action succeeded. Replay returns the cached result. */
  | "settled"
  /** Terminal: the sats were final and the downstream action failed. */
  | "settlement_failed"
  /** Terminal: the operator confirmed the fiat leg was refunded (ADR-0012 reply). */
  | "refunded";

export interface PaymentIntent extends IntentBinding {
  /** Cryptographically unique (32 random bytes, hex). */
  intentId: string;
  status: IntentStatus;
  /** sha256 of the payment proof that settled it. Never the raw token. */
  proofHash?: string;
  result?: unknown;
  failure?: { message: string; at: number };
  createdAt: number;
  updatedAt: number;
}

/** Result of an atomic reserve (claim) attempt. */
export type ReserveOutcome = "won" | "lost" | "proof_spent" | "missing";

export interface IntentStore {
  get(intentId: string): PaymentIntent | undefined;
  all(): PaymentIntent[];
  /** Insert a new intent. Returns false when the id already exists. */
  create(intent: PaymentIntent): boolean;
  /**
   * Atomically move `intentId` from `from` to `to` AND (when a proof hash is
   * given) consume that proof in the same transaction. Exactly one concurrent
   * caller can win; a proof already owned by a DIFFERENT intent yields
   * "proof_spent" with the claim rolled back.
   */
  reserve(
    intentId: string,
    from: IntentStatus,
    to: IntentStatus,
    proofHash?: string,
  ): ReserveOutcome;
  /** Write a terminal (or post-claim) status + its payload. */
  finish(
    intentId: string,
    status: IntentStatus,
    patch?: { result?: unknown; failure?: { message: string; at: number } },
  ): void;
  /** Which intent (if any) already consumed this proof. */
  proofSpentBy(proofHash: string): string | undefined;
}

/** Same intent id, different binding: wrong caller, cross-tool, changed amount/order. */
export class IntentConflictError extends Error {
  readonly code = -32005;
  constructor(
    readonly intentId: string,
    readonly field: string,
    readonly expected: unknown,
    readonly got: unknown,
  ) {
    super(
      `intent_conflict: ${field} differs (expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)})`,
    );
    this.name = "IntentConflictError";
  }
}

/** This payment proof already settled another intent. */
export class ProofReuseError extends Error {
  readonly code = -32007;
  constructor(readonly proofHash: string, readonly ownerIntentId: string) {
    super(`proof_reuse: proof already settled intent ${ownerIntentId}`);
    this.name = "ProofReuseError";
  }
}

/** The intent reached a state no caller may act on. */
export class IntentTerminalError extends Error {
  readonly code = -32008;
  constructor(readonly intentId: string, readonly status: IntentStatus) {
    super(`intent_${status}`);
    this.name = "IntentTerminalError";
  }
}

/** 32 random bytes as hex. Collision-free by construction, not by convention. */
export function newIntentId(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Canonical order hash: JSON with sorted keys, so two equivalent orders hash
 * equal and a changed order hashes differently. Arrays keep their order.
 */
export function orderHashOf(order: unknown): string {
  return sha256Hex(canonicalJson(order));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The fields that are part of the binding, in one place. */
export const BINDING_FIELDS = [
  "tool",
  "caller",
  "orderHash",
  "amountSats",
  "pmi",
  "quote",
  "fiatCap",
  "fiatCurrency",
] as const;

/**
 * Refuse any re-use of an intent id whose binding differs from the stored one.
 * This is the check that stops "same order id, bigger fiat order" and
 * "same order id, different tool" from riding one payment. `intentId` is only
 * carried into the error (it is the id, NOT the tool).
 */
export function assertBindingMatches(
  stored: IntentBinding,
  requested: IntentBinding,
  intentId = "?",
): void {
  for (const f of BINDING_FIELDS) {
    const a = stored[f];
    const b = requested[f];
    if (a !== b) {
      throw new IntentConflictError(intentId, f, a, b);
    }
  }
}

/** In-memory intent store. Synchronous check-and-set, so it cannot interleave. */
export class MemoryIntentStore implements IntentStore {
  private readonly intents = new Map<string, PaymentIntent>();
  private readonly proofs = new Map<string, string>();

  get(id: string) {
    return this.intents.get(id);
  }
  all() {
    return [...this.intents.values()];
  }
  create(intent: PaymentIntent): boolean {
    if (this.intents.has(intent.intentId)) return false;
    this.intents.set(intent.intentId, { ...intent });
    return true;
  }
  reserve(
    id: string,
    from: IntentStatus,
    to: IntentStatus,
    proofHash?: string,
  ): ReserveOutcome {
    const cur = this.intents.get(id);
    if (!cur) return "missing";
    if (cur.status !== from) return "lost";
    if (proofHash) {
      const owner = this.proofs.get(proofHash);
      if (owner && owner !== id) return "proof_spent";
    }
    this.intents.set(id, { ...cur, status: to, proofHash: proofHash ?? cur.proofHash, updatedAt: Date.now() });
    if (proofHash) this.proofs.set(proofHash, id);
    return "won";
  }
  finish(
    id: string,
    status: IntentStatus,
    patch?: { result?: unknown; failure?: { message: string; at: number } },
  ): void {
    const cur = this.intents.get(id);
    if (!cur) throw new Error(`unknown intent ${id}`);
    this.intents.set(id, {
      ...cur,
      status,
      result: patch?.result ?? cur.result,
      failure: patch?.failure ?? cur.failure,
      updatedAt: Date.now(),
    });
  }
  proofSpentBy(proofHash: string): string | undefined {
    return this.proofs.get(proofHash);
  }
}

/**
 * Durable intent store (SQLite). Every state transition that spends money is a
 * single conditional UPDATE inside an IMMEDIATE transaction, so exactly one
 * caller wins and a crash cannot leave a half-applied claim.
 *
 * `busy_timeout` is set: without it, a burst of simultaneous paid calls threw a
 * raw SQLITE_BUSY out of the gate (a 500, not a clean "lost the claim"). Lock
 * contention now waits, and a timeout still fails CLOSED - the caller throws and
 * the downstream action does not run.
 */
export class SqliteIntentStore implements IntentStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS payment_intents (
        intent_id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        caller TEXT NOT NULL,
        order_hash TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        pmi TEXT NOT NULL,
        quote TEXT NOT NULL,
        fiat_cap REAL NOT NULL,
        fiat_currency TEXT NOT NULL,
        status TEXT NOT NULL,
        proof_hash TEXT,
        result_json TEXT,
        failure_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS spent_proofs (
        proof_hash TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        spent_at INTEGER NOT NULL
      )`);
  }

  get(intentId: string): PaymentIntent | undefined {
    const r = this.db
      .query(`SELECT * FROM payment_intents WHERE intent_id = ?`)
      .get(intentId) as any;
    return r ? rowToIntent(r) : undefined;
  }

  all(): PaymentIntent[] {
    return (this.db.query(`SELECT * FROM payment_intents`).all() as any[]).map(rowToIntent);
  }

  create(intent: PaymentIntent): boolean {
    const res = this.db.run(
      `INSERT OR IGNORE INTO payment_intents
         (intent_id, tool, caller, order_hash, amount_sats, pmi, quote, fiat_cap,
          fiat_currency, status, proof_hash, result_json, failure_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        intent.intentId,
        intent.tool,
        intent.caller,
        intent.orderHash,
        intent.amountSats,
        intent.pmi,
        intent.quote,
        intent.fiatCap,
        intent.fiatCurrency,
        intent.status,
        intent.proofHash ?? null,
        intent.result === undefined ? null : JSON.stringify(intent.result),
        intent.failure ? JSON.stringify(intent.failure) : null,
        intent.createdAt,
        intent.updatedAt,
      ],
    );
    return Number(res.changes ?? 0) === 1;
  }

  reserve(
    intentId: string,
    from: IntentStatus,
    to: IntentStatus,
    proofHash?: string,
  ): ReserveOutcome {
    const now = Date.now();
    this.db.run("BEGIN IMMEDIATE");
    try {
      const res = this.db.run(
        `UPDATE payment_intents
            SET status = ?, proof_hash = COALESCE(?, proof_hash), updated_at = ?
          WHERE intent_id = ? AND status = ?`,
        [to, proofHash ?? null, now, intentId, from],
      );
      if (Number(res.changes ?? 0) !== 1) {
        const exists = this.db
          .query(`SELECT 1 AS x FROM payment_intents WHERE intent_id = ?`)
          .get(intentId) as any;
        this.db.run("ROLLBACK");
        return exists ? "lost" : "missing";
      }
      if (proofHash) {
        const owner = this.db
          .query(`SELECT intent_id FROM spent_proofs WHERE proof_hash = ?`)
          .get(proofHash) as any;
        if (owner && owner.intent_id !== intentId) {
          this.db.run("ROLLBACK");
          return "proof_spent";
        }
        if (!owner) {
          this.db.run(
            `INSERT INTO spent_proofs (proof_hash, intent_id, spent_at) VALUES (?,?,?)`,
            [proofHash, intentId, now],
          );
        }
      }
      this.db.run("COMMIT");
      return "won";
    } catch (err) {
      try {
        this.db.run("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  finish(
    intentId: string,
    status: IntentStatus,
    patch?: { result?: unknown; failure?: { message: string; at: number } },
  ): void {
    const res = this.db.run(
      `UPDATE payment_intents
          SET status = ?,
              result_json = COALESCE(?, result_json),
              failure_json = COALESCE(?, failure_json),
              updated_at = ?
        WHERE intent_id = ?`,
      [
        status,
        patch?.result === undefined ? null : JSON.stringify(patch.result),
        patch?.failure ? JSON.stringify(patch.failure) : null,
        Date.now(),
        intentId,
      ],
    );
    if (Number(res.changes ?? 0) !== 1) throw new Error(`unknown intent ${intentId}`);
  }

  proofSpentBy(proofHash: string): string | undefined {
    const r = this.db
      .query(`SELECT intent_id FROM spent_proofs WHERE proof_hash = ?`)
      .get(proofHash) as any;
    return r?.intent_id;
  }

  /** Release the handle so a test runner can exit. */
  close(): void {
    this.db.close();
  }
}

function rowToIntent(r: any): PaymentIntent {
  return {
    intentId: r.intent_id,
    tool: r.tool,
    caller: r.caller,
    orderHash: r.order_hash,
    amountSats: r.amount_sats,
    pmi: r.pmi,
    quote: r.quote,
    fiatCap: r.fiat_cap,
    fiatCurrency: r.fiat_currency,
    status: r.status,
    proofHash: r.proof_hash ?? undefined,
    result: r.result_json ? JSON.parse(r.result_json) : undefined,
    failure: r.failure_json ? JSON.parse(r.failure_json) : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
