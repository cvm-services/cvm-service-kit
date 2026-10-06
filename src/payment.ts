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

export function parseCapTags(tags: string[][]): Cap[] {
  const caps: Cap[] = [];
  for (const t of tags) {
    if (t[0] === "cap" && t.length >= 4) {
      caps.push({ scope: t[1], amount: Number(t[2]), unit: t[3] });
    }
  }
  return caps;
}

export type GateOrderStatus = "awaiting_payment" | "paid" | "settled" | "refused";

export interface GateOrder {
  orderId: string;
  tool: string;
  caller: string;
  amountSats: number;
  invoice: Invoice;
  status: GateOrderStatus;
  /** Cached tool result, so a replayed payment_accepted never runs twice. */
  result?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface GateOrderStore {
  get(orderId: string): GateOrder | undefined;
  put(order: GateOrder): void;
}

export class MemoryOrderStore implements GateOrderStore {
  private readonly m = new Map<string, GateOrder>();
  get(id: string) { return this.m.get(id); }
  put(o: GateOrder) { this.m.set(o.orderId, o); }
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
      order.status = "paid";
      order.updatedAt = Date.now();
      this.store.put(order);
    }

    const result = await args.run();
    order.status = "settled";
    order.result = result;
    order.updatedAt = Date.now();
    this.store.put(order);
    return result;
  }
}
