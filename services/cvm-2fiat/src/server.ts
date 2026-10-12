/**
 * server.ts — the cvm-2fiat entrypoint.
 *
 * The rail, not the card. See docs/cvm/llms.txt (served verbatim by the
 * `docs` tool) for the full contract and the refusal list.
 *
 * Configuration (names only; values come from /etc/cvm-2fiat/{config,secret}.env,
 * deployed by the cvm_service Ansible role from the fleet vault):
 *   SERVER_SECRET_KEY  — the service's Nostr identity (64 hex chars)
 *   OWNER_NPUB_HEX     — allow-listed owner pubkey for card.balance
 *   ADAPTER_URL        — LOCAL balance adapter (loopback only); unset = the
 *                        balance tool refuses rail_unavailable, never fabricates
 *   PRICE_BALANCE_SATS — 0 (default) = owner reads free; >0 = paid via the gate
 *   ANNOUNCE=false     — default until the announce card says go
 */
import {
  CashuProcessor,
  CvmServer,
  ExplicitGate,
  pubkeyHexOf,
  RateLimiter,
  secretKeyFrom,
  SqliteGateStore,
} from "../../../src/index.ts";
import { HttpLocalAdapter } from "./adapter.ts";
import { twoFiatAnnouncementContent, TWOFIAT_ABOUT, TWOFIAT_SERVICE_CLASS } from "./announce-content.ts";
import { publishAnnouncement } from "../../../src/announce.ts";
import { buildTwoFiatEscalation } from "./escalation-wiring.ts";
import { buildTwoFiatTools } from "./tools.ts";

const RELAYS_DEFAULT = [
  "wss://nostr.mom",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay2.contextvm.org",
];

interface Config {
  secretKey: string;
  relays: string[];
  ownerNpub: string;
  adapterUrl?: string;
  priceBalanceSats: number;
  paymentMode: "none" | "cashu";
  cashuMintUrl: string;
  gateDb: string;
  escalationDir: string;
  escalationWindowSeconds: number;
  escalationSweepMs: number;
  announce: boolean;
  d: string;
  rateCapacity: number;
  rateRefillPerSec: number;
}

function configFromEnv(env: Record<string, string | undefined>): Config {
  const secretKey = env.SERVER_SECRET_KEY ?? env.SERVER_HEX;
  if (!secretKey) throw new Error("SERVER_SECRET_KEY is required (64 hex chars)");
  const ownerNpub = env.OWNER_NPUB_HEX ?? "";
  if (!ownerNpub) throw new Error("OWNER_NPUB_HEX is required (card.balance is owner-only by design)");
  const gateDb = env.GATE_DB ?? "/var/lib/loom/cvm-2fiat/gate.sqlite";
  return {
    secretKey,
    relays: (env.RELAYS ?? RELAYS_DEFAULT.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    ownerNpub: ownerNpub.trim().toLowerCase(),
    adapterUrl: env.ADAPTER_URL,
    priceBalanceSats: Number(env.PRICE_BALANCE_SATS ?? "0"),
    paymentMode: (env.PAYMENT_MODE as Config["paymentMode"]) ?? "none",
    cashuMintUrl: env.CASHU_MINT_URL ?? "https://testnut.cashu.exchange",
    gateDb,
    // ADR-0012 escalation state: durable intents + escalations live beside the
    // gate store, so nothing is in memory and a restart loses no barrier.
    escalationDir: env.ESCALATION_DIR ?? gateDb.replace(/\/[^/]+$/, ""),
    escalationWindowSeconds: Number(env.ESCALATION_WINDOW_SECONDS ?? String(24 * 60 * 60)),
    escalationSweepMs: Number(env.ESCALATION_SWEEP_MS ?? String(5 * 60_000)),
    announce: (env.ANNOUNCE ?? "false") !== "false",
    d: env.ANNOUNCE_D ?? "cvm-2fiat-01",
    rateCapacity: Number(env.RATE_CAPACITY ?? "10"),
    rateRefillPerSec: Number(env.RATE_REFILL_PER_SEC ?? "1"),
  };
}

async function main() {
  const cfg = configFromEnv(process.env);
  const sk = secretKeyFrom(cfg.secretKey);

  // The LOCAL adapter — only when configured, and only reachable by the owner.
  const adapter = cfg.adapterUrl ? new HttpLocalAdapter(cfg.adapterUrl) : undefined;
  if (!adapter) {
    console.error("[cvm-2fiat] no ADAPTER_URL — card.balance will refuse rail_unavailable");
  }

  const gate =
    cfg.paymentMode === "cashu" && cfg.priceBalanceSats > 0
      ? new ExplicitGate(
          new CashuProcessor({ mintUrl: cfg.cashuMintUrl }),
          new SqliteGateStore(cfg.gateDb),
        )
      : undefined;

  const limiter = new RateLimiter({
    capacity: cfg.rateCapacity,
    refillPerSec: cfg.rateRefillPerSec,
  });

  const tools = buildTwoFiatTools({
    adapter,
    ownerNpub: cfg.ownerNpub,
    priceSats: gate ? cfg.priceBalanceSats : 0,
    gate,
  });

  // Every handler is rate-limited through a wrapper (the free tools too).
  const limited = tools.map((t) => ({
    ...t,
    handler: (args: Record<string, unknown>, ctx: { caller: string }) => {
      limiter.assert(ctx.caller);
      return t.handler(args, ctx);
    },
  }));

  const server = new CvmServer({
    secretKey: sk,
    relays: cfg.relays,
    name: "cvm-2fiat",
    tools: limited,
    onLog: (l) => console.error(`[cvm-2fiat] ${l}`),
  });
  await server.start();
  console.log(`[cvm-2fiat] pubkey: ${pubkeyHexOf(sk)}`);

  // ADR-0012: the escalation is armed here, in the CVM, and its recipient is the
  // identity the service ALREADY has (OWNER_NPUB_HEX) - no second support npub
  // to rotate and lose. The durable intent/escalation tables are on disk beside
  // the gate store: the SQLite row, never the DM and never an in-memory cache,
  // is the replay barrier.
  const escalation = buildTwoFiatEscalation({
    ownerNpub: cfg.ownerNpub,
    secretKey: cfg.secretKey,
    publish: (e) => server.publishEvent(e),
    dataDir: cfg.escalationDir,
    windowSeconds: cfg.escalationWindowSeconds,
  });
  console.log(
    `[cvm-2fiat] escalation armed: operator=${cfg.ownerNpub}, ` +
      `window=${cfg.escalationWindowSeconds}s, dir=${cfg.escalationDir}`,
  );

  // Bounded window: an escalation nobody resolves must not go quiet.
  const sweepTimer =
    cfg.escalationSweepMs > 0
      ? setInterval(() => {
          void escalation.machine
            .sweep()
            .then((alerted) => {
              if (alerted.length) console.error(`[cvm-2fiat] alerted ${alerted.length} unresolved escalation(s)`);
            })
            .catch((e) => console.error(`[cvm-2fiat] escalation sweep failed: ${e?.message ?? e}`));
        }, cfg.escalationSweepMs)
      : undefined;

  if (cfg.announce) {
    const ann = twoFiatAnnouncementContent(limited.map((t) => t.definition.name));
    await publishAnnouncement(
      server,
      {
        d: cfg.d,
        serviceClass: TWOFIAT_SERVICE_CLASS,
        about: TWOFIAT_ABOUT,
        keywords: ["payment", "rail", "2fiat", "prepaid-card", "checkout"],
        // FIELD-LESS: both arrays left UNDEFINED on purpose — the service
        // collects no register-known input, so it is unclassified and must
        // carry no cvm:tier tag (see announce-content.ts).
        requiredInputs: ann.requiredInputs,
        optionalInputs: ann.optionalInputs,
        pmi: [],
      },
      { secretKey: sk, relays: cfg.relays, name: "cvm-2fiat", tools: limited },
    );
    console.log("[cvm-2fiat] announced 11316/11317");
  }

  const shutdown = () => {
    if (sweepTimer) clearInterval(sweepTimer);
    escalation.close();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("FATAL:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
