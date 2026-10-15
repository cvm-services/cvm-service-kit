import { Database } from "bun:sqlite";
import {
  TERMINAL_STATUSES,
  type GateOrder,
  type GateOrderStatus,
  type GateOrderStore,
} from "./payment.ts";

/**
 * Operator bookkeeping for a terminal failure the gate (correctly) refuses to
 * re-run: the sats were taken and the action failed, and an operator has since
 * compensated the customer. This is an AUDIT RECORD, not a status change - see
 * `src/gate-recovery.ts` for why the order status is deliberately left alone.
 */
export interface GateResolution {
  orderId: string;
  outcome: string;
  note: string;
  at: number;
}

/**
 * The `IN (...)` list for the new-generation `CASE` below, derived from the ONE
 * terminal-status list in `payment.ts` so the two bundled stores cannot drift.
 * Hardcoded string literals (not caller input), so interpolating them is safe.
 */
// `NULL` when the list is empty: `IN ()` is a SQL syntax error, and an empty
// terminal list must degrade to "matches nothing", not break every `put`.
// (Review finding M6, round 6.)
const TERMINAL_STATUS_SQL = TERMINAL_STATUSES.length
  ? TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ")
  : "NULL";

/**
 * The new-generation predicate: a write that moves a TERMINAL row back to
 * `awaiting_payment` is a NEW order on a reused orderId, so the previous
 * generation's identity (invoice, amount, tool, caller) and its compensation must
 * not be inherited. (Review findings H3/H4, round 6.)
 */
const IS_NEW_GENERATION = `excluded.status = 'awaiting_payment' AND gate_orders.status IN (${TERMINAL_STATUS_SQL})`;

/**
 * Durable implementation of the payment gate's order store. Without this, a
 * control-plane restart forgets paid orders and could re-run (or re-charge) a
 * replayed call.
 */
export class SqliteGateStore implements GateOrderStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    // Measured (2026-10-09): with no busy timeout, three simultaneous `claim()`
    // callers gave one winner and TWO raw `SQLITE_BUSY` throws. `claim` runs after
    // `verify()` has accepted a real payment, so that escapes as an opaque 500 for
    // a paid call - and the same throw from the terminal `put()` would leave the
    // row stuck at `settlement_reserved` forever. With a busy timeout, contention
    // becomes an ordinary lost CAS (or a slightly slower winner) instead.
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS gate_orders (
        order_id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        caller TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        invoice_json TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        failure_json TEXT,
        proof_hash TEXT,
        rev INTEGER NOT NULL DEFAULT 0,
        compensated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    // `failure_json` (the recorded reason a settlement failed terminally) was added
    // after this table shipped. `CREATE TABLE IF NOT EXISTS` is a no-op on an
    // existing deployed file, so migrate explicitly - otherwise every pre-existing
    // deployment keeps the column-less schema and loses the failure reason on the
    // very restart the reason exists to survive.
    const columns = this.db.query(`PRAGMA table_info(gate_orders)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "failure_json")) {
      this.db.run(`ALTER TABLE gate_orders ADD COLUMN failure_json TEXT`);
    }
    // `proof_hash` (the digest of the proof that settled the order, so a replay
    // can be bound to it) has the same migration trap as `failure_json`.
    if (!columns.some((c) => c.name === "proof_hash")) {
      this.db.run(`ALTER TABLE gate_orders ADD COLUMN proof_hash TEXT`);
    }
    // `rev`: the monotonic per-row revision an operator CAS compares against.
    // `updated_at` is wall-clock milliseconds and two transitions inside one
    // millisecond collide, so it cannot serve as a version by itself.
    // (Review finding M1, round 5.)
    if (!columns.some((c) => c.name === "rev")) {
      this.db.run(`ALTER TABLE gate_orders ADD COLUMN rev INTEGER NOT NULL DEFAULT 0`);
    }
    // `compensated`: whether an operator has resolved the money for this order
    // GENERATION. It lives on the order row (not only in the log) so that
    // `releaseReservation` can check it in the same CAS that moves the row, and so
    // that a reused orderId starts a new generation un-compensated. Without this
    // the compensated check was a separate read and a concurrent compensation
    // slipped through it. (Review findings C1/H4/M5, round 6.)
    if (!columns.some((c) => c.name === "compensated")) {
      this.db.run(`ALTER TABLE gate_orders ADD COLUMN compensated INTEGER NOT NULL DEFAULT 0`);
    }
    // Recovery records are an APPEND-ONLY log: every compensation is kept, so the
    // trail can show a refund followed by a correction (review finding B5). The
    // table was introduced by this same branch with `order_id` as PRIMARY KEY and
    // an upsert on write; that shape silently overwrote history, so it is
    // migrated in place below.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS gate_recovery (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        note TEXT NOT NULL,
        at INTEGER NOT NULL
      )`);
    // `PRAGMA table_info` on a real SQLite file: migrate a pre-append-only table
    // (an earlier build of this branch) by rebuilding it and carrying the rows.
    const cols = this.db.query(`PRAGMA table_info(gate_recovery)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "seq")) {
      this.db.run(`ALTER TABLE gate_recovery RENAME TO gate_recovery_legacy`);
      this.db.run(`
        CREATE TABLE gate_recovery (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id TEXT NOT NULL,
          outcome TEXT NOT NULL,
          note TEXT NOT NULL,
          at INTEGER NOT NULL
        )`);
      this.db.run(`
        INSERT INTO gate_recovery (order_id, outcome, note, at)
        SELECT order_id, outcome, note, at FROM gate_recovery_legacy ORDER BY at ASC`);
      this.db.run(`DROP TABLE gate_recovery_legacy`);
    }
  }

  private static rowToOrder(row: any): GateOrder {
    return {
      orderId: row.order_id,
      tool: row.tool,
      caller: row.caller,
      amountSats: row.amount_sats,
      invoice: JSON.parse(row.invoice_json),
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      failure: row.failure_json ? JSON.parse(row.failure_json) : undefined,
      proofHash: row.proof_hash ?? undefined,
      rev: row.rev ?? undefined,
      compensated: row.compensated === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(orderId: string): GateOrder | undefined {
    const row = this.db.query(`SELECT * FROM gate_orders WHERE order_id = ?`).get(orderId) as any;
    if (!row) return undefined;
    return SqliteGateStore.rowToOrder(row);
  }

  /**
   * Every order in one of `statuses` (all orders when omitted), oldest first.
   *
   * An explicitly EMPTY array is not "omitted": it matches nothing. Treating `[]`
   * as "no filter" made `list([])` return the whole table, contradicting the
   * documented contract and turning any caller whose status set happened to come
   * out empty into a full-table scan.
   *
   * Deliberately NOT part of the `GateOrderStore` interface: the gate itself only
   * ever needs point reads, and widening the shared primitive is what the PR #13
   * audit was about. Enumeration is an operator/recovery need that only makes
   * sense over a durable store, so it lives on the concrete implementation.
   */
  list(statuses?: GateOrderStatus | GateOrderStatus[]): GateOrder[] {
    if (statuses !== undefined) {
      const want = Array.isArray(statuses) ? statuses : [statuses];
      if (want.length === 0) return [];
      const rows = this.db
        .query(
          `SELECT * FROM gate_orders WHERE status IN (${want.map(() => "?").join(",")})
           ORDER BY updated_at ASC`,
        )
        .all(...want);
      return (rows as any[]).map(SqliteGateStore.rowToOrder);
    }
    const rows = this.db.query(`SELECT * FROM gate_orders ORDER BY updated_at ASC`).all();
    return (rows as any[]).map(SqliteGateStore.rowToOrder);
  }

  /**
   * Compare-and-set on the order status. A single conditional UPDATE is atomic
   * in SQLite, so exactly one concurrent caller can move awaiting_payment ->
   * settlement_reserved and thus exactly one may run the downstream action.
   *
   * Deliberately NOT wrapped in an explicit transaction: the comparison and the
   * write are one statement, so a BEGIN/COMMIT pair would add no atomicity and
   * would add a second place that can fail on a locked database.
   */
  claim(
    orderId: string,
    from: GateOrder["status"],
    to: GateOrder["status"],
    proofHash?: string,
  ): boolean {
    // COALESCE, not an assignment: a claim that carries no evidence (a status
    // transition on an already-bound row) must not ERASE the recorded binding.
    // `rev = rev + 1` on every transition, so a CAS on `rev` can never match a row
    // that moved away and came back inside the same millisecond.
    const res = this.db.run(
      `UPDATE gate_orders SET status = ?, updated_at = ?, rev = rev + 1,
                             proof_hash = COALESCE(?, proof_hash)
       WHERE order_id = ? AND status = ? AND compensated = 0`,
      [to, Date.now(), proofHash ?? null, orderId, from],
    );
    return Number(res.changes ?? 0) === 1;
  }

  /**
   * Release a reservation ONLY if the row is still exactly the revision the
   * operator inspected: `settlement_reserved` AND the same `updated_at`.
   *
   * The status-only CAS the gate uses for its own transitions is NOT enough here.
   * An operator reads the row, sees an expired lease, and then CASes some time
   * later; in between, another operator may release the row and a retry caller may
   * re-claim it, putting it back to `settlement_reserved` — a status the
   * status-only CAS matches. The release would then cancel a LIVE claim without
   * `--force`, and a second caller could start the same action. `updated_at` is
   * set by every transition, so requiring it makes a stale read lose (as `raced`)
   * instead of stealing the new owner's lease. (Review finding B1, round 4.)
   */
  releaseIfUnchanged(orderId: string, expectedRev: number): boolean {
    const res = this.db.run(
      `UPDATE gate_orders SET status = 'awaiting_payment', updated_at = ?, rev = rev + 1
       WHERE order_id = ? AND status = 'settlement_reserved' AND rev = ? AND compensated = 0`,
      [Date.now(), orderId, expectedRev],
    );
    return Number(res.changes ?? 0) === 1;
  }

  /**
   * Append an operator compensation to the audit log, but ONLY while the order row
   * is still the revision the operator judged: a single conditional INSERT whose
   * SELECT is gated on `(order_id, status, rev)`. It returns false when the row
   * moved in between (a caller settled it, or another operator released it), so a
   * compensation can never be recorded against an order that has since succeeded.
   * (Review finding H2, round 5.)
   *
   * Deliberately an INSERT, not an upsert: a second compensation (a correction, or
   * a refund following an abandonment) must ADD to the history rather than erase
   * the first entry. Readers that want "the current state" take the LAST record.
   */
  putResolution(resolution: GateResolution, expect: { status: GateOrderStatus; rev: number }): boolean {
    // The order row FIRST, as the guarded CAS: `compensated = 1` AND `rev + 1` in
    // the same statement. Advancing `rev` here is what makes the compensation part
    // of the order's VERSION, so a release CAS taken before the compensation loses
    // instead of slipping through the gap between a separate compensated-check and
    // the release. (Review findings C1/M5, round 6.)
    const claimed = this.db.run(
      `UPDATE gate_orders SET compensated = 1, rev = rev + 1
       WHERE order_id = ? AND status = ? AND rev = ?`,
      [resolution.orderId, expect.status, expect.rev],
    );
    if (Number(claimed.changes ?? 0) !== 1) return false;
    // Then the audit row. Deliberately two statements, not a transaction: the
    // guarded UPDATE above is the mutual exclusion, and if the process dies
    // between them the row is left `compensated` with a missing note - fail-SAFE
    // (releases stay blocked), and the operator sees `compensated` with no note
    // and appends one. The reverse order would allow a note with no block.
    this.db.run(
      `INSERT INTO gate_recovery (order_id, outcome, note, at) VALUES (?, ?, ?, ?)`,
      [resolution.orderId, resolution.outcome, resolution.note, resolution.at],
    );
    return true;
  }

  /**
   * The full compensation history, oldest first. Append-only: nothing is lost.
   * Ordered by INSERTION (`seq`), not by `at`: the "current" record for an order
   * must be the one written last, and a clock skew or an explicit `now` on a later
   * correction must not resurrect an earlier entry. (Review finding, round 4.)
   */
  listResolutions(): GateResolution[] {
    const rows = this.db
      .query(`SELECT * FROM gate_recovery ORDER BY seq ASC`)
      .all() as any[];
    return rows.map((r) => ({
      orderId: r.order_id,
      outcome: r.outcome,
      note: r.note,
      at: r.at,
    }));
  }

  /** Release the SQLite handle, so a test runner can exit. */
  close(): void {
    this.db.close();
  }

  put(order: GateOrder): void {
    const res = this.db.run(
      `INSERT INTO gate_orders (order_id, tool, caller, amount_sats, invoice_json,
                                status, result_json, failure_json, proof_hash,
                                created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         status=excluded.status, result_json=excluded.result_json,
         failure_json=excluded.failure_json,
         -- COALESCE: a write that omits the digest must never clear the binding
         -- a claim recorded (only a fresh claim sets one).
         --
         -- EXCEPT in a NEW GENERATION: a write that moves a TERMINAL row back to
         -- awaiting_payment is a new order on a reused orderId, so the previous
         -- generation's binding, IDENTITY (tool/caller/amount/invoice/created_at)
         -- and COMPENSATION must not be inherited. Inheriting the identity would
         -- verify the new payment against the old invoice and amount (review
         -- findings H3/H4, round 6); inheriting the compensation would leave a
         -- fresh order permanently un-releasable.
         -- DENY-LIST HAZARD: a terminal status missing from this list fails
         -- toward the old bug (R2-3). The list is INTERPOLATED from
         -- TERMINAL_STATUSES in payment.ts, so the memory store and this store
         -- cannot disagree; replay_binding.test.ts pins both directions of that
         -- constant (an entry deleted, and an entry added without being mirrored).
         tool=CASE WHEN ${IS_NEW_GENERATION} THEN excluded.tool ELSE gate_orders.tool END,
         caller=CASE WHEN ${IS_NEW_GENERATION} THEN excluded.caller ELSE gate_orders.caller END,
         amount_sats=CASE WHEN ${IS_NEW_GENERATION} THEN excluded.amount_sats ELSE gate_orders.amount_sats END,
         invoice_json=CASE WHEN ${IS_NEW_GENERATION} THEN excluded.invoice_json ELSE gate_orders.invoice_json END,
         created_at=CASE WHEN ${IS_NEW_GENERATION} THEN excluded.created_at ELSE gate_orders.created_at END,
         compensated=CASE WHEN ${IS_NEW_GENERATION} THEN 0 ELSE gate_orders.compensated END,
         proof_hash=CASE
           WHEN ${IS_NEW_GENERATION} THEN excluded.proof_hash
           ELSE COALESCE(excluded.proof_hash, gate_orders.proof_hash)
         END,
         rev=gate_orders.rev + 1,
         -- Monotonic: updated_at is the operator's lease-age hint, and the age
         -- must never run backwards. (Review finding L8, round 6.)
         updated_at=MAX(excluded.updated_at, gate_orders.updated_at)
       -- A compensated order can never be recorded as SETTLED: the operator has
       -- already resolved the money (usually a refund), so accepting the success
       -- write would hand the customer both. The guard is IN the statement, so it
       -- cannot race the way a separate read would. (Review finding C2, round 6.)
       WHERE gate_orders.compensated = 0 OR excluded.status <> 'settled'`,
      [
        order.orderId,
        order.tool,
        order.caller,
        order.amountSats,
        JSON.stringify(order.invoice),
        order.status,
        order.result === undefined ? null : JSON.stringify(order.result),
        order.failure === undefined ? null : JSON.stringify(order.failure),
        order.proofHash ?? null,
        order.createdAt,
        order.updatedAt,
      ],
    );
    // changes === 0 on the UPDATE branch means the guard above refused it. Report
    // that as an error rather than silently dropping a settlement: the action DID
    // run, and the operator must reconcile by hand.
    if (order.status === "settled" && Number(res.changes ?? 0) !== 1) {
      throw new Error(
        `order ${order.orderId} was compensated by an operator; refusing to record it as settled`,
      );
    }
  }
}
