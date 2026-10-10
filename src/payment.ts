/** CEP-8 payment surface: `cap` prices, `pmi`, explicit gating and idempotency. */
import { createHash, timingSafeEqual } from "node:crypto";

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
 * The proof as the gate treats it: a non-empty string, or nothing. `args.proof`
 * arrives over JSON-RPC untyped, so a non-string (or empty) value is not
 * evidence. Normalising it in ONE place means a processor that would otherwise
 * have coerced it cannot settle an order with `evidence === undefined`, which
 * would leave that order replayable by `orderId` alone - the hole this card
 * exists to close.
 */
function presentedProof(proof: unknown): string | undefined {
  return typeof proof === "string" && proof.length > 0 ? proof : undefined;
}

/**
 * Normalised proof digest: an absent or empty proof means "no evidence
 * presented", which is distinct from a digest. A caller cannot smuggle an
 * empty string in as evidence.
 */
function proofDigest(proof: string | undefined): string | undefined {
  const p = presentedProof(proof);
  return p === undefined ? undefined : proofHash(p);
}

/**
 * Compare two recorded/presented digests without short-circuiting on the first
 * differing byte. Both sides are fixed-width sha256 hex and a digest is not a
 * usable secret (the token behind it is preimage-protected), so this is defence
 * in depth, not a fix for a live leak - it costs one call and removes a
 * byte-at-a-time oracle if a digest is ever compared against caller input in a
 * context where the timing is measurable.
 */
function digestEquals(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const enc = new TextEncoder();
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  if (ea.length !== eb.length) return false;
  return timingSafeEqual(ea, eb);
}

/** A status the gate will never move out of on its own. */
const TERMINAL_STATUSES: readonly GateOrderStatus[] = [
  "settled",
  "settlement_failed",
  "refused",
  "paid", // legacy row: written before the action ran, refused on sight
];

/**
 * Is this write a NEW order generation on a reused `orderId` rather than an
 * update of the order already stored? `orderId` is client-supplied, so a caller
 * can reuse one after its previous order settled; both bundled stores drop the
 * previous generation's evidence digest in that case instead of inheriting it
 * (see `MemoryOrderStore.put` / `SqliteGateStore.put`).
 */
function startsNewGeneration(prev: GateOrder | undefined, next: GateOrder): boolean {
  return (
    prev !== undefined &&
    next.status === "awaiting_payment" &&
    TERMINAL_STATUSES.includes(prev.status)
  );
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
   *
   * EXACTLY-ONCE HAZARD for proof-consuming processors. `ExplicitGate` calls
   * `verify()` to find out whether a call was paid, and only THEN serialises
   * settlement on the store's atomic claim. Two concurrent first-calls for one
   * order therefore both reach `verify()`, and a processor that accepts a second
   * DISTINCT valid proof for an invoice it has already been paid for produces a
   * second payer the gate cannot bind: the loser gets `SettlementInProgressError`
   * and every later retry with its own (already redeemed) proof is refused by the
   * evidence check. A processor that must not take two payments for one invoice
   * has to reject the second proof itself - record the accepted payment against
   * the invoice and refuse a redemption that would double-cover it - because the
   * gate cannot serialise `verify()` against the claim. See REPORT §5 (residual
   * gaps) and the F3 finding of this card's cross-family reviews.
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
    super(reason);
    this.name = "SettlementEvidenceMismatchError";
    this.data = { orderId, reason };
  }
}

/**
 * The store accepted the settlement write but did not keep the evidence digest
 * (cross-family review finding F4). Without it the order is replayable by
 * `orderId` alone - the hole this card closes - so this fails closed and loudly
 * instead of handing back a result whose binding is not durable. Not reachable
 * with the bundled stores; it exists so a custom `GateOrderStore` cannot
 * reintroduce the hole silently.
 */
export class SettlementBindingNotPersistedError extends Error {
  readonly code = -32007;
  readonly data: { orderId: string; reason: string };
  constructor(readonly orderId: string) {
    super(
      "settlement_binding_not_persisted: the store did not record the payment evidence for this settled order",
    );
    this.name = "SettlementBindingNotPersistedError";
    this.data = { orderId, reason: "the store did not persist the proof digest" };
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
   *
   * CONTRACT for implementors: a store must persist `GateOrder.proofHash` and
   * must not clear a recorded one with a write that carries no digest (the
   * bundled stores both COALESCE). `ExplicitGate` re-reads the row after
   * settling and fails closed if the binding did not land, so a store that
   * silently drops it cannot hand out an unbound settled order.
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
  /**
   * Same "a write that carries no evidence must never unbind an order" rule as
   * `SqliteGateStore.put`'s `COALESCE`. Without it the two bundled stores
   * disagreed: a `put()` of a stale order object (built from a pre-claim read,
   * say) would wipe the binding on the memory store and re-open the
   * orderId-only replay hole. Only a `claim()` - or a put that carries evidence
   * - sets a digest.
   *
   * Exception: a write that moves a TERMINAL row back to `awaiting_payment` is a
   * NEW order generation on a reused `orderId`, not an update of the old one, so
   * the old generation's binding is dropped instead of inherited. Inheriting it
   * would settle the new order bound to the previous payer's digest: the new
   * payer's own replay would be refused, and the previous payer's proof would
   * collect the new order's result.
   */
  put(o: GateOrder) {
    const cur = this.m.get(o.orderId);
    if (startsNewGeneration(cur, o)) {
      this.m.set(o.orderId, { ...o, proofHash: o.proofHash });
      return;
    }
    if (o.proofHash === undefined && cur?.proofHash !== undefined) {
      this.m.set(o.orderId, { ...o, proofHash: cur.proofHash });
      return;
    }
    this.m.set(o.orderId, o);
  }
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
    // Normalise the client-supplied evidence ONCE. A non-string (or empty)
    // proof is not evidence anywhere below: it cannot settle an order unbound,
    // and it cannot satisfy a replay.
    const proof = presentedProof(args.proof);
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
      this.assertReplayedEvidence(order, proof);
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

    // `proof` is the normalised evidence (non-string input is not evidence), so
    // a processor that would have coerced a non-string can no longer settle an
    // order without a recorded binding.
    const paid = await this.processor.verify(order.invoice, proof);
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
    const evidence = proofDigest(proof);
    const won = this.store.claim(
      order.orderId,
      "awaiting_payment",
      "settlement_reserved",
      evidence,
    );
    if (!won) throw new SettlementInProgressError(order.orderId);

    try {
      const result = await args.run();
      let persisted = true;
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
        // Do not mask a completed action behind a storage error: the row is still
        // `settlement_reserved`, so the worst case is a replay that reports
        // "in progress" - never a second run of the action.
        //
        // (The F4 check below IS a deliberate exception: when the store ACCEPTED
        // the write but dropped the digest, the settled row is replayable by
        // orderId alone, so the result is withheld on purpose.)
        persisted = false;
      }
      // F4: the write was ACCEPTED but the digest did not land, so this settled
      // order would be replayable by `orderId` alone - exactly the hole this card
      // closes. Fail closed and loudly rather than hand back a result whose
      // binding is not durable. Checked only when the store accepted the write: a
      // store that was merely down leaves the row `settlement_reserved`, which the
      // documented "in progress" contract already covers.
      if (
        persisted &&
        evidence !== undefined &&
        this.store.get(order.orderId)?.proofHash !== evidence
      ) {
        throw new SettlementBindingNotPersistedError(order.orderId);
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
    if (digestEquals(presented, order.proofHash)) return;
    // ONE reason for every mismatch shape. Distinguishing "this order was settled
    // without a client proof" from "a proof is required" told any caller who
    // presented nothing whether a guessed `orderId` was settled with a client
    // proof - a settlement-method oracle - for no caller-side benefit: the caller
    // already knows what it presented. The operator can read the row for detail.
    throw new SettlementEvidenceMismatchError(order.orderId, "settlement_evidence_mismatch");
  }
}
