/**
 * server.ts — the `no-server-deals` ContextVM service.
 *
 * Read-only market data over MCP-on-Nostr (CEP-6 announcement, zero-cost tools,
 * no payment rail). Run with Bun:
 *
 *   SERVER_SECRET_KEY=$(openssl rand -hex 32) bun services/no-server-deals/src/server.ts
 *
 * Env:
 *   SERVER_SECRET_KEY  REQUIRED — 64 hex chars. Must DIFFER from any client key.
 *   RELAYS             comma-separated relay URLs
 *   ANNOUNCE           "false" to run without publishing the CEP-6 catalog
 *   ANNOUNCE_D         stable `d` slug (default no-server-deals-01)
 *   SERVICE_CLASS      `t=cvm:service:<class>` (default `market`)
 *   HEALTH_PORT        loopback /health port (0 = off)
 *   MAX_NOK_DEFAULT    default budget for deal_digest (default 15000)
 *   AUKSJONEN_MAX_LOTS cap on lot pages fetched per refresh (default 40)
 *   REFRESH_MIN        periodic re-poll interval in minutes (0 = off)
 */
import { secretKeyFrom } from "../../../src/index.ts";
import type { HealthReport } from "../../_shared/health.ts";
import { resolveDeployedCommit, resolveDeployedRef, startService } from "../../_shared/start.ts";
import { createCatalog, buildDealsTools } from "./tools.ts";

const RELAYS_DEFAULT = [
  "wss://nostr.mom",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay2.contextvm.org",
  "wss://relay2.orangesync.tech",
];

const NAME = "no-server-deals";

export function catalogFromEnv(env: Record<string, string | undefined>) {
  return createCatalog({ maxLots: Number(env.AUKSJONEN_MAX_LOTS ?? "40") || 40 });
}

async function main() {
  const env = process.env;
  const sk = secretKeyFrom(env.SERVER_SECRET_KEY ?? env.SERVER_HEX ?? "");
  const relays = (env.RELAYS ?? RELAYS_DEFAULT.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const catalog = catalogFromEnv(env);
  // Warm start: one poll before announcing, so the first caller never sees an
  // empty market. Failure is tolerated — the tools then say so honestly.
  await catalog.refresh();
  console.error(
    `[${NAME}] warm capture: ${catalog.listings.length} listings, errors=${JSON.stringify(catalog.errors)}`,
  );

  const refreshMin = Number(env.REFRESH_MIN ?? "0") || 0;
  if (refreshMin > 0) {
    setInterval(() => void catalog.refresh(), refreshMin * 60_000).unref?.();
  }

  const tools = buildDealsTools({
    catalog,
    maxNokDefault: Number(env.MAX_NOK_DEFAULT ?? "15000") || 15000,
  });

  const healthReport = (): HealthReport => ({
    status: catalog.listings.length > 0 ? "ok" : "no_data",
    captured_at: catalog.capturedAt,
    listings: catalog.listings.length,
    sources: [...new Set(catalog.listings.map((l) => l.source))].sort(),
    source_errors: catalog.errors,
  });

  // startService connects relays, starts /health (when HEALTH_PORT>0) and
  // publishes the CEP-6 announcement with COMPUTED tier (empty input list ->
  // tier "none"; there is no caller-supplied tier anywhere in this path).
  await startService({
    name: NAME,
    serviceClass: env.SERVICE_CLASS ?? "market",
    about:
      "Norwegian second-hand server / IT-hardware market: refurb retailers (Axentra, IT Garasjen, Rebuild IT) and liquidation lots (Auksjonen.no), normalised and ranked by NOK. Read-only.",
    keywords: ["servers", "norway", "refurbished", "second-hand", "hardware", "market"],
    tools,
    defaultD: `${NAME}-01`,
    env,
    healthReport,
  });

  console.log(
    `[${NAME}] up — commit=${resolveDeployedCommit(env) ?? "unknown"} ref=${resolveDeployedRef(env) ?? "unknown"} relays=${relays.length}`,
  );
}

if (import.meta.main) await main();
