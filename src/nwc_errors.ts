// Honest NWC failure reporting.
//
// Two measured incidents motivated this module (fleet broker, 2026-10-18):
//
//   1. `pay_invoice` timed out while the broker HAD paid. The client's message was
//      "NWC pay_invoice timed out", which reads as failure. A caller retrying it
//      would pay twice. Measured: balance 20002 -> 19874.
//
//   2. The reply handler discarded undecryptable replies silently
//      (`catch { /* ignore undecryptable events */ }`), so a valid answer using an
//      unexpected scheme was indistinguishable from no answer at all.
//
// Both are the same class of bug: a failure that looks like something else. The
// types here make the distinction impossible to lose.

/** Methods that can MOVE money: a timeout on these is an unknown outcome. */
const SPENDING_METHODS = new Set(["pay_invoice", "pay_keysend"]);

export class NwcTimeout extends Error {
  readonly method: string;
  readonly detail: string;

  constructor(method: string, detail: string) {
    super(`NWC ${method} timed out (${detail})`);
    this.name = "NwcTimeout";
    this.method = method;
    this.detail = detail;
  }

  /**
   * True when the request could have spent money but we cannot tell whether it did.
   * Callers MUST NOT retry when this is true.
   */
  get outcomeUnknown(): boolean {
    return SPENDING_METHODS.has(this.method);
  }
}

export class NwcErrorReply extends Error {
  readonly method: string;
  readonly code: string;

  constructor(method: string, code: string, message: string) {
    super(`NWC error: ${message}`);
    this.name = "NwcErrorReply";
    this.method = method;
    this.code = code;
  }

  /** The broker answered and refused — that is a definite outcome. */
  get outcomeUnknown(): boolean {
    return false;
  }
}

export interface NwcAttemptContext {
  /** How many kind:23195 events the client actually saw before giving up. */
  eventsSeen: number;
  /** Which scheme successfully decrypted, if any. */
  decryptScheme?: "nip04" | "nip44" | "none";
}

/**
 * A diagnostic that distinguishes the three failure shapes, because "it timed out"
 * has cost this fleet several debugging sessions and one double-pay hazard.
 */
export function describeNwcFailure(e: NwcTimeout, ctx: NwcAttemptContext): string {
  const parts: string[] = [];

  if (e.outcomeUnknown) {
    parts.push(
      `OUTCOME UNKNOWN for ${e.method}: the wallet may already have executed it — do not retry ` +
        `(retrying can double-spend).`,
    );
  } else {
    parts.push(`NWC ${e.method} did not answer; this call cannot move money, so it is safe to retry.`);
  }

  if (ctx.eventsSeen === 0) {
    parts.push(
      `no reply events were seen on the relay — the wallet did not publish, or published after the window.`,
    );
  } else if (ctx.decryptScheme === "none") {
    parts.push(
      `${ctx.eventsSeen} reply event(s) arrived but are undecryptable — could not decrypt with either nip04 or nip44 — ` +
        `the wallet is replying with a scheme this client does not understand. This is NOT silence.`,
    );
  } else {
    parts.push(`${ctx.eventsSeen} reply event(s) seen (decrypted via ${ctx.decryptScheme}).`);
  }

  return parts.join(" ");
}
