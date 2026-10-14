/**
 * RED/PRE-FIX evidence probe for the settled-replay proof-binding hole (t_5b30bdec).
 *
 * Prints, for each scenario, WHAT THE GATE ACTUALLY RETURNS today. Run it before
 * the fix to see the defect (a refused-looking scenario returns the cached
 * result) and after the fix to see the same probe refuse. It asserts nothing, so
 * the same script is valid evidence on both sides of the change.
 *
 *   bun run evidence/replay_proof_binding.red.ts
 *
 * The processor below is a *proof-consuming* one (CEP-8 Cashu semantics, same
 * shape as src/cashu.ts: `verify` returns true only for a valid, unspent proof),
 * so "a different proof" is a proof that never paid this order.
 */
import { createHash } from "node:crypto";
import { ExplicitGate, type Invoice, type PaymentProcessor } from "../src/payment.ts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

class ProofProcessor implements PaymentProcessor {
  readonly pmi = "bitcoin-cashu";
  constructor(private readonly valid: string[]) {}
  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return {
      orderId: a.orderId,
      paymentHash: `cashu:${a.orderId}`,
      amountSats: a.amountSats,
      request: `cashu:https://mint.example:${a.amountSats}`,
      pmi: this.pmi,
    };
  }
  async verify(_i: Invoice, proof?: string): Promise<boolean> {
    return proof !== undefined && this.valid.includes(proof);
  }
}

const call = (gate: ExplicitGate, orderId: string, proof: string | undefined, tag: string) => ({
  tool: "tool:paid_work",
  caller: "npub1payer",
  amountSats: 21,
  orderId,
  proof,
  run: async () => `${tag}-result`,
});

async function attempt(label: string, fn: () => Promise<unknown>) {
  try {
    const value = await fn();
    console.log(`  ${label}\n    RETURNED  ${JSON.stringify(value)}`);
  } catch (e: any) {
    console.log(`  ${label}\n    REFUSED   ${e?.name ?? "Error"}: ${e?.message ?? e}`);
  }
}

console.log("scenario 1: order o-1 settled with proof token-A");
{
  const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
  const first = await gate.gate(call(gate, "o-1", "token-A", "paid"));
  console.log(`  first call (token-A): RETURNED ${JSON.stringify(first)}`);
  await attempt("replay with a DIFFERENT proof (token-B)", () =>
    gate.gate(call(gate, "o-1", "token-B", "replayed")),
  );
  await attempt("replay with NO proof at all", () => gate.gate(call(gate, "o-1", undefined, "replayed")));
  await attempt("replay with a VALID proof that paid ANOTHER order (token-C)", () =>
    gate.gate(call(gate, "o-1", "token-C", "replayed")),
  );
}

console.log("scenario 2: order o-2 settled with proof token-A, then a valid-but-other-order token");
{
  const gate = new ExplicitGate(new ProofProcessor(["token-A", "token-C"]));
  await gate.gate(call(gate, "o-2", "token-A", "paid"));
  await gate.gate(call(gate, "o-3", "token-C", "other-order"));
  await attempt("replay of o-2 with token-C (valid, but paid o-3)", () =>
    gate.gate(call(gate, "o-2", "token-C", "replayed")),
  );
}

console.log("scenario 3: order o-4 settled by an invoice (no client proof presented)");
{
  const gate = new ExplicitGate(new ProofProcessor(["token-A"]));
  // The order is settled the way a Lightning-poll processor settles: the
  // processor accepts without any proof. Model it by pre-seeding an invoice that
  // this processor treats as paid - reuse ProofProcessor but settle via a
  // processor that ignores proofs.
  void gate;
  const polling: PaymentProcessor = {
    pmi: "bitcoin-lightning-bolt11",
    createInvoice: async (a) => ({
      orderId: a.orderId,
      paymentHash: `ln-${a.orderId}`,
      amountSats: a.amountSats,
      request: `lnbc${a.amountSats}`,
      pmi: "bitcoin-lightning-bolt11",
    }),
    verify: async () => true,
  };
  const g2 = new ExplicitGate(polling);
  console.log(
    `  first call (no proof): RETURNED ${JSON.stringify(await g2.gate(call(g2, "o-4", undefined, "paid")))}`,
  );
  await attempt("replay of a no-proof order WITH a proof attached", () =>
    g2.gate(call(g2, "o-4", "token-A", "replayed")),
  );
  await attempt("replay of a no-proof order with no proof", () =>
    g2.gate(call(g2, "o-4", undefined, "replayed")),
  );
}

console.log(`\nproof hash of token-A: ${hash("token-A")}, token-B: ${hash("token-B")}, token-C: ${hash("token-C")}`);
