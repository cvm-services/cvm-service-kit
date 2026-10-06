import {
  CashuProcessor,
  CvmServer,
  ExplicitGate,
  FakeLnWallet,
  NwcLnWallet,
  SqliteOrderStore,
  Treasury,
  markupForMargin,
  publishAnnouncement,
  pubkeyHexOf,
  secretKeyFrom,
  type LnWallet,
  type PaymentProcessor,
} from "../../../src/index.ts";
import { startHealthServer } from "../../_shared/health.ts";
import { Sms4SatsClient } from "./upstream.ts";
import { buildSmsTools } from "./tools.ts";

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

  const wallet: LnWallet = cfg.nwcUrl ? new NwcLnWallet(cfg.nwcUrl) : new FakeLnWallet();
  if (!cfg.nwcUrl) {
    console.error("[cvm-sms4sats] WARNING: no NWC_URL — using FakeLnWallet (dev only)");
  }

  const treasury = new Treasury(wallet, { floorSats: cfg.floorSats });
  const orders = new SqliteOrderStore(cfg.orderDb);
  const processor: PaymentProcessor =
    cfg.paymentMode === "cashu"
      ? new CashuProcessor({ mintUrl: cfg.cashuMintUrl })
      : (new FakeLnWallet() as unknown as PaymentProcessor);
  const gate = new ExplicitGate(processor);
  const client = new Sms4SatsClient({ baseUrl: cfg.sms4satsBase });

  const tools = buildSmsTools({
    client,
    wallet,
    treasury,
    orders,
    pricing: { markup: markupForMargin(cfg.margin), minSats: cfg.minPriceSats },
    gate,
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
      report: async () => ({
        status: (await treasury.canSpend(cfg.minPriceSats)) ? "ok" : "low_treasury",
        treasury_balance_sats: await treasury.balanceSats(),
      }),
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
