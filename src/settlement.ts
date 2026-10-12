/**
 * Fiat settlement state machine (card t_89dcb160).
 *
 * `ExplicitGate` (PR #13) fixed the double-attempt and made failure terminal,
 * but it binds nothing to the order id and trusts the processor's boolean. This
 * machine is the minimum-safe path for real fiat:
 *
 *   1. durable intents bound to tool + caller + order hash + sats + pmi +
 *      quote + fiat cap (re-use with a different binding is refused);
 *   2. `awaiting_payment -> settled_reserved` exactly once, atomically, with a
 *      durable proof-reuse barrier in the same transaction;
 *   3. terminal failure states; a paid intent whose action failed is never
 *      retried into a second attempt (and a crash leaves it reserved, which is
 *      also non-retryable);
 *   4. a return value that is a PROCESSOR-FINAL receipt or nothing: for
 *      Lightning the preimage must hash to the payment hash (local decoding has
 *      no preimage); for Cashu the mint must report the proofs SPENT after the
 *      atomic redeem. A decoder cannot produce either.
 */
import type { PaymentIntent, IntentBinding, IntentStore } from "./intent-store.ts";
import {
  assertBindingMatches,
  IntentTerminalError,
  ProofReuseError,
  sha256Hex,
} from "./intent-store.ts";
import { PaymentRequiredError, SettlementFailedError, SettlementInProgressError } from "./payment.ts";

/** The processor's final, non-reversible receipt for a payment. */
export interface FinalReceipt {
  pmi: string;
  /** A reference that only a settled payment can produce (preimage, mint swap id). */
  proofRef: string;
  amountSats: number;
  /** Present for Lightning: the preimage must hash to this payment hash. */
  paymentHash?: string;
  settledAt: number;
}

/** The settle() port: resolves undefined when the payment is NOT final. */
export type Settle = () => Promise<FinalReceipt | undefined>;

/** A receipt that does not match what the intent was paying for. */
export class ReceiptMismatchError extends Error {
  readonly code = -32009;
  constructor(readonly intentId: string, readonly detail: string) {
    super(`receipt_mismatch: ${detail}`);
    this.name = "ReceiptMismatchError";
  }
}

export interface SettlementMachineOptions {
  /**
   * Called (awaited) when the sats are final and the downstream action failed.
   * This is the ADR-0012 escalation hook: it must be durable, not a log line.
   */
  escalate?: (args: {
    intentId: string;
    kind: "fiat_action_failed";
    reason: string;
    intent: PaymentIntent;
  }) => void | Promise<void>;
  now?: () => number;
}

export interface SettleArgs<T> {
  intentId: string;
  binding: IntentBinding;
  /** Client-supplied payment proof (Cashu token). Hashed before it is stored. */
  proof?: string;
  settle: Settle;
  run: () => Promise<T>;
}

export class FiatSettlementMachine {
  constructor(
    private readonly store: IntentStore,
    private readonly opts: SettlementMachineOptions = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  async run<T>(args: SettleArgs<T>): Promise<T> {
    const { intentId, binding } = args;

    let intent = this.store.get(intentId);
    if (!intent) {
      const t = this.now();
      const created: PaymentIntent = {
        intentId,
        ...binding,
        status: "awaiting_payment",
        createdAt: t,
        updatedAt: t,
      };
      // Two concurrent first-callers: one INSERT wins, the other re-reads. The
      // loser must still be binding-checked against what landed.
      intent = this.store.create(created) ? created : this.store.get(intentId);
      if (!intent) throw new Error("intent vanished between insert and read");
    }
    // The single check that makes a mismatched re-use impossible: wrong caller,
    // wrong tool, changed amount/order/quote/cap all land here.
    assertBindingMatches(intent, binding, intent.intentId);

    switch (intent.status) {
      case "settled":
        // Replay of a settled intent: the cached result, never a second run.
        return intent.result as T;
      case "settlement_failed":
        throw new SettlementFailedError(intent.intentId, intent.failure?.message ?? "unknown");
      case "refunded":
        throw new IntentTerminalError(intent.intentId, "refunded");
      case "settled_reserved":
        // Either another caller holds the claim, or a previous process died
        // mid-action. Both are non-retryable: the sats are already final.
        throw new SettlementInProgressError(intent.intentId);
      case "awaiting_payment":
        break;
    }

    const receipt = await args.settle();
    if (!receipt) {
      throw new PaymentRequiredError("payment_required", {
        orderId: intent.intentId,
        invoice: binding.quote,
        amountSats: binding.amountSats,
        paymentHash: sha256Hex(binding.quote),
        pmi: binding.pmi,
      });
    }
    assertFinalReceipt(receipt, binding);

    // Claim + proof barrier in ONE transaction. On any loss the claim is rolled
    // back, so a refusal can never consume the proof.
    const proofHash = args.proof ? sha256Hex(args.proof) : undefined;
    const outcome = this.store.reserve(intent.intentId, "awaiting_payment", "settled_reserved", proofHash);
    if (outcome === "proof_spent") throw new ProofReuseError(proofHash!, this.store.proofSpentBy(proofHash!) ?? "?");
    if (outcome !== "won") throw new SettlementInProgressError(intent.intentId);

    try {
      const result = await args.run();
      this.store.finish(intent.intentId, "settled", { result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Terminal, durable, and written BEFORE the escalation so a crash while
      // notifying cannot leave the intent retryable.
      this.store.finish(intent.intentId, "settlement_failed", {
        failure: { message, at: this.now() },
      });
      const failed = this.store.get(intent.intentId)!;
      await this.opts.escalate?.({
        intentId: intent.intentId,
        kind: "fiat_action_failed",
        reason: message,
        intent: failed,
      });
      throw err;
    }
  }
}

/**
 * A receipt is only accepted if it is processor-final AND matches the intent's
 * binding. An underpaid or wrong-processor receipt is refused, not rounded.
 */
export function assertFinalReceipt(receipt: FinalReceipt, binding: IntentBinding): void {
  if (!receipt.proofRef) {
    throw new ReceiptMismatchError(binding.tool, "no proof reference");
  }
  if (receipt.pmi !== binding.pmi) {
    throw new ReceiptMismatchError(
      binding.tool,
      `processor ${receipt.pmi} != bound ${binding.pmi}`,
    );
  }
  if (!Number.isFinite(receipt.amountSats) || receipt.amountSats < binding.amountSats) {
    throw new ReceiptMismatchError(
      binding.tool,
      `paid ${receipt.amountSats} sats < required ${binding.amountSats}`,
    );
  }
  if (receipt.paymentHash !== undefined && !verifyPreimage(receipt.proofRef, receipt.paymentHash)) {
    throw new ReceiptMismatchError(binding.tool, "preimage does not match the payment hash");
  }
}

/** sha256(preimage) === paymentHash. Only a settled payment can supply this. */
export function verifyPreimage(preimageHex: string, paymentHashHex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(preimageHex) || !/^[0-9a-fA-F]{64}$/.test(paymentHashHex)) {
    return false;
  }
  return sha256Hex(preimageHex.toLowerCase()) === paymentHashHex.toLowerCase();
}

/**
 * Lightning receipt: undefined unless the wallet actually SETTLED/CLAIMED the
 * invoice and produced the preimage. Decoding a BOLT11 gives the payment hash
 * but never the preimage, so a decoder cannot forge this.
 */
export function lightningFinalReceipt(
  invoice: { paymentHash: string; amountSats: number; pmi?: string },
  claimed: { preimage: string } | undefined,
  now: number = Date.now(),
): FinalReceipt | undefined {
  if (!claimed?.preimage) return undefined;
  if (!verifyPreimage(claimed.preimage, invoice.paymentHash)) return undefined;
  return {
    pmi: invoice.pmi ?? "lightning",
    proofRef: claimed.preimage.toLowerCase(),
    amountSats: invoice.amountSats,
    paymentHash: invoice.paymentHash,
    settledAt: now,
  };
}

/**
 * Cashu receipt: undefined unless the token was atomically redeemed AT THE MINT
 * (the swap is what spends the proofs) and the mint reports them markably spent.
 * A locally decoded token - signature valid, amount correct - cannot produce
 * this, which is exactly the card's "local decoding is insufficient".
 */
export function cashuFinalReceipt(args: {
  pmi?: string;
  amountSats: number;
  proofHash: string;
  /** NUT-07 state of the token's proofs AFTER the redeem attempt. */
  mintReportedSpent: boolean;
  /** sats the redeem actually returned, when known. */
  redeemedSats?: number;
  now?: number;
}): FinalReceipt | undefined {
  if (!args.mintReportedSpent) return undefined;
  if (args.redeemedSats !== undefined && args.redeemedSats < args.amountSats) return undefined;
  return {
    pmi: args.pmi ?? "bitcoin-cashu",
    proofRef: args.proofHash,
    amountSats: args.amountSats,
    settledAt: args.now ?? Date.now(),
  };
}
