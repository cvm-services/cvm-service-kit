/**
 * EVIDENCE for card t_89dcb160: one sats payment can produce AT MOST ONE fiat
 * attempt - under real concurrency, in independent OS processes, and ACROSS a
 * process restart.
 *
 * The phases run in sequence so every caller's classification is deterministic
 * (an earlier version raced the "duplicate proof" attacker against the legit
 * callers, and which side lost was a coin flip - the count of attempts was
 * always 1, but the attribution was fiction):
 *
 *   A. RACE     4 identical callers, one intent, one proof, one shared start
 *               barrier -> exactly 1 "attempt" and 3 "replay".
 *   B. CONFLICT same intent id, DIFFERENT caller/tool/amount -> "conflict".
 *   C. PROOF    a NEW intent id presenting the SAME payment proof -> "proof".
 *   D. RESTART  every process from A-C has exited; a caller on a brand new
 *               intent id presenting the same proof is still refused -> "proof".
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

type Caller = { label: string; intentId: string; binding: IntentBinding };

/** One OS process per caller, all released by the same wall-clock instant. */
async function phase(
  name: string,
  callers: Caller[],
  opts: { barrier: boolean } = { barrier: true },
): Promise<{ label: string; outcome: string }[]> {
  const startAt = opts.barrier ? Date.now() + 3000 : Date.now() - 1;
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
  console.log(`phase ${name}:`);
  for (const r of results) console.log(`  ${r.label.padEnd(38)} ${r.outcome}`);
  return results;
}

const results: Array<{ label: string; outcome: string }> = [];

// A. the race: four legitimate callers, ONE intent, ONE payment proof.
results.push(
  ...(await phase(
    "A race",
    Array.from({ length: 4 }, (_, i) => ({
      label: `legit-${i}`,
      intentId: "i-race",
      binding: BINDING,
    })),
  )),
);

// B. the same intent id, a different caller/tool/amount: a captured request
//    re-pointed at a bigger fiat order.
results.push(
  ...(await phase(
    "B conflict",
    [
      {
        label: "attacker-different-caller-amount",
        intentId: "i-race",
        binding: { ...BINDING, caller: "npub1mallory", tool: "card.pay", amountSats: 5000 },
      },
    ],
    { barrier: false },
  )),
);

// C. a fresh intent id presenting the SAME payment proof.
results.push(
  ...(await phase(
    "C duplicate proof",
    [{ label: "attacker-same-proof-new-intent", intentId: "i-race-2", binding: BINDING }],
    { barrier: false },
  )),
);

// D. every process above has exited. A brand new intent id with the same proof
//    must still be refused: the barrier is on disk, not in memory.
results.push(
  ...(await phase(
    "D after restart",
    [{ label: "attacker-same-proof-after-restart", intentId: "i-race-3", binding: BINDING }],
    { barrier: false },
  )),
);

const attempts = existsSync(attemptLog)
  ? readFileSync(attemptLog, "utf8").trim().split("\n").filter(Boolean)
  : [];

console.log(`\nfiat attempts recorded: ${attempts.length}`);
for (const a of attempts) console.log(`  ${a}`);

const bad = results.filter((r) => r.outcome.startsWith("error:"));
const count = (o: string) => results.filter((r) => r.outcome === o).length;
const expected = { attempt: 1, replay: 3, conflict: 1, proof: 2 };
const ok =
  attempts.length === 1 &&
  bad.length === 0 &&
  count("attempt") === expected.attempt &&
  count("replay") === expected.replay &&
  count("conflict") === expected.conflict &&
  count("proof") === expected.proof;

if (bad.length) for (const r of bad) console.log(`unexpected: ${r.label} -> ${r.outcome}`);

console.log(
  ok
    ? "\nPASS: one settlement -> exactly one fiat attempt; the mismatched re-use, the " +
        "duplicate proof (before AND after a restart) were refused with no attempt, " +
        "and every refused caller was refused BEFORE the action."
    : `\nFAIL: expected 1 attempt / 3 replay / 1 conflict / 2 proof, got ` +
        `${count("attempt")} / ${count("replay")} / ${count("conflict")} / ${count("proof")} ` +
        `with ${attempts.length} attempts recorded`,
);
process.exit(ok ? 0 : 1);
