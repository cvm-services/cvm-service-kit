/**
 * verify-live.ts — the live verification harness (READ-ONLY).
 *
 * Runs the REAL adapter against a REAL gerber zip through the REAL tool surface
 * and prints whatever the tool returned — a price or a refusal. It exists so the
 * live path is observable rather than promised, and so a stale session produces
 * the visible refusal it is supposed to rather than a fabricated number.
 *
 *   DISPLAY=:99 bun services/jlc-quote/src/verify-live.ts ~/jlc-quote-inputs/hub_v9.zip
 *
 * It never orders anything. It never prints a credential: the Chrome profile is
 * passed as a PATH.
 */
import { LiveJlcAdapter, liveConfigFromEnv } from "./adapter.ts";
import { isRefusal } from "./types.ts";
import { buildJlcQuoteTools } from "./tools.ts";

const zipPath = process.argv[2] ?? `${process.env.HOME}/jlc-quote-inputs/hub_v9.zip`;

const adapter = new LiveJlcAdapter(liveConfigFromEnv(process.env));
const tools = buildJlcQuoteTools({ adapter });
const quote = tools.find((t) => t.definition.name === "quote")!;

console.log(`[verify-live] quoting ${zipPath} (read-only; no order is placed)`);
const started = Date.now();
const out = await quote.handler({ zip_path: zipPath }, { caller: "0".repeat(64) });
console.log(`[verify-live] elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(out, null, 2));

if (isRefusal(out)) {
  console.log(`[verify-live] REFUSED reason=${out.reason} (this is a correct outcome, not a failure)`);
  process.exit(3);
}
console.log("[verify-live] PRICED: the numbers above came off the rendered page");
