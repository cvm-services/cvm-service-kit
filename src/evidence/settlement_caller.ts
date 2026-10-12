/**
 * One caller, one intent, one OS process - the "at most one fiat attempt" demo
 * for card t_89dcb160.
 *
 * Spawned by src/evidence/one_payment_one_attempt.ts, exactly like independent
 * control-plane processes. Takes ONE shot:
 *   attempt  - this caller won and (really) ran the fiat leg
 *   replay   - the intent was already settled/reserved: no attempt
 *   conflict - the binding did not match: refused, no attempt
 *   proof    - this payment proof already settled another intent
 *   required - the sats are not final: payment_required
 *   error:*  - anything else
 *
 * Not a test file: `bun test` does not collect this name.
 */
import { SqliteIntentStore, type IntentBinding } from "../intent-store.ts";
import { FiatSettlementMachine, type FinalReceipt } from "../settlement.ts";
import { SettlementInProgressError, SettlementFailedError, PaymentRequiredError } from "../payment.ts";
import { IntentConflictError, ProofReuseError } from "../intent-store.ts";
import { appendFileSync } from "node:fs";

const [dbPath, intentId, bindingJson, attemptLog, startAtArg] = process.argv.slice(2);
const startAt = Number(startAtArg);

const binding = JSON.parse(bindingJson) as IntentBinding;
const store = new SqliteIntentStore(dbPath);
const machine = new FiatSettlementMachine(store);

// Common start barrier: without it the first process finishes before the rest
// have opened the file and the "race" would be a fiction.
while (Date.now() < startAt) await Bun.sleep(1);

const settle = async (): Promise<FinalReceipt> => ({
  pmi: binding.pmi,
  proofRef: "proof-ref",
  amountSats: binding.amountSats,
  settledAt: Date.now(),
});

let outcome: string;
let attempted = false;
try {
  await machine.run({
    intentId,
    binding,
    proof: "shared-cashu-token",
    settle,
    run: async () => {
      attempted = true;
      // the fiat leg: append to the shared log so the driver can count attempts.
      // Held briefly so the callers genuinely contend instead of finishing in
      // sequence (a race that never overlaps would prove nothing).
      appendFileSync(attemptLog, `FIAT_ATTEMPT ${intentId} ${process.pid}\n`);
      await Bun.sleep(250);
      return "fiat-ok";
    },
  });
  outcome = attempted ? "attempt" : "replay";
} catch (e) {
  outcome =
    e instanceof PaymentRequiredError
      ? "required"
      : e instanceof IntentConflictError
        ? "conflict"
        : e instanceof ProofReuseError
          ? "proof"
          : e instanceof SettlementInProgressError
            ? "replay"
            : e instanceof SettlementFailedError
              ? "failed"
              : `error:${(e as Error).message}`;
}

store.close();
console.log(outcome);
