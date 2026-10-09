/**
 * fiat-path.ts — the gated call path: the fiat leg is unreachable until the
 * caller's sats payment has SETTLED (ADR-0008), and it is entered at most once.
 *
 * Enforcement lives HERE, at the service boundary, and it is the kit's durable
 * settlement state machine (`ExplicitGate` + a durable `GateOrderStore`) that
 * decides "was the sats paid". This module deliberately does NOT re-decide it —
 * no second gate, no payment verification of its own — and the local adapter
 * knows nothing about payments (its `pay_checkout` is a dumb card driver).
 *
 * Ordering that is a property, not a policy:
 *
 *   1. binding check  — an intent id may not be re-used for another order.
 *   2. gate.gate()    — the ONLY sats decision. Unpaid call => payment_required,
 *                       and the adapter is never reached. The gate's atomic
 *                       claim is what makes exactly-once true under concurrency.
 *   3. durable CAS    — awaiting_sats -> sats_settled -> fiat_in_flight. The
 *                       attempt counter is incremented in the same statement
 *                       that opens the window, so it can never exceed 1.
 *   4. adapter call   — one checkout, one card, on the operator's machine.
 *   5. terminal rules — a failed fiat leg is TERMINAL (escalate, never retry).
 *                       `human_required` is the honest resting state: nobody can
 *                       automate 3DS.
 */
import type { ExplicitGate } from "./payment.ts";
import {
  bindingMatches,
  type FiatIntent,
  type FiatIntentBinding,
  FiatIntentMismatchError,
  type FiatIntentStatus,
  type FiatIntentStore,
  type FiatResolutionKind,
  FiatTerminalError,
} from "./fiat-intent.ts";
import {
  type Escalator,
  type FiatEscalationKind,
  type FiatEscalationNotice,
  noticeForIntent,
  parseOperatorReply,
  repliesRequestsAnotherAttempt,
} from "./escalation.ts";

/** What the local (private) adapter exposes to this service. Card material never crosses. */
export interface PayCheckoutAdapter {
  pay_checkout(
    url: string,
    max_amount: string,
  ): Promise<{ status: "human_required" | "completed" | "failed"; order_id: string }>;
}

export interface FiatCheckoutRequest extends FiatIntentBinding {
  /** The merchant's own hosted checkout the adapter may open. */
  checkoutUrl: string;
  /** Optional client-supplied sats payment proof (e.g. a Cashu token) for the gate. */
  proof?: string;
}

export interface FiatPathDeps {
  /** The ONE payment gate (the durable settlement state machine). */
  gate: ExplicitGate;
  store: FiatIntentStore;
  adapter: PayCheckoutAdapter;
  escalator: Escalator;
  /** The CVM's operator identity — cvm-2fiat's OWNER_NPUB_HEX. Not a new npub. */
  operatorNpub: string;
  /** ADR-0012 bounded window: an unresolved intent older than this raises an alert. */
  unresolvedWindowMs?: number;
  now?: () => number;
}

export interface FiatCheckoutOutcome {
  status: "completed" | "human_required";
  order_id: string;
  intent_id: string;
  /** Always set: the step no machine can do. */
  human_step: string;
}

export const HUMAN_STEP =
  "3DS/SCA (and the 2fiat OTP) at the venue's hosted checkout. 2fiat is an issuer portal " +
  "with no authorize endpoint, so the last step of every fiat payment is completed by the " +
  "operator in a browser. No unattended fiat payment exists in this system.";

/** The sats completed and the fiat leg is already owned/escalated: never re-enter the adapter. */
export class FiatRetryRefusedError extends Error {
  readonly code = -32013;
  constructor(readonly intentId: string, readonly status: FiatIntentStatus, detail: string) {
    super(`fiat_retry_refused: ${detail}`);
    this.name = "FiatRetryRefusedError";
    this.data = {
      reason: "fiat_retry_refused",
      intentId,
      status,
      remedy:
        "One sats settlement buys at most one fiat attempt. The operator resolves a stuck intent " +
        "manually (ADR-0012 escalation). Retrying is refused by design.",
    };
  }
  readonly data: Record<string, unknown>;
}

const CAP_RE = /^\d+(\.\d{1,2})?$/;

function assertRequest(req: FiatCheckoutRequest): void {
  if (!req.intentId.trim()) throw new Error("intentId is required");
  if (!req.orderHash.trim()) throw new Error("orderHash is required (bind the intent to the order)");
  if (!req.rail.trim()) throw new Error("rail is required");
  if (!req.satsProof.trim()) throw new Error("satsProof is required (the proof the sats settled)");
  if (!Number.isInteger(req.satsAmount) || req.satsAmount <= 0) {
    throw new Error("satsAmount must be a positive integer");
  }
  if (!CAP_RE.test(req.fiatCap) || Number(req.fiatCap) <= 0) {
    throw new Error("fiatCap must be a positive decimal with at most 2 places, e.g. '12.50'");
  }
  let url: URL;
  try {
    url = new URL(req.checkoutUrl);
  } catch {
    throw new Error("checkoutUrl must be a valid https:// merchant checkout URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("checkoutUrl must be a valid https:// merchant checkout URL");
  }
}

/**
 * The gated fiat call path. Returns ONLY after the sats settled and the adapter
 * reported; throws `payment_required` while unpaid (adapter untouched) and
 * `fiat_terminal_failure` after a failed fiat leg (adapter never re-entered).
 */
export async function payCheckoutGated(
  deps: FiatPathDeps,
  req: FiatCheckoutRequest,
): Promise<FiatCheckoutOutcome> {
  assertRequest(req);
  const now = deps.now ?? (() => Date.now());

  const existing = deps.store.get(req.intentId);
  if (existing) {
    const mismatch = bindingMatches(existing, req);
    if (mismatch) throw new FiatIntentMismatchError(req.intentId, mismatch);
    // A settled intent replays its recorded outcome; it never re-runs anything.
    if (existing.status === "fiat_completed") {
      return {
        status: "completed",
        order_id: existing.adapterResult?.order_id ?? "",
        intent_id: existing.intentId,
        human_step: HUMAN_STEP,
      };
    }
    if (existing.status === "fiat_failed_terminal") {
      throw new FiatTerminalError(existing.intentId, existing.failure?.message ?? "unknown");
    }
    if (existing.status === "refunded") {
      throw new FiatTerminalError(existing.intentId, "resolved by the operator as refunded");
    }
    if (existing.status === "fiat_in_flight" || existing.status === "fiat_human_required") {
      throw new FiatRetryRefusedError(
        existing.intentId,
        existing.status,
        existing.status === "fiat_human_required"
          ? "the fiat leg already reached the human 3DS step; a human finishes it"
          : "a fiat attempt is already in flight for this sats settlement",
      );
    }
  } else {
    deps.store.put({
      intentId: req.intentId,
      tool: req.tool,
      caller: req.caller,
      orderHash: req.orderHash,
      rail: req.rail,
      satsAmount: req.satsAmount,
      satsProof: req.satsProof,
      fiatCap: req.fiatCap,
      checkoutUrl: req.checkoutUrl,
      status: "awaiting_sats",
      fiatAttempts: 0,
      createdAt: now(),
      updatedAt: now(),
    });
  }

  // THE gate. Everything below runs only because the sats settled.
  return deps.gate.gate({
    tool: req.tool,
    caller: req.caller,
    amountSats: req.satsAmount,
    orderId: req.intentId,
    proof: req.proof,
    run: () => runFiatLeg(deps, req, now),
  });
}

async function runFiatLeg(
  deps: FiatPathDeps,
  req: FiatCheckoutRequest,
  now: () => number,
): Promise<FiatCheckoutOutcome> {
  // Durable, CAS-claimed, single-entry. If this loses, another runner owns the
  // attempt: refuse rather than enter the adapter a second time.
  if (!deps.store.claim(req.intentId, "awaiting_sats", "sats_settled")) {
    throw new FiatIntentMismatchError(
      req.intentId,
      "intent is not awaiting_sats; refusing to enter the adapter",
    );
  }
  if (!deps.store.claim(req.intentId, "sats_settled", "fiat_in_flight")) {
    throw new FiatIntentMismatchError(
      req.intentId,
      "intent is not sats_settled; refusing to enter the adapter",
    );
  }

  let result: { status: string; order_id: string };
  try {
    result = await deps.adapter.pay_checkout(req.checkoutUrl, req.fiatCap);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    await failTerminal(deps, req.intentId, `adapter threw: ${message}`, now);
    // failTerminal always throws.
    throw new FiatTerminalError(req.intentId, "unreachable");
  }

  if (result.status === "completed") {
    mark(deps.store, req.intentId, "fiat_completed", {
      adapterResult: { status: result.status, order_id: result.order_id, at: now() },
    });
    return {
      status: "completed",
      order_id: result.order_id,
      intent_id: req.intentId,
      human_step: HUMAN_STEP,
    };
  }

  if (result.status === "human_required") {
    // NOT a failure: the money is safe, a human must finish the last step.
    mark(deps.store, req.intentId, "fiat_human_required", {
      adapterResult: { status: result.status, order_id: result.order_id, at: now() },
    });
    return {
      status: "human_required",
      order_id: result.order_id,
      intent_id: req.intentId,
      human_step: HUMAN_STEP,
    };
  }

  await failTerminal(deps, req.intentId, `adapter reported status "${result.status}"`, now);
  throw new FiatTerminalError(req.intentId, "unreachable");
}

function mark(
  store: FiatIntentStore,
  intentId: string,
  status: FiatIntentStatus,
  patch: Partial<FiatIntent> = {},
): void {
  const cur = store.get(intentId);
  if (!cur) return;
  store.put({ ...cur, ...patch, status, updatedAt: Date.now() });
}

/**
 * The sats are final and the fiat action failed: write the TERMINAL state first
 * (durable), then escalate exactly once, then refuse. A crash between the two
 * leaves `escalatedAt` unset, and the sweep re-emits it — the escalation is owed
 * until it is recorded, and is never silently lost.
 */
async function failTerminal(
  deps: FiatPathDeps,
  intentId: string,
  whatFailed: string,
  now: () => number,
): Promise<never> {
  const cur = deps.store.get(intentId);
  if (!cur) throw new FiatTerminalError(intentId, whatFailed);
  mark(deps.store, intentId, "fiat_failed_terminal", {
    failure: { message: whatFailed, at: now() },
  });
  await escalateOnce(deps, intentId, whatFailed, "fiat_failed_terminal", now);
  throw new FiatTerminalError(intentId, whatFailed);
}

/** One terminal intent = one DM, recorded durably. */
async function escalateOnce(
  deps: Pick<FiatPathDeps, "store" | "escalator" | "operatorNpub">,
  intentId: string,
  whatFailed: string,
  kind: FiatEscalationKind,
  now: () => number,
): Promise<FiatEscalationNotice | null> {
  const cur = deps.store.get(intentId);
  if (!cur || cur.escalatedAt) return null;
  const notice = noticeForIntent(cur, deps.operatorNpub, whatFailed, now(), kind);
  const { ref } = await deps.escalator.escalate(notice);
  const after = deps.store.get(intentId);
  if (after) {
    deps.store.put({ ...after, escalatedAt: now(), escalationRef: ref, updatedAt: Date.now() });
  }
  return notice;
}

// ---------------------------------------------------------------------------
// operator replies: inputs to durable state, never actions
// ---------------------------------------------------------------------------

export interface OperatorReply {
  intentId: string;
  /** Reply author pubkey (hex). Only the operator's own key is accepted. */
  from: string;
  text: string;
  /** Nostr event id, for the caller's own dedup. */
  eventId?: string;
  at?: number;
}

export interface ReplyOutcome {
  outcome: "resolved" | "refused_attempt_request" | "unknown_text";
  resolution?: FiatResolutionKind;
  intent: FiatIntent;
}

export async function applyOperatorReply(
  deps: Pick<FiatPathDeps, "store" | "escalator" | "operatorNpub" | "now">,
  reply: OperatorReply,
): Promise<ReplyOutcome> {
  const now = deps.now ?? (() => Date.now());
  const intent = deps.store.get(reply.intentId);
  if (!intent) throw new FiatIntentMismatchError(reply.intentId, "unknown intent");
  if (reply.from !== deps.operatorNpub) {
    throw new FiatIntentMismatchError(
      reply.intentId,
      "escalation replies are accepted from the operator pubkey only",
    );
  }

  // A reply that asks for another attempt is the one thing that must NOT become
  // an action: it would be a second fiat charge against one sats payment.
  if (repliesRequestsAnotherAttempt(reply.text)) {
    await deps.escalator.escalate(
      noticeForIntent(
        intent,
        deps.operatorNpub,
        `duplicate attempt requested by a reply ("${reply.text}"); refused, the adapter is not re-entered`,
        reply.at ?? now(),
        "duplicate_attempt",
      ),
    );
    return { outcome: "refused_attempt_request", intent };
  }

  const resolution = parseOperatorReply(reply.text);
  if (!resolution) return { outcome: "unknown_text", intent };

  const status: FiatIntentStatus = resolution === "refunded" ? "refunded" : intent.status;
  const next: FiatIntent = {
    ...intent,
    status,
    resolution: { kind: resolution, note: reply.eventId ?? "", at: reply.at ?? now() },
    updatedAt: Date.now(),
  };
  deps.store.put(next);
  return { outcome: "resolved", resolution, intent: next };
}

// ---------------------------------------------------------------------------
// bounded-window sweep
// ---------------------------------------------------------------------------

/** Statuses where the sats are FINAL but the fiat leg has not resolved. */
const UNRESOLVED_STATUSES: readonly FiatIntentStatus[] = [
  "sats_settled",
  "fiat_in_flight",
  "fiat_human_required",
];

export interface SweepResult {
  escalationsRetried: number;
  alertsRaised: number;
}

/**
 * Durable, idempotent safety net. Two jobs:
 *  1. A terminal failure whose DM never landed (`escalatedAt` unset) is re-escalated.
 *  2. An unresolved intent older than the bounded window raises an alert, once.
 * Both are recorded on the intent, so running the sweep twice emits nothing new.
 */
export async function sweepUnresolved(
  deps: Pick<FiatPathDeps, "store" | "escalator" | "operatorNpub" | "unresolvedWindowMs" | "now">,
): Promise<SweepResult> {
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.unresolvedWindowMs ?? 30 * 60_000;
  const out: SweepResult = { escalationsRetried: 0, alertsRaised: 0 };

  for (const intent of deps.store.list()) {
    if (intent.status === "fiat_failed_terminal" && !intent.escalatedAt) {
      const did = await escalateOnce(
        deps,
        intent.intentId,
        intent.failure?.message ?? "unknown",
        "fiat_failed_terminal",
        now,
      );
      if (did) out.escalationsRetried++;
      continue;
    }
    if (!UNRESOLVED_STATUSES.includes(intent.status)) continue;
    if (intent.alertAt) continue;
    if (now() - intent.updatedAt < windowMs) continue;
    await deps.escalator.escalate(
      noticeForIntent(
        intent,
        deps.operatorNpub,
        `unresolved for more than ${Math.round(windowMs / 60_000)} min in status ${intent.status}`,
        now(),
        "unresolved",
      ),
    );
    const after = deps.store.get(intent.intentId);
    if (after) deps.store.put({ ...after, alertAt: now(), updatedAt: Date.now() });
    out.alertsRaised++;
  }
  return out;
}
