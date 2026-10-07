import {
  CvmServer,
  publishAnnouncement,
  pubkeyHexOf,
  secretKeyFrom,
  type Tool,
} from "../../src/index.ts";
import { startHealthServer, type HealthReport } from "./health.ts";
import * as fs from "node:fs";

const RELAYS_DEFAULT = [
  "wss://nostr.mom",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay2.contextvm.org",
  "wss://relay2.orangesync.tech",
];

export interface StartOptions {
  name: string;
  serviceClass: string;
  about: string;
  keywords?: string[];
  tools: Tool[];
  defaultD?: string;
  env?: Record<string, string | undefined>;
  /** Optional loopback health report (enabled by HEALTH_PORT). */
  healthReport?: () => Promise<HealthReport> | HealthReport;
}

/** Read a trimmed single-line file, or undefined. Never throws. */
function readTrimmed(path: string): string | undefined {
  try {
    const t = fs.readFileSync(path, "utf8").trim();
    return t.length > 0 ? t : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the deployed commit for /health: env override first, then the
 * `.deployed-sha` marker written by the Ansible role at the repo root
 * (WorkingDirectory for the unit), then one relative to this module.
 */
export function resolveDeployedCommit(env: Record<string, string | undefined>): string | undefined {
  const fromEnv = env.CVM_COMMIT?.trim();
  if (fromEnv) return fromEnv;
  return readTrimmed(".deployed-sha") ??
    readTrimmed(new URL("../../.deployed-sha", import.meta.url).pathname);
}

/** Same for the pinned ref name (tag/branch/SHA). */
export function resolveDeployedRef(env: Record<string, string | undefined>): string | undefined {
  const fromEnv = env.CVM_REF?.trim();
  if (fromEnv) return fromEnv;
  return readTrimmed(".deployed-ref") ??
    readTrimmed(new URL("../../.deployed-ref", import.meta.url).pathname);
}

/** Shared bootstrap for a wrapper CVM: connect relays, announce, handle shutdown. */
export async function startService(o: StartOptions): Promise<void> {
  const env = o.env ?? process.env;
  const sk = secretKeyFrom(env.SERVER_SECRET_KEY ?? env.SERVER_HEX ?? "");
  const relays = (env.RELAYS ?? RELAYS_DEFAULT.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const announce = (env.ANNOUNCE ?? "true") !== "false";
  const pmi = (env.PAYMENT_MODE ?? "cashu") === "cashu" ? ["bitcoin-cashu"] : [];

  const server = new CvmServer({
    secretKey: sk,
    relays,
    name: o.name,
    tools: o.tools,
    onLog: (l) => console.error(`[${o.name}] ${l}`),
  });
  await server.start();
  console.log(`[${o.name}] pubkey: ${pubkeyHexOf(sk)}`);

  const healthPort = Number(env.HEALTH_PORT ?? "0");
  if (healthPort > 0) {
    startHealthServer({
      service: o.name,
      port: healthPort,
      commit: resolveDeployedCommit(env),
      ref: resolveDeployedRef(env),
      report: o.healthReport,
    });
  }

  if (announce) {
    await publishAnnouncement(
      server,
      {
        d: env.ANNOUNCE_D ?? o.defaultD ?? `${o.name}-01`,
        serviceClass: o.serviceClass,
        about: o.about,
        keywords: o.keywords ?? [],
        requiredInputs: [],
        optionalInputs: [],
        pmi,
      },
      { secretKey: sk, relays, name: o.name, tools: o.tools },
    );
    console.log(`[${o.name}] announced 11316/11317`);
  }

  const shutdown = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
