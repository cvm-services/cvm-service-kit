/** CEP-8 payment surface: `cap` prices, `pmi`, explicit gating and idempotency. */

export interface Cap {
  /** e.g. "tool:run_code" */
  scope: string;
  amount: number;
  unit: string;
}

export interface Invoice {
  orderId: string;
  paymentHash: string;
  amountSats: number;
  /** Encoded payment request (BOLT11 string or cashuB token request). */
  request: string;
  pmi: string;
}

export interface PaymentProcessor {
  readonly pmi: string;
  createInvoice(args: {
    tool: string;
    orderId: string;
    amountSats: number;
    caller: string;
  }): Promise<Invoice>;
  /**
   * Return true once the invoice is settled. `proof` is an optional
   * client-supplied payment proof (e.g. a Cashu token); Lightning processors
   * ignore it and poll, Cashu processors redeem it.
   */
  verify(invoice: Invoice, proof?: string): Promise<boolean>;
}

/** Thrown by a tool handler when an unpaid call must be refused (CEP-8 explicit_gating). */
export class PaymentRequiredError extends Error {
  readonly code = -32002;
  constructor(
    message: string,
    readonly data: {
      orderId: string;
      invoice: string;
      amountSats: number;
      paymentHash: string;
      pmi: string;
    },
  ) {
    super(message);
    this.name = "PaymentRequiredError";
  }
}

/** The payment settled, but another caller already holds the settlement claim. */
export class SettlementInProgressError extends Error {
  readonly code = -32003;
  constructor(readonly orderId: string) {
    super("settlement_in_progress");
    this.name = "SettlementInProgressError";
  }
}

/**
 * Terminal settlement failure. The sats were taken and the downstream action
 * failed (or its outcome is unknown). Retrying would spend the same payment
 * twice, so a retry re-throws this instead of re-running the action.
 */
export class SettlementFailedError extends Error {
  readonly code = -32004;
  constructor(readonly orderId: string, readonly detail: string) {
    super(`settlement_failed: ${detail}`);
    this.name = "SettlementFailedError";
  }
}

export function parseCapTags(tags: string[][]): Cap[] {
  const caps: Cap[] = [];
  for (const t of tags) {
    if (t[0] === "cap" && t.length >= 4) {
      caps.push({ scope: t[1], amount: Number(t[2]), unit: t[3] });
    }
  }
  return caps;
}

export type GateOrderStatus =
  | "awaiting_payment"
  /** Reserved: a caller holds the exclusive right to run the downstream action. */
  | "settlement_reserved"
  /** Terminal: the action failed after payment. Never retryable. */
  | "settlement_failed"
  /** Legacy (pre-2026-10-09): set BEFORE the action ran, so the outcome is unverifiable. */
  | "paid"
  | "settled"
  | "refused";

export interface GateOrder {
  orderId: string;
  tool: string;
  caller: string;
  amountSats: number;
  invoice: Invoice;
  status: GateOrderStatus;
  /** Cached tool result, so a replayed payment_accepted never runs twice. */
  result?: unknown;
  /** Why a settlement failed. Recorded so a retry can be refused without re-running. */
  failure?: { message: string; at: number };
  createdAt: number;
  updatedAt: number;
}

export interface GateOrderStore {
  get(orderId: string): GateOrder | undefined;
  put(order: GateOrder): void;
  /**
   * Atomically move `orderId` from `from` to `to`, returning true only for the
   * caller that performed the transition. Exactly one concurrent caller can win,
   * which is what stops two fiat attempts against a single sats payment.
   */
  claim(orderId: string, from: GateOrderStatus, to: GateOrderStatus): boolean;
}

export class MemoryOrderStore implements GateOrderStore {
  private readonly m = new Map<string, GateOrder>();
  get(id: string) { return this.m.get(id); }
  put(o: GateOrder) { this.m.set(o.orderId, o); }
  // Synchronous and without an await: the check-and-set cannot interleave.
  claim(id: string, from: GateOrderStatus, to: GateOrderStatus): boolean {
    const cur = this.m.get(id);
    if (!cur || cur.status !== from) return false;
    this.m.set(id, { ...cur, status: to, updatedAt: Date.now() });
    return true;
  }
}

/**
 * Explicit-gating helper. A tool handler calls `gate()` before doing work: it
 * mints (or reuses) an order, and either returns the cached result (idempotent
 * replay) or throws PaymentRequiredError until the invoice is paid.
 */
export class ExplicitGate {
  constructor(
    private readonly processor: PaymentProcessor,
    private readonly store: GateOrderStore = new MemoryOrderStore(),
  ) {}

  async gate<T>(args: {
    tool: string;
    caller: string;
    amountSats: number;
    orderId: string;
    /** Client-supplied payment proof (e.g. a Cashu token). */
    proof?: string;
    run: () => Promise<T>;
  }): Promise<T> {
    let order = this.store.get(args.orderId);

    if (!order) {
      const invoice = await this.processor.createInvoice({
        tool: args.tool,
        orderId: args.orderId,
        amountSats: args.amountSats,
        caller: args.caller,
      });
      order = {
        orderId: args.orderId,
        tool: args.tool,
        caller: args.caller,
        amountSats: args.amountSats,
        invoice,
        status: "awaiting_payment",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.store.put(order);
    }

    if (order.status === "settled") {
      // Replay: return the cached result, never re-run the tool.
      return order.result as T;
    }

    // A terminal failure stays terminal. The sats were taken and the downstream
    // action failed; re-running it would spend the same payment twice.
    if (order.status === "settlement_failed") {
      throw new SettlementFailedError(order.orderId, order.failure?.message ?? "unknown");
    }

    // Rows written by the pre-fix code ("paid" was persisted BEFORE the action
    // ran) have an unverifiable outcome. Never re-run them; escalate instead.
    if (order.status === "paid") {
      throw new SettlementFailedError(order.orderId, "legacy paid row: settlement outcome unknown");
    }

    // Another caller already holds the settlement claim for this payment.
    if (order.status === "settlement_reserved") {
      throw new SettlementInProgressError(order.orderId);
    }

    if (order.status === "awaiting_payment") {
      const paid = await this.processor.verify(order.invoice, args.proof);
      if (!paid) {
        throw new PaymentRequiredError("payment_required", {
          orderId: order.orderId,
          invoice: order.invoice.request,
          amountSats: order.amountSats,
          paymentHash: order.invoice.paymentHash,
          pmi: order.invoice.pmi,
        });
      }
      // Claim the right to settle exactly once. The loser must NOT run the action:
      // that is how one sats payment became two fiat attempts before this fix.
      const won = this.store.claim(order.orderId, "awaiting_payment", "settlement_reserved");
      if (!won) throw new SettlementInProgressError(order.orderId);
    }

    try {
      const result = await args.run();
      const done = this.store.get(order.orderId) ?? order;
      done.status = "settled";
      done.result = result;
      done.updatedAt = Date.now();
      this.store.put(done);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed = this.store.get(order.orderId) ?? order;
      failed.status = "settlement_failed";
      failed.failure = { message, at: Date.now() };
      failed.updatedAt = Date.now();
      this.store.put(failed);
      throw err;
    }
  }
}
