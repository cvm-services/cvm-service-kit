import { Database } from "bun:sqlite";
import type { GateOrder, GateOrderStatus, GateOrderStore } from "./payment.ts";

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
    // Recovery records are a NEW table, so `IF NOT EXISTS` is a real create here -
    // no ALTER migration is needed for it.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS gate_recovery (
        order_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL,
        note TEXT NOT NULL,
        at INTEGER NOT NULL
      )`);
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
   * Deliberately NOT part of the `GateOrderStore` interface: the gate itself only
   * ever needs point reads, and widening the shared primitive is what the PR #13
   * audit was about. Enumeration is an operator/recovery need that only makes
   * sense over a durable store, so it lives on the concrete implementation.
   */
  list(statuses?: GateOrderStatus | GateOrderStatus[]): GateOrder[] {
    const want = statuses === undefined ? [] : Array.isArray(statuses) ? statuses : [statuses];
    const rows =
      want.length === 0
        ? this.db.query(`SELECT * FROM gate_orders ORDER BY updated_at ASC`).all()
        : this.db
            .query(
              `SELECT * FROM gate_orders WHERE status IN (${want.map(() => "?").join(",")})
               ORDER BY updated_at ASC`,
            )
            .all(...want);
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
  claim(orderId: string, from: GateOrder["status"], to: GateOrder["status"]): boolean {
    const res = this.db.run(
      `UPDATE gate_orders SET status = ?, updated_at = ? WHERE order_id = ? AND status = ?`,
      [to, Date.now(), orderId, from],
    );
    return Number(res.changes ?? 0) === 1;
  }

  /** Record an operator compensation for a terminal failure (audit trail). */
  putResolution(resolution: GateResolution): void {
    this.db.run(
      `INSERT INTO gate_recovery (order_id, outcome, note, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         outcome=excluded.outcome, note=excluded.note, at=excluded.at`,
      [resolution.orderId, resolution.outcome, resolution.note, resolution.at],
    );
  }

  listResolutions(): GateResolution[] {
    const rows = this.db.query(`SELECT * FROM gate_recovery ORDER BY at ASC`).all() as any[];
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
  /**
   * Insert-if-absent. `ON CONFLICT DO NOTHING` makes creation atomic across
   * processes: when two control-plane workers both read "no such order" and both
   * try to create it, exactly one INSERT lands and the other is a no-op - it must
   * never overwrite a row its peer has already advanced to a terminal status.
   * The caller continues from the row that is actually there, which is why the
   * read-back below is part of the contract and not a convenience.
   */
  create(order: GateOrder): GateOrder {
    this.db.run(
      `INSERT INTO gate_orders (order_id, tool, caller, amount_sats, invoice_json,
                                status, result_json, failure_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO NOTHING`,
      [
        order.orderId,
        order.tool,
        order.caller,
        order.amountSats,
        JSON.stringify(order.invoice),
        order.status,
        order.result === undefined ? null : JSON.stringify(order.result),
        order.failure === undefined ? null : JSON.stringify(order.failure),
        order.createdAt,
        order.updatedAt,
      ],
    );
    const surviving = this.get(order.orderId);
    if (surviving === undefined) {
      // Unreachable while nothing deletes gate rows, but returning `order` here
      // would be exactly the resurrection this method exists to prevent - the
      // caller would continue from the row it tried to write. Fail loudly.
      throw new Error(
        `gate order ${order.orderId} disappeared between INSERT and read-back: refusing to continue from the caller's own row`,
      );
    }
    return surviving;
  }

  put(order: GateOrder): void {
    this.db.run(
      `INSERT INTO gate_orders (order_id, tool, caller, amount_sats, invoice_json,
                                status, result_json, failure_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         status=excluded.status, result_json=excluded.result_json,
         failure_json=excluded.failure_json,
         updated_at=excluded.updated_at`,
      [
        order.orderId,
        order.tool,
        order.caller,
        order.amountSats,
        JSON.stringify(order.invoice),
        order.status,
        order.result === undefined ? null : JSON.stringify(order.result),
        order.failure === undefined ? null : JSON.stringify(order.failure),
        order.createdAt,
        order.updatedAt,
      ],
    );
  }
}
