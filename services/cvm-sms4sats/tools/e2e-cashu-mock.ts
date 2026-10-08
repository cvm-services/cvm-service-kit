/**
 * End-to-end reseller proof WITHOUT the ContextVM transport: a mock upstream
 * issues a real Cashu mint-quote BOLT11, and the wrapper's Cashu treasury melts
 * it (real NUT-05 path) to satisfy the L402 challenge.
 *
 *   CASHU_TEST_MINT=https://testnut.cashu.exchange bun \
 *     services/cvm-sms4sats/tools/e2e-cashu-mock.ts
 *
 * Uses a fakewallet mint (free funding), so no real value moves. Exits non-zero
 * on failure.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CashuLnWallet,
  SqliteOrderStore,
  Treasury,
} from "../../../src/index.ts";
import { startMockL402 } from "../../_shared/mock-l402.ts";
import { Sms4SatsClient } from "../src/upstream.ts";
import { buildSmsTools, type SmsDeps } from "../src/tools.ts";

const MINT = process.env.CASHU_TEST_MINT ?? "https://testnut.cashu.exchange";
const PRICE = Number(process.env.PRICE_SATS ?? "25");

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "cashu-e2e-"));
  // Upstream wallet: mints the invoice the 402 challenge carries.
  const upstream = new CashuLnWallet({
    mintUrl: MINT,
    seed: new Uint8Array(32).fill(1),
    dbPath: join(dir, "upstream.sqlite"),
  });
  // Treasury wallet: funded for free on the fakewallet mint; pays the invoice.
  const treasuryWallet = new CashuLnWallet({
    mintUrl: MINT,
    seed: new Uint8Array(32).fill(2),
    dbPath: join(dir, "treasury.sqlite"),
  });
  const funded = await treasuryWallet.fund(PRICE + 50, { intervalMs: 1500, attempts: 20 });
  console.log(`treasury funded: ${funded.balanceSats} sats`);

  const mock = startMockL402({
    invoiceFactory: async () => {
      const inv = await upstream.makeInvoice(PRICE);
      return { invoice: inv.bolt11, priceSats: PRICE };
    },
  });

  const deps: SmsDeps = {
    client: new Sms4SatsClient({ baseUrl: mock.url }),
    wallet: treasuryWallet,
    treasury: new Treasury(treasuryWallet, { floorSats: 0 }),
    orders: new SqliteOrderStore(join(dir, "orders.sqlite")),
    pricing: { markup: 0.2, minSats: 1 },
    poll: { intervalMs: 50, attempts: 10 },
  };
  const tool = buildSmsTools(deps).find((t) => t.definition.name === "create_sms_order")!;

  try {
    const r: any = await tool.handler(
      { service: "tg", country: "US", order_id: "cashu-e2e-1", refund_invoice: "lnbc1test" },
      { caller: "npub1e2e" },
    );
    console.log("result:", JSON.stringify(r));
    if (r?.code !== "1234") throw new Error("unexpected result");
    console.log("E2E_CASHU_MOCK_OK");
  } finally {
    mock.stop();
  }
}

main().catch((e) => {
  console.error("E2E_CASHU_MOCK_FAIL:", e?.message ?? e);
  process.exit(1);
});
