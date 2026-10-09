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
 *   MAX_CHECKOUT_SATS  — 0 (default) = the FIAT PATH IS OFF; >0 enables
 *                        card.pay_checkout (owner-only, sats-gated, one attempt
 *                        per settlement) with this ceiling in sats
 *   FIAT_DB            — durable fiat intent store (defaults next to GATE_DB)
 *   UNRESOLVED_WINDOW_MS — how long a settled-but-unfinished intent may sit
 *                        before the sweep alerts the operator (ADR-0012)
 *   ANNOUNCE=false     — default until the announce card says go
 */
import type { Event } from "nostr-tools";
import {
  CashuProcessor,
  CvmServer,
  ExplicitGate,
  NostrDmEscalator,
  pubkeyHexOf,
  RateLimiter,
  secretKeyFrom,
  SqliteFiatIntentStore,
  SqliteGateStore,
  sweepUnresolved,
} from "../../../src/index.ts";
import { HttpLocalAdapter } from "./adapter.ts";
import { twoFiatAnnouncementContent, TWOFIAT_ABOUT, TWOFIAT_SERVICE_CLASS } from "./announce-content.ts";
import { publishAnnouncement } from "../../../src/announce.ts";
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
  /** Durable fiat intent store (the settlement state machine's fiat half). */
  fiatDb: string;
  /**
   * Upper bound in sats on ONE checkout this service will settle for. 0 =
   * card.pay_checkout refuses rail_unavailable (the default: no fiat path at all
   * until an operator deliberately turns it on).
   */
  maxCheckoutSats: number;
  /** Bounded window before an unresolved intent alerts the operator (ADR-0012). */
  unresolvedWindowMs: number;
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
  return {
    secretKey,
    relays: (env.RELAYS ?? RELAYS_DEFAULT.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    ownerNpub: ownerNpub.trim().toLowerCase(),
    adapterUrl: env.ADAPTER_URL,
    priceBalanceSats: Number(env.PRICE_BALANCE_SATS ?? "0"),
    paymentMode: (env.PAYMENT_MODE as Config["paymentMode"]) ?? "none",
    cashuMintUrl: env.CASHU_MINT_URL ?? "https://testnut.cashu.exchange",
    gateDb: env.GATE_DB ?? "/var/lib/loom/cvm-2fiat/gate.sqlite",
    fiatDb:
      env.FIAT_DB ??
      (env.GATE_DB
        ? `${env.GATE_DB.replace(/[^/]*$/, "")}fiat-intents.sqlite`
        : "/var/lib/loom/cvm-2fiat/fiat-intents.sqlite"),
    maxCheckoutSats: Number(env.MAX_CHECKOUT_SATS ?? "0"),
    unresolvedWindowMs: Number(env.UNRESOLVED_WINDOW_MS ?? String(15 * 60_000)),
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

  // The gate is the ONLY authority on whether sats settled. It is required for
  // any paid read AND for the gated fiat path: if it cannot be built, the fiat
  // path is not wired at all (card.pay_checkout then refuses rail_unavailable)
  // rather than spending against an unverifiable payment.
  const wantsGate = cfg.paymentMode === "cashu" && (cfg.priceBalanceSats > 0 || cfg.maxCheckoutSats > 0);
  const gate = wantsGate
    ? new ExplicitGate(
        new CashuProcessor({ mintUrl: cfg.cashuMintUrl }),
        new SqliteGateStore(cfg.gateDb),
      )
    : undefined;

  // The fiat path: OFF unless an operator sets MAX_CHECKOUT_SATS > 0 AND both
  // the adapter and the gate exist. The escalator DMs the SAME owner identity
  // that card.balance/card.pay_checkout are allow-listed to (OWNER_NPUB_HEX) —
  // no new identity is invented for escalations (ADR-0012).
  let publishSigned: ((event: Event) => Promise<void>) | undefined;
  const fiatStore = cfg.maxCheckoutSats > 0 ? new SqliteFiatIntentStore(cfg.fiatDb) : undefined;
  const fiat =
    adapter && gate && fiatStore
      ? {
          store: fiatStore,
          escalator: new NostrDmEscalator({
            secretKey: sk,
            publish: async (event: Event) => {
              if (!publishSigned) throw new Error("transport not started: escalation not published");
              await publishSigned(event);
            },
          }),
          maxCheckoutSats: cfg.maxCheckoutSats,
          unresolvedWindowMs: cfg.unresolvedWindowMs,
        }
      : undefined;
  if (!fiat) {
    console.error(
      cfg.maxCheckoutSats > 0
        ? "[cvm-2fiat] fiat path unavailable (needs ADAPTER_URL + PAYMENT_MODE=cashu + the gate) — card.pay_checkout will refuse rail_unavailable"
        : "[cvm-2fiat] fiat path OFF (MAX_CHECKOUT_SATS unset) — card.pay_checkout refuses rail_unavailable",
    );
  } else {
    console.error(
      `[cvm-2fiat] fiat path ENABLED: owner-only, sats-gated, at most one attempt per settlement, max ${cfg.maxCheckoutSats} sats/checkout`,
    );
  }

  const limiter = new RateLimiter({
    capacity: cfg.rateCapacity,
    refillPerSec: cfg.rateRefillPerSec,
  });

  const tools = buildTwoFiatTools({
    adapter,
    ownerNpub: cfg.ownerNpub,
    priceSats: gate && cfg.priceBalanceSats > 0 ? cfg.priceBalanceSats : 0,
    gate,
    fiat,
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

  // Only now can an escalation DM be published. The gift wrap is signed by its
  // own ephemeral wrap key, so it goes out as-is (never re-signed).
  publishSigned = (event) => server.publishSignedEvent(event);

  // ADR-0012, the safety net for the two ways a settled payment could go quiet:
  // a crash between the two legs, and a failure whose DM never landed. Idempotent
  // by design (alertAt/escalatedAt are durable), so a lost alert is retried and a
  // delivered one is not repeated.
  const sweepTimer = fiat
    ? setInterval(() => {
        sweepUnresolved({
          store: fiat.store,
          escalator: fiat.escalator,
          operatorNpub: cfg.ownerNpub,
          unresolvedWindowMs: cfg.unresolvedWindowMs,
        })
          .then((r) => {
            if (r.escalationsRetried || r.alertsRaised) {
              console.error(
                `[cvm-2fiat] sweep: ${r.escalationsRetried} escalation(s) retried, ${r.alertsRaised} unresolved alert(s)`,
              );
            }
          })
          .catch((e) => console.error("[cvm-2fiat] sweep failed:", e instanceof Error ? e.message : e));
      }, 5 * 60_000)
    : undefined;
  sweepTimer?.unref?.();

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
