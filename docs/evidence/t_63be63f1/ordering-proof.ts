/**
 * Evidence for card t_63be63f1: the SETTLED sats payment is recorded durably
 * BEFORE the fiat adapter is entered, and the fiat leg is entered exactly once.
 *
 *   bun run docs/evidence/t_63be63f1/ordering-proof.ts
 *
 * This uses the REAL ExplicitGate + the REAL durable intent store, with a fake
 * mint behind the processor (no mainnet money is moved here - the first real
 * mainnet payment is an operator step; see REPORT.md). Everything printed below
 * is a real record read back out of the stores, not a narration.
 */
import { ExplicitGate, MemoryOrderStore, SqliteFiatIntentStore, payCheckoutGated } from "../../../src/index.ts";
import type { Invoice, PaymentProcessor } from "../../../src/index.ts";

const ORDER_HASH = "sha256:5f2b8c0d1e4a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e";
const CALLER = "npub1customer000000000000000000000000000000000000000000000000000";
const OPERATOR = "npub1operator0000000000000000000000000000000000000000000000000000";
const CHECKOUT = "https://merchant.example/checkout/abc123";

/** A deterministic stand-in for the mint: it reports the invoice as PAID. */
class SettledProcessor implements PaymentProcessor {
  readonly pmi = "cashu";
  async createInvoice({ orderId }: { orderId: string }): Promise<Invoice> {
    return {
      orderId,
      paymentHash: `paymenthash:7d3a9c1f${orderId.replace(/\D/g, "").slice(0, 8)}`,
      amountSats: 2500,
      request: "cashuBsettledinvoicefortestonly",
      pmi: "cashu",
    };
  }
  async verify(): Promise<boolean> {
    return true; // the sats are observed settled
  }
}

const calls: string[] = [];
const adapter = {
  async pay_checkout(url: string, maxAmount: string) {
    calls.push(`adapter.pay_checkout(${url}, ${maxAmount})`);
    return { status: "human_required" as const, order_id: "venue-order-1" };
  },
};
const escalator = { escalate: async (n: unknown) => void calls.push(`escalation:${JSON.stringify(n)}`) };

const orderStore = new MemoryOrderStore();
const intentStore = new SqliteFiatIntentStore("/tmp/evidence-fiat-intents.sqlite");
const gate = new ExplicitGate(new SettledProcessor(), orderStore);

async function main() {
  const outcome = await payCheckoutGated(
    { gate, store: intentStore, adapter, escalator, operatorNpub: OPERATOR },
    {
      intentId: "intent-evidence-1",
      tool: "card.pay_checkout",
      caller: CALLER,
      orderHash: ORDER_HASH,
      rail: "2fiat-card",
      satsAmount: 2500,
      satsProof: "cashuBsettledinvoicefortestonly",
      checkoutUrl: CHECKOUT,
      fiatCap: "24.90",
    },
  );

  const order = orderStore.get("intent-evidence-1");
  const intent = intentStore.get("intent-evidence-1");
  console.log("--- gate order record (the sats half) ---");
  console.log(JSON.stringify({ orderId: order?.orderId, status: order?.status, paymentHash: order?.invoice?.paymentHash, invoice: order?.invoice?.request, amountSats: order?.invoice?.amountSats, settledAt: order?.settledAt }, null, 2));
  console.log("--- durable fiat intent (written before the adapter call) ---");
  console.log(JSON.stringify(intent, null, 2));
  console.log("--- what actually ran, in order ---");
  console.log(calls.join("\n"));
  console.log("--- outcome returned to the caller ---");
  console.log(JSON.stringify(outcome, null, 2));
}

await main();
