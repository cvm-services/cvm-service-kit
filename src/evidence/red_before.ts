/**
 * RED-BEFORE evidence for card t_89dcb160.
 *
 * Shows, against the code as it stands (ExplicitGate + MemoryOrderStore, i.e.
 * the PR #13 money-safety fix and nothing more), the exact money leak the
 * durable binding closes:
 *
 *   one 100-sat invoice, re-used with the same order id, funds a 500-sat fiat
 *   attempt by a DIFFERENT caller for a DIFFERENT order.
 *
 * Run:  bun run src/evidence/red_before.ts
 * Exit: 0 when the leak is closed (the intent machine refuses), 1 when the
 *       leak is present.
 */
import {
  ExplicitGate,
  MemoryOrderStore,
  PaymentRequiredError,
  type Invoice,
  type PaymentProcessor,
} from "../payment.ts";

class FakeProcessor implements PaymentProcessor {
  readonly pmi = "pmi:fake";
  paid = false;
  invoices = 0;
  async createInvoice(a: {
    tool: string;
    orderId: string;
    amountSats: number;
    caller: string;
  }): Promise<Invoice> {
    this.invoices++;
    return {
      orderId: a.orderId,
      paymentHash: "hash-" + a.orderId,
      amountSats: a.amountSats,
      request: "lnbc-fake-" + a.orderId,
      pmi: this.pmi,
    };
  }
  async verify(): Promise<boolean> {
    return this.paid;
  }
}

const processor = new FakeProcessor();
const gate = new ExplicitGate(processor, new MemoryOrderStore());

let fiatAttempts = 0;
const orderId = "order-abc";

// 1. The legitimate intent: a 100-sat payment for a 100-sat order. Not paid yet.
try {
  await gate.gate({
    tool: "card.balance",
    caller: "npub1alice",
    amountSats: 100,
    orderId,
    run: async () => {
      fiatAttempts++;
      return "first";
    },
  });
  console.log("unexpected: the unpaid call did not throw PaymentRequiredError");
  process.exit(2);
} catch (e) {
  if (!(e instanceof PaymentRequiredError)) throw e;
  console.log(`[red] unpaid 100-sat call refused as expected (invoice #1, ${e.data.amountSats} sats)`);
}

// 2. The attack: same order id, DIFFERENT caller, DIFFERENT tool, 500 sats.
processor.paid = true; // the 100-sat invoice is now the only thing that settled
try {
  const out = await gate.gate({
    tool: "card.pay",
    caller: "npub1mallory",
    amountSats: 500,
    orderId,
    proof: "proof-x",
    run: async () => {
      fiatAttempts++;
      return "second";
    },
  });
  console.log(`[red] mismatched re-use was ACCEPTED (result=${JSON.stringify(out)})`);
} catch (e) {
  console.log(`[red] mismatched re-use refused: ${(e as Error).name}: ${(e as Error).message}`);
}

console.log(`[red] invoices minted: ${processor.invoices}; fiat attempts: ${fiatAttempts}`);

if (fiatAttempts > 0) {
  console.log(
    `LEAK PRESENT: one settlement produced ${fiatAttempts} fiat attempt(s) and the ` +
      "binding (caller/tool/amount/order) was not checked",
  );
  process.exit(1);
}
console.log("LEAK CLOSED: the mismatched re-use never reached the action");
process.exit(0);
