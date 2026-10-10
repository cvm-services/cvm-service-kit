/**
 * EVIDENCE for card t_89dcb160: one sats payment can produce AT MOST ONE fiat
 * attempt, under real concurrency, with independent OS processes.
 *
 * Six callers start on a shared barrier against one SQLite intent table:
 *   - four legitimate identical callers for intent `i-race` (same binding);
 *   - one attacker replaying `i-race` with a DIFFERENT caller/tool/amount;
 *   - one caller with a different intent id but the SAME payment proof.
 *
 * The fiat leg appends a line to a shared log, so "how many fiat attempts did
 * one settlement produce" is counted from the filesystem, not from a report.
 *
 * Run:  bun run src/evidence/one_payment_one_attempt.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orderHashOf, type IntentBinding } from "../intent-store.ts";

const dir = mkdtempSync(join(tmpdir(), "settle-race-"));
const dbPath = join(dir, "intents.sqlite");
const attemptLog = join(dir, "fiat-attempts.log");

const BINDING: IntentBinding = {
  tool: "card.pay_checkout",
  caller: "npub1owner",
  orderHash: orderHashOf({ url: "https://merchant.example/checkout", amount: "12.50" }),
  amountSats: 500,
  pmi: "bitcoin-cashu",
  quote: "cashu:https://mint.example:500",
  fiatCap: 12.5,
  fiatCurrency: "EUR",
};

const callers: Array<{ label: string; intentId: string; binding: IntentBinding }> = [
  ...Array.from({ length: 4 }, (_, i) => ({
    label: `legit-${i}`,
    intentId: "i-race",
    binding: BINDING,
  })),
  {
    label: "attacker-different-caller-amount",
    intentId: "i-race",
    binding: { ...BINDING, caller: "npub1mallory", tool: "card.pay", amountSats: 5000 },
  },
  { label: "attacker-same-proof-other-intent", intentId: "i-race-2", binding: BINDING },
];

const startAt = Date.now() + 3000;
const runs = callers.map((c) => {
  const child = spawn(
    "bun",
    [
      "run",
      join(import.meta.dir, "settlement_caller.ts"),
      dbPath,
      c.intentId,
      JSON.stringify(c.binding),
      attemptLog,
      String(startAt),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let out = "";
  child.stdout.on("data", (b) => (out += b.toString()));
  return new Promise<{ label: string; outcome: string }>((resolve) => {
    child.on("exit", () => resolve({ label: c.label, outcome: out.trim() }));
  });
});

const results = await Promise.all(runs);
const attempts = existsSync(attemptLog)
  ? readFileSync(attemptLog, "utf8").trim().split("\n").filter(Boolean)
  : [];

console.log("caller outcomes:");
for (const r of results) console.log(`  ${r.label.padEnd(38)} ${r.outcome}`);
console.log(`\nfiat attempts recorded: ${attempts.length}`);
for (const a of attempts) console.log(`  ${a}`);

const bad = results.filter((r) => r.outcome.startsWith("error:"));
const count = (o: string) => results.filter((r) => r.outcome === o).length;
const ok =
  attempts.length === 1 &&
  bad.length === 0 &&
  count("attempt") === 1 &&
  count("replay") === 3 &&
  count("conflict") === 1 &&
  count("proof") === 1;

console.log(
  ok
    ? "\nPASS: one settlement -> exactly one fiat attempt; the mismatched re-use and the " +
        "duplicate proof were refused, and every refused caller was refused BEFORE the action."
    : `\nFAIL: expected 1 attempt / 3 replay / 1 conflict / 1 proof, got ` +
        `${count("attempt")} / ${count("replay")} / ${count("conflict")} / ${count("proof")} ` +
        `with ${attempts.length} attempts recorded`,
);
process.exit(ok ? 0 : 1);
