/** CEP-8 payment surface: `cap` prices, `pmi`, explicit gating and idempotency. */
import { createHash } from "node:crypto";

/**
 * Digest of a client-supplied payment proof (a Cashu token, say). Only the digest
 * is ever stored, never the token itself: a stolen gate database must not be
 * replayable against the mint as a bearer instrument. Same rule (and same
 * digest) as the fiat intent store's `PaymentIntent.proofHash`.
 */
export function proofHash(proof: string): string {
  return createHash("sha256").update(proof).digest("hex");
}

/**
 * Normalised proof digest: an absent or empty proof means "no evidence
 * presented", which is distinct from a digest. A caller cannot smuggle an
 * empty string in as evidence.
 */
function proofDigest(proof: string | undefined): string | undefined {
  return typeof proof === "string" && proof.length > 0 ? proofHash(proof) : undefined;
}

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

/**
 * The order is in a state this build cannot safely act on: a status it does not
 * recognise, or a legacy `paid` row written by the pre-2026-10-09 code BEFORE
 * the action ran (so whether the action ran is unknowable).
 *
 * Distinct from SettlementFailedError on purpose: nothing here says the action
 * failed, only that running it again could spend the same payment twice. Fail
 * closed, and keep the two states distinguishable for the settlement state
 * machine built on top of this gate.
 */
export class GateOrderStateError extends Error {
  readonly code = -32005;
  constructor(readonly orderId: string, readonly status: string, readonly detail: string) {
    super(`order_state_unverifiable: status=${status}: ${detail}`);
    this.name = "GateOrderStateError";
  }
}

/**
 * A replay presented payment evidence that does not match the evidence the order
 * was settled with - a different proof, a proof that paid another order, no proof
 * where one is required, or a proof attached to an order that was settled without
 * one. Fail closed: the cached result is NOT returned.
 *
 * Deliberately does NOT carry an invoice in `data`, unlike PaymentRequiredError.
 * The order is already settled, so re-presenting its invoice would only invite a
 * second payment for work that is already paid; the caller can recover the
 * cached result only by presenting the evidence that paid it.
 */
export class SettlementEvidenceMismatchError extends Error {
  readonly code = -32006;
  readonly data: { orderId: string; reason: string };
  constructor(
    readonly orderId: string,
    readonly reason: string,
  ) {
    super(`settlement_evidence_mismatch: ${reason}`);
    this.name = "SettlementEvidenceMismatchError";
    this.data = { orderId, reason };
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
  /**
   * sha256 of the payment proof that settled this order, or undefined when the
   * order was settled without a client proof (an invoice-polling pmi such as
   * Lightning, or a row written before this field existed). A replay must
   * present the same evidence before the cached result is handed back.
   */
  proofHash?: string;
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
   *
   * When `proofHash` is given, the payment evidence is recorded in the SAME
   * statement as the transition, so an order can never be claimed without the
   * evidence that paid for it - not even across a crash.
   */
  claim(
    orderId: string,
    from: GateOrderStatus,
    to: GateOrderStatus,
    proofHash?: string,
  ): boolean;
}

export class MemoryOrderStore implements GateOrderStore {
  private readonly m = new Map<string, GateOrder>();
  get(id: string) { return this.m.get(id); }
  put(o: GateOrder) { this.m.set(o.orderId, o); }
  // Synchronous and without an await: the check-and-set cannot interleave.
  claim(id: string, from: GateOrderStatus, to: GateOrderStatus, proofHash?: string): boolean {
    const cur = this.m.get(id);
    if (!cur || cur.status !== from) return false;
    const next: GateOrder = { ...cur, status: to, updatedAt: Date.now() };
    // Never erase a recorded binding with an absent one: only a caller that
    // presents evidence sets it.
    if (proofHash !== undefined) next.proofHash = proofHash;
    this.m.set(id, next);
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
      // Replay: return the cached result, never re-run the tool - but only to a
      // caller that presents the payment evidence this order was settled with.
      // `orderId` is client-supplied, so keying the cached result on it alone
      // let a different proof, a proof that paid a different order, or no proof
      // at all collect a result somebody else paid for.
      this.assertReplayedEvidence(order, args.proof);
      return order.result as T;
    }

    // Every other status is decided HERE, and only `awaiting_payment` reaches the
    // action below. Written as an exhaustive switch with an explicit `default`
    // because the previous shape enumerated three statuses and let everything
    // else - a `refused` order, or any status written by a different build -
    // FALL THROUGH to `args.run()`: an unverified order would have executed the
    // downstream action with no payment check and no claim. A status this build
    // does not recognise must deny, never run.
    switch (order.status) {
      case "awaiting_payment":
        break;
      case "settlement_reserved":
        // Another caller already holds the settlement claim for this payment.
        throw new SettlementInProgressError(order.orderId);
      case "settlement_failed":
        // Terminal: the sats were taken and the action failed. Re-running would
        // spend the same payment twice, so a retry re-throws the recorded reason.
        // A store that keeps the row but drops `failure` yields "unknown" here.
        throw new SettlementFailedError(order.orderId, order.failure?.message ?? "unknown");
      case "paid":
        // Written by the pre-2026-10-09 code BEFORE the action ran. Whether the
        // action ran is unknowable, so refuse rather than risk a second attempt -
        // and do not call it a settlement failure it may never have had.
        throw new GateOrderStateError(
          order.orderId,
          order.status,
          "legacy row written before the action ran: settlement outcome unknown",
        );
      case "refused":
        throw new GateOrderStateError(
          order.orderId,
          order.status,
          "order is refused; the action must not run",
        );
      default:
        throw new GateOrderStateError(
          order.orderId,
          String(order.status),
          "unrecognised order status; refusing to run",
        );
    }

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
    const evidence = proofDigest(args.proof);
    const won = this.store.claim(
      order.orderId,
      "awaiting_payment",
      "settlement_reserved",
      evidence,
    );
    if (!won) throw new SettlementInProgressError(order.orderId);

    try {
      const result = await args.run();
      try {
        const done = this.store.get(order.orderId) ?? order;
        done.status = "settled";
        done.result = result;
        // A settled row must always carry the evidence that paid for it, even if
        // a store implementation dropped it on the way through.
        if (done.proofHash === undefined && evidence !== undefined) done.proofHash = evidence;
        done.updatedAt = Date.now();
        this.store.put(done);
      } catch {
        // The action RAN and succeeded; only recording it failed (a locked store).
        // Never mask a completed action behind a storage error: the row is still
        // `settlement_reserved`, so the worst case is a replay that reports
        // "in progress" - never a second run of the action.
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const failed = this.store.get(order.orderId) ?? order;
        failed.status = "settlement_failed";
        failed.failure = { message, at: Date.now() };
        failed.updatedAt = Date.now();
        this.store.put(failed);
      } catch {
        // Same reasoning: the terminal write failed, so the row stays
        // `settlement_reserved` and a retry throws SettlementInProgressError
        // instead of re-running. Fail closed, and never swallow the real error.
      }
      throw err;
    }
  }

  /**
   * A settled order hands back its cached result only to a caller that presents
   * the payment evidence the order was settled with:
   *
   *  - a proof-settled order (CEP-8 Cashu: `verify` redeems the client's token)
   *    requires a proof whose digest equals the recorded one. A different proof,
   *    a proof that paid another order, or no proof at all is refused;
   *  - an order settled without a client proof (an invoice-polling pmi such as
   *    Lightning, or a legacy row) keeps the documented idempotency contract for
   *    a no-proof replay - there is no client-held evidence to bind - but a
   *    replay that attaches a proof is refused: that proof demonstrably did not
   *    pay this order.
   */
  private assertReplayedEvidence(order: GateOrder, proof?: string): void {
    const presented = proofDigest(proof);
    if (presented === order.proofHash) return;
    const reason =
      order.proofHash === undefined
        ? "order was settled without a client proof; a proof cannot be bound to it on replay"
        : presented === undefined
          ? "replay presented no proof; the proof that settled this order is required"
          : "the presented proof is not the proof that settled this order";
    throw new SettlementEvidenceMismatchError(order.orderId, reason);
  }
}
