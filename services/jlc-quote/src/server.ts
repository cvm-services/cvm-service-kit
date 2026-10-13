/**
 * server.ts — the cvm-jlc-quote entrypoint.
 *
 * WHY NOT `startService()` FROM services/_shared/start.ts
 *
 * The shared bootstrap announces through the older `announcementTags` path, whose
 * tier handling cannot express what this service must declare: it emits the
 * `cvm:req:none` sentinel ONLY when one of `requiredInputs`/`optionalInputs` is
 * defined, and when either is defined it ALSO emits `cvm:tier:none`. This service
 * must publish the sentinel and NO tier tag (see announce.ts), so it wires
 * CvmServer + the shared health server directly and publishes the tag set its
 * tests assert. The published tags and the asserted tags are the SAME array
 * (`ASSERTED_TAGS` is built from the same emitter call), and the announcement is
 * re-validated by `assertAnnouncementTags` immediately before it goes out — a
 * service that can announce a non-conforming tag set is a service whose tests
 * are decoration.
 *
 * Configuration (names only; values come from /etc/cvm-jlc-quote/{config,secret}.env,
 * deployed by the cvm_service Ansible role). No credential is read here: the
 * Chrome profile holds the JLCPCB session and this process passes its PATH only.
 *
 *   SERVER_SECRET_KEY   — the service's Nostr identity (64 hex)      [secret, 0600]
 *   RELAYS              — comma-separated relay list
 *   ANNOUNCE=false      — default; announcing waits for the announce card
 *   ANNOUNCE_D          — announcement slug (cvm-jlc-quote-01)
 *   JLC_PYTHON          — Playwright venv python  (…/venvs/pw/bin/python)
 *   JLC_CLIENT_DIR      — checkout of the wrapped client (has tools/capture_page.py)
 *   JLC_INPUT_DIR       — gerber zip directory (MUST be outside /tmp)
 *   JLC_PROFILE         — persistent Chrome profile holding the JLCPCB session
 *   JLC_SNAPSHOT_DIR    — where raw page text is archived
 *   JLC_DISPLAY         — X display for the headed browser (":99", an Xvfb)
 *   JLC_CHROME          — the Chrome binary (/usr/bin/google-chrome)
 *   JLC_TIMEOUT_MS      — per-quote deadline (default 360000)
 *   HEALTH_PORT         — loopback health endpoint (optional)
 */
import {
  CvmServer,
  pubkeyHexOf,
  secretKeyFrom,
  type Tool,
} from "../../../src/index.ts";
import { assertAnnouncementTags } from "../../../src/validate.ts";
import { startHealthServer } from "../../_shared/health.ts";
import { emitJlcQuoteAnnouncement, JLC_QUOTE_CLASS, JLC_QUOTE_D, loadVocab } from "./announce.ts";
import { LiveJlcAdapter, liveConfigFromEnv } from "./adapter.ts";
import { QUANTITY_LIMITATION } from "./provenance.ts";
import { buildJlcQuoteTools } from "./tools.ts";

const RELAYS_DEFAULT = [
  "wss://nostr.mom",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay2.contextvm.org",
  "wss://relay2.orangesync.tech",
];

export interface ServerConfig {
  secretKey: string;
  relays: string[];
  announce: boolean;
  d: string;
  healthPort: number;
  clientDir: string;
  display: string;
  chromePath: string;
}

export function configFromEnv(env: Record<string, string | undefined>): ServerConfig {
  const secretKey = env.SERVER_SECRET_KEY ?? env.SERVER_HEX;
  if (!secretKey) throw new Error("SERVER_SECRET_KEY is required (64 hex chars)");
  return {
    secretKey,
    relays: (env.RELAYS ?? RELAYS_DEFAULT.join(","))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // ANNOUNCE=false is the DEFAULT: a running service that cannot yet honestly
    // fulfil must be invisible rather than advertising a tool it will refuse.
    announce: (env.ANNOUNCE ?? "false") !== "false",
    d: env.ANNOUNCE_D ?? JLC_QUOTE_D,
    healthPort: Number(env.HEALTH_PORT ?? "0"),
    clientDir: liveConfigFromEnv(env).clientDir,
    display: liveConfigFromEnv(env).display,
    chromePath: liveConfigFromEnv(env).chromePath,
  };
}

async function main() {
  const env = process.env;
  const cfg = configFromEnv(env);
  const sk = secretKeyFrom(cfg.secretKey);

  const adapter = new LiveJlcAdapter(liveConfigFromEnv(env));
  const tools: Tool[] = buildJlcQuoteTools({ adapter });

  const server = new CvmServer({
    secretKey: sk,
    relays: cfg.relays,
    name: "cvm-jlc-quote",
    tools,
    onLog: (l) => console.error(`[cvm-jlc-quote] ${l}`),
  });
  await server.start();
  console.log(`[cvm-jlc-quote] pubkey: ${pubkeyHexOf(sk)}`);

  if (cfg.healthPort > 0) {
    startHealthServer({
      service: "cvm-jlc-quote",
      port: cfg.healthPort,
      commit: env.CVM_COMMIT,
      ref: env.CVM_REF,
      report: () => ({
        status: "ok",
        // Reported, never asserted as healthy: the caller's first real call is
        // what proves the browser leg works.
        browser_leg: {
          display: cfg.display,
          chrome: cfg.chromePath,
          client_dir: cfg.clientDir,
          profile_set: Boolean(env.JLC_PROFILE),
        },
        quantity_limitation: QUANTITY_LIMITATION,
        places_orders: false,
      }),
    });
  }

  if (cfg.announce) {
    const vocab = await loadVocab();
    const ann = emitJlcQuoteAnnouncement(vocab);
    // Fail-closed: the served announcement must be the asserted one. If this
    // throws, the process must not advertise at all rather than publish a
    // non-conforming tag set.
    assertAnnouncementTags(ann.tags, vocab);
    const serverEvent = await server.publish({
      kind: 11316,
      content: ann.content,
      tags: ann.tags,
    });
    await server.publish({
      kind: 11317,
      content: JSON.stringify({
        tools: tools.map((t) => ({
          name: t.definition.name,
          description: t.definition.description,
          inputSchema: t.definition.inputSchema,
        })),
      }),
      tags: [
        ["d", cfg.d],
        ["t", `cvm:service:${JLC_QUOTE_CLASS}`],
      ],
    });
    console.log(
      `[cvm-jlc-quote] announced 11316/11317 d=${cfg.d} tier=${ann.tier} ` +
        `tags=${ann.tags.length} ok=${Boolean(serverEvent)}`
    );
  } else {
    console.error("[cvm-jlc-quote] ANNOUNCE=false — serving, not announcing");
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
    console.error("FATAL:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
