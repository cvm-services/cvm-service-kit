/**
 * fiat-intent.ts — the durable FIAT half of the settlement state machine.
 *
 * Why this exists (ADR-0008, card t_63be63f1): the sats leg and the fiat leg are
 * two different payments. The sats leg is gated by the kit's `ExplicitGate`
 * (payment.ts) and NOTHING here re-decides "was the sats paid" — that would be a
 * second gate. What this module adds is the durable record of the *fiat* leg:
 *
 *  - the intent is BOUND to what it was quoted for (tool, caller, order hash,
 *    rail, sats amount, payment hash, fiat cap). Re-using an intent id for a
 *    different order/amount/caller is refused, never silently accepted.
 *  - the fiat attempt counter is durable and CAS-claimed, so one sats payment
 *    can produce AT MOST ONE adapter entry — across concurrent callers and
 *    across process restarts.
 *  - terminal failure is TERMINAL: the sats were taken and the fiat action
 *    failed, so a retry must never re-enter the adapter. It escalates instead
 *    (see escalation.ts, ADR-0012).
 *
 * Honest constraint, written into the contract rather than papered over: there
 * is NO unattended fiat payment. 2fiat is an issuer portal with no authorize
 * endpoint and 3DS/SCA is mandatory, so `fiat_human_required` is a first-class
 * resting state, not an error.
 */

/** Lifecycle of ONE fiat intent. Terminal states are `fiat_completed` and `refunded`. */
export type FiatIntentStatus =
  /** Sats invoice open; nothing has settled. The only status an unpaid call may leave behind. */
  | "awaiting_sats"
  /** The sats leg settled and this intent owns the right to try the fiat leg once. */
  | "sats_settled"
  /** The single permitted adapter entry is in flight (or was interrupted by a crash). */
  | "fiat_in_flight"
  /** The adapter stopped at the human 3DS/OTP step. NOT a failure; never re-attempted blindly. */
  | "fiat_human_required"
  /** Terminal success: the venue's checkout was completed. */
  | "fiat_completed"
  /** Terminal failure: sats final, fiat leg failed. Escalated; never retried. */
  | "fiat_failed_terminal"
  /** Terminal: the operator resolved it (refund). */
  | "refunded";

export const TERMINAL_FIAT_STATUSES: readonly FiatIntentStatus[] = [
  "fiat_completed",
  "refunded",
];

/** Statuses in which the adapter must NEVER be entered again. */
export const NO_ATTEMPT_FIAT_STATUSES: readonly FiatIntentStatus[] = [
  "fiat_in_flight",
  "fiat_human_required",
  "fiat_completed",
  "fiat_failed_terminal",
  "refunded",
];

/** The immutable half of an intent: what it was quoted for. */
export interface FiatIntentBinding {
  /** Caller-supplied idempotency key (the order id). One payment, one intent. */
  intentId: string;
  /** The tool that owns this intent, e.g. "card.pay_checkout". */
  tool: string;
  /** Paying caller pubkey (hex). */
  caller: string;
  /** sha256 over the canonical order (what was ordered, where, for how much). */
  orderHash: string;
  /** Which fiat rail pays the venue, e.g. "2fiat-card". */
  rail: string;
  /** Sats the caller must settle first. */
  satsAmount: number;
  /** Payment hash / Cashu proof reference of that sats payment (the proof of settle). */
  satsProof: string;
  /** Hard decimal cap (e.g. "12.50") the adapter may put on the venue's checkout. */
  fiatCap: string;
}

export interface FiatIntent extends FiatIntentBinding {
  status: FiatIntentStatus;
  /** Durable attempt counter for the FIAT leg. Must never exceed 1. */
  fiatAttempts: number;
  /** The merchant's own hosted checkout the adapter is allowed to open. */
  checkoutUrl: string;
  /** What the adapter reported, when it reported anything. */
  adapterResult?: { status: string; order_id: string; at: number };
  failure?: { message: string; at: number };
  /** Durable escalation bookkeeping: set once, so one terminal intent = one DM. */
  escalatedAt?: number;
  escalationRef?: string;
  /** Set by the bounded-window sweep when an unresolved intent is alerted. */
  alertAt?: number;
  resolution?: { kind: FiatResolutionKind; note: string; at: number };
  createdAt: number;
  updatedAt: number;
}

/** The closed vocabulary an operator reply may resolve an intent to. */
export type FiatResolutionKind =
  | "refunded"
  | "refund_pending"
  | "abandoned"
  | "acknowledged";

export interface FiatIntentStore {
  get(intentId: string): FiatIntent | undefined;
  put(intent: FiatIntent): void;
  /**
   * Atomic compare-and-set on `status`, returning true only for the caller that
   * performed the transition. Exactly one concurrent caller can win, which is
   * what makes "at most one adapter entry" true under concurrency.
   */
  claim(intentId: string, from: FiatIntentStatus, to: FiatIntentStatus): boolean;
  /** Every intent, for the bounded-window sweep. */
  list(): FiatIntent[];
}

export class MemoryFiatIntentStore implements FiatIntentStore {
  private readonly m = new Map<string, FiatIntent>();
  get(id: string) { return this.m.get(id); }
  put(o: FiatIntent) { this.m.set(o.intentId, o); }
  list(): FiatIntent[] { return [...this.m.values()]; }
  claim(id: string, from: FiatIntentStatus, to: FiatIntentStatus): boolean {
    const cur = this.m.get(id);
    if (!cur || cur.status !== from) return false;
    const next: FiatIntent = { ...cur, status: to, updatedAt: Date.now() };
    if (to === "fiat_in_flight") next.fiatAttempts = cur.fiatAttempts + 1;
    this.m.set(id, next);
    return true;
  }
}

/** The intent is already owned by a different quote (order/amount/caller/tool/rail). */
export class FiatIntentMismatchError extends Error {
  readonly code = -32011;
  constructor(readonly intentId: string, readonly detail: string) {
    super(`fiat_intent_mismatch: ${detail}`);
    this.name = "FiatIntentMismatchError";
    this.data = { reason: "fiat_intent_mismatch", intentId, detail };
  }
  readonly data: Record<string, unknown>;
}

/**
 * Terminal fiat failure: the sats are final and the fiat action did not happen
 * (or its outcome is unknown). A retry re-throws this; it never re-enters the
 * adapter, because that would be a second payment against one sats settlement.
 */
export class FiatTerminalError extends Error {
  readonly code = -32012;
  constructor(readonly intentId: string, readonly detail: string) {
    super(`fiat_terminal_failure: ${detail}`);
    this.name = "FiatTerminalError";
    this.data = {
      reason: "fiat_terminal_failure",
      intentId,
      detail,
      remedy:
        "The sats payment is final and the fiat leg is terminal. Do NOT retry: the operator has been escalated over Nostr DM (ADR-0012) and resolves it manually.",
    };
  }
  readonly data: Record<string, unknown>;
}

/** The two sides of an intent that must never change for one sats payment. */
export function bindingMatches(a: FiatIntentBinding, b: FiatIntentBinding): string | null {
  const fields: Array<keyof FiatIntentBinding> = [
    "tool",
    "caller",
    "orderHash",
    "rail",
    "satsAmount",
    "satsProof",
    "fiatCap",
  ];
  for (const f of fields) {
    if (a[f] !== b[f]) return `${f}: intent has ${String(a[f])}, request has ${String(b[f])}`;
  }
  return null;
}
