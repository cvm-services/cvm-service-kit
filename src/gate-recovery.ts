/**
 * Operator recovery for gate orders the gate itself refuses to re-run.
 *
 * The gate's default - and correct - behaviour is to never run a tool against a
 * payment that has already been verified. Two states follow from that, and
 * before this module there was no way out of either: the customer's sats are
 * taken, they get no service, and every retry throws forever.
 *
 *   `settlement_reserved`  a caller owned the action and its process died before
 *                          it could write an outcome. The row is pinned:
 *                          retries throw `SettlementInProgressError` forever.
 *   `settlement_failed`    the action ran and failed. Retries throw
 *                          `SettlementFailedError` forever.
 *
 * The escape hatch is deliberately NOT automatic. Whether a `settlement_reserved`
 * action ever reached the venue is knowable only by looking at the venue, so no
 * lease expiry, timeout or background sweep may flip the row on its own: an
 * automatic re-drive is exactly the double spend this gate exists to prevent.
 * The lease's only job is to SURFACE a candidate to a human; releasing it is an
 * explicit, logged operator action taken after checking the downstream system.
 *
 * `releaseReservation` moves the row back to `awaiting_payment` through the same
 * compare-and-set the gate uses, so a release racing a live caller cannot
 * manufacture two owners. `recordCompensation` never touches the order status at
 * all - status is the money-safety fact, the compensation is bookkeeping.
 */
import type { GateOrder } from "./payment.ts";
import type { GateResolution, SqliteGateStore } from "./gate-store.ts";

/** How long a reservation is assumed live before it is worth a human's attention. */
export const DEFAULT_RESERVATION_LEASE_MS = 15 * 60 * 1000;

export type CompensationOutcome = "refunded" | "abandoned";

export interface InspectOptions {
  /** Clock injection for tests. Defaults to `Date.now()`. */
  now?: number;
  /** Override the reservation lease. Defaults to `DEFAULT_RESERVATION_LEASE_MS`. */
  leaseMs?: number;
}

export interface StuckOrder {
  order: GateOrder;
  /** `now - order.updatedAt`: how long the order has been in this state. */
  ageMs: number;
  /**
   * `ageMs > leaseMs`. A surfacing hint for the operator ONLY: nothing in this
   * module acts on it, because a long-running action and a crashed one look the
   * same from here.
   */
  leaseExpired: boolean;
  /** Compensation already recorded for this order, if any. */
  resolution?: GateResolution;
}

export interface StuckReport {
  now: number;
  leaseMs: number;
  /** In-flight: a caller owned the action and has not written an outcome. */
  reserved: StuckOrder[];
  /** Terminal: the sats were taken and the action failed. */
  failed: StuckOrder[];
  /**
   * Legacy pre-2026-10-09 rows left at `paid`, a status the gate set BEFORE the
   * action ran. Their outcome is unverifiable by construction, so the gate
   * refuses them with `GateOrderStateError` and never moves them: they are
   * terminal-in-practice and had no operator surface at all before this bucket.
   * (Review finding B2.)
   */
  legacy: StuckOrder[];
}

function classify(order: GateOrder, now: number, leaseMs: number, resolution?: GateResolution): StuckOrder {
  // FAIL CLOSED on an age we cannot compute: a non-finite `updatedAt` (a
  // malformed or hand-edited row) must not read as "infinitely old, therefore
  // safe to release". `Number.NaN` compares false against everything, so the
  // unguarded form would have skipped the lease refusal entirely.
  // (Review finding B6.)
  const ageMs = Number.isFinite(order.updatedAt) ? Math.max(0, now - order.updatedAt) : Number.NaN;
  return { order, ageMs, leaseExpired: Number.isFinite(ageMs) && ageMs > leaseMs, resolution };
}

/**
 * Read-only. Reports every order the gate will not move on its own: reservations
 * that never wrote an outcome, terminal failures, and legacy `paid` rows whose
 * outcome is unverifiable. Oldest first, with each row's age and whether the
 * lease has elapsed. It changes nothing: no row is released, retried or rewritten.
 */
export function findStuckOrders(store: SqliteGateStore, opts: InspectOptions = {}): StuckReport {
  const now = opts.now ?? Date.now();
  const leaseMs = opts.leaseMs ?? DEFAULT_RESERVATION_LEASE_MS;
  const resolutions = new Map(store.listResolutions().map((r) => [r.orderId, r]));
  const bucket = (statuses: GateOrder["status"]) =>
    store.list(statuses).map((o) => classify(o, now, leaseMs, resolutions.get(o.orderId)));
  return {
    now,
    leaseMs,
    reserved: bucket("settlement_reserved"),
    failed: bucket("settlement_failed"),
    legacy: bucket("paid"),
  };
}

export type ReleaseRefusal = "not_found" | "not_reserved" | "lease_active" | "raced";

export interface ReleaseResult {
  released: boolean;
  /** The order as it was read BEFORE the attempt (absent when `not_found`). */
  order?: GateOrder;
  refusal?: ReleaseRefusal;
  ageMs?: number;
  leaseMs?: number;
}

/**
 * Release a pinned reservation so a retry can re-drive it: CAS
 * `settlement_reserved -> awaiting_payment`.
 *
 * Refuses while the lease is still live unless `force` is set, so a merely slow
 * (not crashed) action cannot be released by accident. It refuses anything that
 * is not currently `settlement_reserved`, which means a settled or failed order
 * can never be resurrected into a second run.
 */
export function releaseReservation(
  store: SqliteGateStore,
  orderId: string,
  opts: InspectOptions & { force?: boolean } = {},
): ReleaseResult {
  const now = opts.now ?? Date.now();
  const leaseMs = opts.leaseMs ?? DEFAULT_RESERVATION_LEASE_MS;
  const order = store.get(orderId);
  if (!order) return { released: false, refusal: "not_found" };
  if (order.status !== "settlement_reserved") return { released: false, refusal: "not_reserved", order };

  const ageMs = Number.isFinite(order.updatedAt) ? Math.max(0, now - order.updatedAt) : Number.NaN;
  // FAIL CLOSED when the age is unknown: an un-computable age must refuse like a
  // live lease, never pass as "long since expired". See `classify`.
  if (!Number.isFinite(ageMs) || ageMs <= leaseMs) {
    if (!opts.force) return { released: false, refusal: "lease_active", order, ageMs, leaseMs };
  }
  // Version-predicated CAS: the row must still be the exact revision inspected
  // above (`settlement_reserved` AND the same `updated_at`). A status-only CAS
  // would match a row that moved away and back (release -> re-claim -> reserved),
  // letting a STALE operator read cancel a live caller's claim without --force.
  // (Review finding B1, round 4.)
  const released = store.releaseIfUnchanged(orderId, order.updatedAt);
  if (!released) return { released: false, refusal: "raced", order, ageMs, leaseMs };
  return { released: true, order, ageMs, leaseMs };
}

export type CompensationRefusal = "not_found" | "not_compensatable";

/** Statuses an operator may record a compensation against. */
export const COMPENSATABLE_STATUSES: readonly GateOrder["status"][] = [
  // The action ran and failed: refund/abandon, keep the status.
  "settlement_failed",
  // The action may have reached the venue but the process died before writing an
  // outcome. The runbook's step for this case says to record the compensation; it
  // is the ONLY durable record available for such a row, which stays
  // `settlement_reserved` on purpose (releasing it would re-run an action of
  // unknown outcome). (Review finding B3.)
  "settlement_reserved",
  // Legacy pre-2026-10-09 rows: the outcome is unverifiable, so a compensation is
  // a decision about the money and the row never moves. (Review finding B2.)
  "paid",
];

export interface CompensationResult {
  recorded: boolean;
  resolution?: GateResolution;
  refusal?: CompensationRefusal;
}

/**
 * Record that an operator has compensated an order the gate will not re-run.
 *
 * Refuses an order in any status that is not in `COMPENSATABLE_STATUSES`, so this
 * cannot be used to brand an in-flight-success or already-settled order as
 * resolved. The order STATUS is deliberately left alone: `settlement_failed` is
 * what keeps a replay throwing `SettlementFailedError`, and `settlement_reserved`
 * is what keeps it throwing `SettlementInProgressError`. A compensation is an
 * audit record about the money, not a licence to retry.
 */
export function recordCompensation(
  store: SqliteGateStore,
  orderId: string,
  compensation: { outcome: CompensationOutcome; note: string; now?: number },
): CompensationResult {
  const order = store.get(orderId);
  if (!order) return { recorded: false, refusal: "not_found" };
  if (!COMPENSATABLE_STATUSES.includes(order.status)) {
    return { recorded: false, refusal: "not_compensatable" };
  }

  const resolution: GateResolution = {
    orderId,
    outcome: compensation.outcome,
    note: compensation.note,
    at: compensation.now ?? Date.now(),
  };
  store.putResolution(resolution);
  return { recorded: true, resolution };
}
