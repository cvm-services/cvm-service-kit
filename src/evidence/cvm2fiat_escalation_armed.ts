/**
 * EVIDENCE for card t_89dcb160: the ADR-0012 escalation is ARMED in the real
 * cvm-2fiat service, not merely exported as a library.
 *
 * A minimal in-process NIP-01 relay (Bun.serve) is started on a random loopback
 * port, the actual `services/cvm-2fiat/src/server.ts` entrypoint is spawned
 * against it with SERVER_SECRET_KEY + OWNER_NPUB_HEX, and the run is judged on
 * what the process did:
 *
 *   - it logged the operator it will escalate TO (the existing owner key), and
 *   - the durable intent + escalation tables exist on disk after boot, in the
 *     directory the service was told to use.
 *
 * Run:  bun run src/evidence/cvm2fiat_escalation_armed.ts
 * Exit: 0 when the service arms the escalation against the owner key.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operatorPubkeyOf } from "../escalation.ts";

const CVM_SK = "a".repeat(64);
const OWNER_NPUB = operatorPubkeyOf("b".repeat(64));
const worktree = join(import.meta.dir, "..", "..");
const dataDir = mkdtempSync(join(tmpdir(), "2fiat-arm-"));

// Minimal relay: accept the socket and answer every REQ with EOSE. The service
// only needs its subscribe + publish sockets to come up.
const relay = Bun.serve({
  port: 0,
  fetch(req, server) {
    if (server.upgrade(req)) return undefined;
    return new Response("cvm-2fiat evidence relay");
  },
  websocket: {
    message(ws, raw) {
      try {
        const frame = JSON.parse(String(raw));
        if (Array.isArray(frame) && frame[0] === "REQ") {
          ws.send(JSON.stringify(["EOSE", frame[1]]));
        }
      } catch {
        /* ignore */
      }
    },
  },
});

const child = spawn("bun", ["run", "services/cvm-2fiat/src/server.ts"], {
  cwd: worktree,
  env: {
    ...process.env,
    SERVER_SECRET_KEY: CVM_SK,
    OWNER_NPUB_HEX: OWNER_NPUB,
    RELAYS: `ws://127.0.0.1:${relay.port}`,
    ESCALATION_DIR: dataDir,
    GATE_DB: join(dataDir, "gate.sqlite"),
    // sweep on a slow tick; the arming line is what this probe is about
    ESCALATION_SWEEP_MS: "60000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let log = "";
child.stdout.on("data", (b) => (log += b.toString()));
child.stderr.on("data", (b) => (log += b.toString()));

const deadline = Date.now() + 20_000;
while (Date.now() < deadline && !log.includes("escalation armed")) {
  await Bun.sleep(100);
}
child.kill("SIGTERM");
await Bun.sleep(300);
relay.stop(true);

const armed = log.match(/escalation armed: operator=([0-9a-f]+), window=(\d+)s, dir=(.*)/);
const expected = [
  { label: "intents.sqlite", path: join(dataDir, "intents.sqlite") },
  { label: "escalations.sqlite", path: join(dataDir, "escalations.sqlite") },
];
console.log("service log:");
for (const line of log.trim().split("\n")) console.log(`  ${line}`);
console.log("\ndurable tables created by boot:");
for (const f of expected) console.log(`  ${existsSync(f.path) ? "yes" : "NO "} ${f.path}`);

const ok =
  !!armed &&
  armed[1] === OWNER_NPUB &&
  expected.every((f) => existsSync(f.path)) &&
  !/dispos|error/i.test(log.replace(/relay closed.*/g, ""));

console.log(
  ok
    ? `\nPASS: the service armed the escalation against its existing operator key (${OWNER_NPUB.slice(0, 12)}...) ` +
        "and persisted both tables; no new support npub was introduced."
    : `\nFAIL: armed=${!!armed} operator=${armed?.[1]} log=${JSON.stringify(log.slice(0, 400))}`,
);
process.exit(ok ? 0 : 1);
