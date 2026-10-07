import {
  CashuProcessor,
  CvmServer,
  ExplicitGate,
  SqliteOrderStore,
  Treasury,
  markupForMargin,
  publishAnnouncement,
  pubkeyHexOf,
  secretKeyFrom,
  walletFromEnv,
  type PaymentProcessor,
} from "../../../src/index.ts";
import { startHealthServer } from "../../_shared/health.ts";
import { resolveDeployedCommit, resolveDeployedRef } from "../../_shared/start.ts";
import { Sms4SatsClient } from "./upstream.ts";
import { buildSmsTools, treasuryHealthReport, type SmsDeps } from "./tools.ts";

const RELAYS_DEFAULT = [
  "wss://nostr.mom",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay2.contextvm.org",
  "wss://relay2.orangesync.tech",
];

interface Config {
  secretKey: string;
  relays: string[];
  nwcUrl?: string;
  margin: number;
  minPriceSats: number;
  floorSats: number;
  paymentMode: "cashu" | "none";
  cashuMintUrl: string;
  orderDb: string;
  announce: boolean;
  d: string;
  serviceClass: string;
  sms4satsBase: string;
}

/** PAYMENT_MODE=none refuses every payment rather than faking settlement. */
class FakeProcessorNone {
  readonly pmi = "none";
  async createInvoice(a: { orderId: string; amountSats: number }) {
    throw new Error("payment mode none: refusing to mint a client invoice");
  }
  async verify(): Promise<boolean> {
    return false;
  }
}

function configFromEnv(env: Record<string, string | undefined>): Config {
  const secretKey = env.SERVER_SECRET_KEY ?? env.SERVER_HEX;
  if (!secretKey) throw new Error("SERVER_SECRET_KEY is required (64 hex chars)");
  return {
    secretKey,
    relays: (env.RELAYS ?? RELAYS_DEFAULT.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    nwcUrl: env.NWC_URL,
    margin: Number(env.MARGIN ?? "0.2"),
    minPriceSats: Number(env.MIN_PRICE_SATS ?? "1"),
    floorSats: Number(env.TREASURY_FLOOR_SATS ?? "1000"),
    paymentMode: (env.PAYMENT_MODE as Config["paymentMode"]) ?? "cashu",
    cashuMintUrl: env.CASHU_MINT_URL ?? "https://testnut.cashu.exchange",
    orderDb: env.ORDER_DB ?? "/var/lib/loom/cvm-sms4sats/orders.sqlite",
    announce: (env.ANNOUNCE ?? "true") !== "false",
    d: env.ANNOUNCE_D ?? "cvm-sms4sats-01",
    serviceClass: env.SERVICE_CLASS ?? "sms",
    sms4satsBase: env.SMS4SATS_BASE ?? "https://api.sms4sats.com",
  };
}

async function main() {
  const cfg = configFromEnv(process.env);
  const sk = secretKeyFrom(cfg.secretKey);

  // Real wallet or NO wallet — never a fake one in production. With no rail
  // configured the paid path refuses rail_unavailable and availability/health
  // report the rail as unavailable instead of a fabricated balance.
  const sel = walletFromEnv({ NWC_URL: cfg.nwcUrl });
  if (!sel.real) {
    console.error(
      "[cvm-sms4sats] WARNING: no NWC_URL — treasury rail unavailable; paid tools will refuse rail_unavailable",
    );
  }

  const treasury = new Treasury(sel.wallet, { floorSats: cfg.floorSats });
  const orders = new SqliteOrderStore(cfg.orderDb);
  const processor: PaymentProcessor =
    cfg.paymentMode === "cashu"
      ? new CashuProcessor({ mintUrl: cfg.cashuMintUrl })
      : (new FakeProcessorNone() as unknown as PaymentProcessor);
  const gate = new ExplicitGate(processor);
  const client = new Sms4SatsClient({ baseUrl: cfg.sms4satsBase });

  const tools = buildSmsTools({
    client,
    wallet: sel.wallet,
    treasury,
    orders,
    pricing: { markup: markupForMargin(cfg.margin), minSats: cfg.minPriceSats },
    gate,
    rail: sel.rail,
  });

  const server = new CvmServer({
    secretKey: sk,
    relays: cfg.relays,
    name: "cvm-sms4sats",
    tools,
    onLog: (l) => console.error(`[cvm-sms4sats] ${l}`),
  });
  await server.start();
  console.log(`[cvm-sms4sats] pubkey: ${pubkeyHexOf(sk)}`);

  const healthPort = Number(process.env.HEALTH_PORT ?? "0");
  if (healthPort > 0) {
    startHealthServer({
      service: "cvm-sms4sats",
      port: healthPort,
      commit: resolveDeployedCommit(process.env),
      ref: resolveDeployedRef(process.env),
      report: async () => treasuryHealthReport(treasury, cfg.minPriceSats, sel.rail),
    });
  }

  if (cfg.announce) {
    await publishAnnouncement(
      server,
      {
        d: cfg.d,
        serviceClass: cfg.serviceClass,
        about: "Receive SMS verification numbers, paid over ContextVM (CEP-8).",
        keywords: ["sms", "verification", "otp"],
        requiredInputs: [],
        optionalInputs: [],
        pmi: cfg.paymentMode === "cashu" ? ["bitcoin-cashu"] : [],
      },
      { secretKey: sk, relays: cfg.relays, name: "cvm-sms4sats", tools },
    );
    console.log("[cvm-sms4sats] announced 11316/11317");
  }

  const shutdown = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
