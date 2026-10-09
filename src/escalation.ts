/**
 * escalation.ts — the ADR-0012 escalation path of the fiat settlement machine.
 *
 * This is NOT a logging helper. When the fiat leg fails terminally (or a
 * duplicate attempt is detected), the CVM — remember, the CVM is the actor, not
 * an inbox someone watches — emits a Nostr DM to ITS OWN OPERATOR identity
 * (cvm-2fiat's `OWNER_NPUB_HEX`, the same key `assertOwner()` already gates
 * `card.balance` on; no second npub is created to rotate and lose).
 *
 * Rules encoded here, each with a test:
 *
 *  1. Hashes and ids ONLY. No PAN, no CVV, no expiry, no session token, no
 *     OTP — ever. A caller-supplied failure string is scanned and the escalation
 *     is REFUSED rather than sent if it is credential-shaped.
 *  2. One terminal intent = one DM. The bookkeeping is durable (`escalatedAt`,
 *     `escalationRef`), so a restart cannot re-escalate.
 *  3. A DM reply is an INPUT that updates durable state — never an action. The
 *     accepted vocabulary is closed; "retry"/"pay again" is explicitly NOT a
 *     resolution, because acting on it would be a second fiat attempt.
 *  4. The DM is a notification, never a replay barrier: the durable intent store
 *     and the gate's order store are the barriers. A replayed DM changes nothing.
 */
import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";
import type { Event } from "nostr-tools";
import type { FiatIntent, FiatResolutionKind } from "./fiat-intent.ts";

export type FiatEscalationKind = "fiat_failed_terminal" | "duplicate_attempt" | "unresolved";

export interface FiatEscalationNotice {
  kind: FiatEscalationKind;
  /** Intent id + order hash + sats proof + rail + amount + fiat cap + what failed. */
  intentId: string;
  orderHash: string;
  satsProof: string;
  rail: string;
  amountSats: number;
  fiatCap: string;
  whatFailed: string;
  /** Operator pubkey (hex) — the CVM's OWNER_NPUB_HEX identity. */
  recipient: string;
  at: number;
  /** ISO-8601 timestamp of the failure/observation, for the operator's timeline. */
  resolutionHint: string;
}

export interface Escalator {
  escalate(notice: FiatEscalationNotice): Promise<{ ref: string }>;
}

const MEDIATED_REPLY_VOCABULARY =
  "Reply with one of: refunded | refund pending | abandoned | acknowledged. " +
  "A reply updates this intent's durable state; it never re-runs the fiat leg.";

// ---------------------------------------------------------------------------
// rule 1: no card material, ever
// ---------------------------------------------------------------------------

const PAN_RE = /\b(?:\d[ -]?){13,19}\b/g;
const CVV_RE = /\b(?:cvv|cvc|csc|security code)\D{0,8}\d{3,4}\b/gi;

/**
 * True when `text` is credential-shaped. Deliberately over-broad: a false
 * positive here costs one refused escalation, a false negative costs a PAN in a
 * Nostr relay.
 */
export function looksLikeCardMaterial(text: string): boolean {
  PAN_RE.lastIndex = 0;
  CVV_RE.lastIndex = 0;
  const digitsOnly = text.replace(/\D/g, "");
  if (PAN_RE.test(text) && digitsOnly.length >= 13) return true;
  CVV_RE.lastIndex = 0;
  return CVV_RE.test(text);
}

export class CardMaterialInEscalationError extends Error {
  constructor(readonly field: string) {
    super(
      `refusing to escalate: ${field} is credential-shaped. The escalation DM carries hashes and ids only.`,
    );
    this.name = "CardMaterialInEscalationError";
  }
}

/**
 * Strip credential-shaped runs out of free text BEFORE it becomes a DM. An
 * upstream error message is not a trusted channel: one adapter traceback that
 * embeds a card number must not put a PAN on a public relay. Belt and braces —
 * `assertNoCardMaterial` still runs on the finished notice.
 */
export function redactCardMaterialFromText(text: string): string {
  PAN_RE.lastIndex = 0;
  CVV_RE.lastIndex = 0;
  return text.replace(PAN_RE, "[redacted:card-shaped]").replace(CVV_RE, "[redacted:cvv]");
}

/** Throw rather than transmit anything card-shaped. */
export function assertNoCardMaterial(notice: FiatEscalationNotice): void {
  if (looksLikeCardMaterial(notice.whatFailed)) {
    throw new CardMaterialInEscalationError("whatFailed");
  }
  if (looksLikeCardMaterial(notice.intentId)) {
    throw new CardMaterialInEscalationError("intentId");
  }
}

// ---------------------------------------------------------------------------
// rule 3: the closed reply vocabulary
// ---------------------------------------------------------------------------

export function parseOperatorReply(text: string): FiatResolutionKind | null {
  const t = text.trim().toLowerCase();
  if (/(^|\W)refund\s*pending(\W|$)/.test(t)) return "refund_pending";
  if (/(^|\W)refunded(\W|$)/.test(t)) return "refunded";
  if (/(^|\W)abandoned(\W|$)/.test(t)) return "abandoned";
  if (/(^|\W)acknowledged(\W|$)/.test(t)) return "acknowledged";
  return null;
}

const ATTEMPT_REQUEST_RE = /\b(retry|re-?try|pay again|repay|attempt again|charge again)\b/i;

/**
 * A reply that asks for another attempt. This is never a resolution: acting on
 * it would spend a second fiat action against one sats payment. The caller
 * records a `duplicate_attempt` escalation and does NOT touch the adapter.
 */
export function repliesRequestsAnotherAttempt(text: string): boolean {
  return ATTEMPT_REQUEST_RE.test(text);
}

// ---------------------------------------------------------------------------
// emitters
// ---------------------------------------------------------------------------

/** Emits one gift-wrapped (NIP-44, kind 1059) DM to the operator pubkey. */
export class NostrDmEscalator implements Escalator {
  constructor(
    private readonly opts: {
      secretKey: Uint8Array;
      /** Provide e.g. `server.sendDirectMessage`. */
      publish: (event: Event) => Promise<unknown>;
      /** Overridable for tests. */
      now?: () => number;
    },
  ) {}

  async escalate(notice: FiatEscalationNotice): Promise<{ ref: string }> {
    assertNoCardMaterial(notice);
    const now = Math.floor((this.opts.now?.() ?? Date.now()) / 1000);
    const inner = finalizeEvent(
      {
        kind: 14,
        created_at: now,
        tags: [["p", notice.recipient]],
        content: JSON.stringify({ ...notice, resolutionHint: MEDIATED_REPLY_VOCABULARY }),
      },
      this.opts.secretKey,
    );
    const wrapSk = new Uint8Array(32);
    crypto.getRandomValues(wrapSk);
    const convKey = nip44.v2.utils.getConversationKey(wrapSk, notice.recipient);
    const encrypted = nip44.v2.encrypt(JSON.stringify(inner), convKey);
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: now,
        tags: [["p", notice.recipient]],
        content: encrypted,
        pubkey: getPublicKey(wrapSk),
      } as Parameters<typeof finalizeEvent>[0],
      wrapSk,
    );
    await this.opts.publish(wrap);
    return { ref: wrap.id };
  }
}

/** Test/ops double: records notices instead of touching a relay. */
export class RecordingEscalator implements Escalator {
  readonly notices: FiatEscalationNotice[] = [];
  async escalate(notice: FiatEscalationNotice): Promise<{ ref: string }> {
    assertNoCardMaterial(notice);
    this.notices.push(notice);
    return { ref: `rec-${this.notices.length}` };
  }
}

/** Build the notice for a terminal fiat intent. */
export function noticeForIntent(
  intent: FiatIntent,
  operatorNpub: string,
  whatFailed: string,
  at = Date.now(),
  kind: FiatEscalationKind = "fiat_failed_terminal",
): FiatEscalationNotice {
  return {
    kind,
    intentId: intent.intentId,
    orderHash: intent.orderHash,
    satsProof: intent.satsProof,
    rail: intent.rail,
    amountSats: intent.satsAmount,
    fiatCap: intent.fiatCap,
    whatFailed: redactCardMaterialFromText(whatFailed),
    recipient: operatorNpub,
    at,
    resolutionHint: MEDIATED_REPLY_VOCABULARY,
  };
}
