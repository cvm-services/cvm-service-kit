import { Database } from "bun:sqlite";

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "fulfilling"
  | "fulfilled"
  | "failed"
  | "refund_pending"
  | "refunded";

export interface Order {
  orderId: string;
  service: string;
  tool: string;
  caller: string;
  costSats: number | null;
  priceSats: number;
  status: OrderStatus;
  /** Opaque upstream reference (e.g. the upstream order id / swap id). */
  upstreamRef: string | null;
  /** Cached tool result so a replayed accepted payment never re-runs. */
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OrderStore {
  get(orderId: string): Order | null;
  /** Insert if absent; return the existing row otherwise (idempotent create). */
  createOrGet(order: Omit<Order, "createdAt" | "updatedAt">): Order;
  update(orderId: string, patch: Partial<Order>): void;
}

function rowToOrder(row: any): Order {
  return {
    orderId: row.order_id,
    service: row.service,
    tool: row.tool,
    caller: row.caller,
    costSats: row.cost_sats,
    priceSats: row.price_sats,
    status: row.status,
    upstreamRef: row.upstream_ref,
    resultJson: row.result_json,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Durable order store backed by SQLite (survives restarts). */
export class SqliteOrderStore implements OrderStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        tool TEXT NOT NULL,
        caller TEXT NOT NULL,
        cost_sats INTEGER,
        price_sats INTEGER NOT NULL,
        status TEXT NOT NULL,
        upstream_ref TEXT,
        result_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
  }

  get(orderId: string): Order | null {
    const row = this.db.query(`SELECT * FROM orders WHERE order_id = ?`).get(orderId);
    return row ? rowToOrder(row) : null;
  }

  createOrGet(order: Omit<Order, "createdAt" | "updatedAt">): Order {
    const existing = this.get(order.orderId);
    if (existing) return existing;
    const now = Date.now();
    this.db.run(
      `INSERT INTO orders (order_id, service, tool, caller, cost_sats, price_sats,
                           status, upstream_ref, result_json, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.orderId,
        order.service,
        order.tool,
        order.caller,
        order.costSats,
        order.priceSats,
        order.status,
        order.upstreamRef,
        order.resultJson,
        order.error,
        now,
        now,
      ],
    );
    return this.get(order.orderId)!;
  }

  update(orderId: string, patch: Partial<Order>): void {
    const cur = this.get(orderId);
    if (!cur) throw new Error(`unknown order ${orderId}`);
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.db.run(
      `UPDATE orders SET cost_sats=?, price_sats=?, status=?, upstream_ref=?,
                         result_json=?, error=?, updated_at=? WHERE order_id=?`,
      [
        next.costSats,
        next.priceSats,
        next.status,
        next.upstreamRef,
        next.resultJson,
        next.error,
        next.updatedAt,
        orderId,
      ],
    );
  }
}
