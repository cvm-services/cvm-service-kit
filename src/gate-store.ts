import { Database } from "bun:sqlite";
import type { GateOrder, GateOrderStore } from "./payment.ts";

/**
 * Durable implementation of the payment gate's order store. Without this, a
 * control-plane restart forgets paid orders and could re-run (or re-charge) a
 * replayed call.
 */
export class SqliteGateStore implements GateOrderStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS gate_orders (
        order_id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        caller TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        invoice_json TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
  }

  get(orderId: string): GateOrder | undefined {
    const row = this.db.query(`SELECT * FROM gate_orders WHERE order_id = ?`).get(orderId) as any;
    if (!row) return undefined;
    return {
      orderId: row.order_id,
      tool: row.tool,
      caller: row.caller,
      amountSats: row.amount_sats,
      invoice: JSON.parse(row.invoice_json),
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Compare-and-set on the order status. A single conditional UPDATE is atomic
   * in SQLite, so exactly one concurrent caller can move awaiting_payment ->
   * settlement_reserved and thus exactly one may run the downstream action.
   */
  claim(orderId: string, from: GateOrder["status"], to: GateOrder["status"]): boolean {
    const res = this.db.run(
      `UPDATE gate_orders SET status = ?, updated_at = ? WHERE order_id = ? AND status = ?`,
      [to, Date.now(), orderId, from],
    );
    return Number(res.changes ?? 0) === 1;
  }

  /** Release the SQLite handle, so a test runner can exit. */
  close(): void {
    this.db.close();
  }

  put(order: GateOrder): void {
    this.db.run(
      `INSERT INTO gate_orders (order_id, tool, caller, amount_sats, invoice_json,
                                status, result_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         status=excluded.status, result_json=excluded.result_json,
         updated_at=excluded.updated_at`,
      [
        order.orderId,
        order.tool,
        order.caller,
        order.amountSats,
        JSON.stringify(order.invoice),
        order.status,
        order.result === undefined ? null : JSON.stringify(order.result),
        order.createdAt,
        order.updatedAt,
      ],
    );
  }
}
