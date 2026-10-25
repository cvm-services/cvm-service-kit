// Pay ONE BOLT11 from the treasury using the PROVEN NwcLnWallet client.
// Runs inside cvm-service-kit so npm:nostr-tools resolves.
//
// A timeout is not a failure. This pays at most once and never retries; the
// caller proves the effect by polling the destination (the 2fiat card balance).
import { NwcLnWallet } from "../src/lnwallet.ts";

const bolt11 = await Deno.readTextFile("/tmp/r3_bolt11.txt").then((s) => s.trim());
if (!/^lnbc/i.test(bolt11)) {
  console.error("no bolt11 in /tmp/r3_bolt11.txt");
  Deno.exit(2);
}
const nwcUrl = Deno.env.get("NWC_URL") ?? "";
if (!nwcUrl) { console.error("NWC_URL not set"); Deno.exit(2); }

const w = new NwcLnWallet(nwcUrl, { timeoutMs: 60_000 });

const before = await w.balanceSats();
console.log("treasury before:", before, "sats");

console.log("paying once (no retry, even on timeout)...");
const t0 = Date.now();
let receipt: { preimage?: string } | null = null;
try {
  receipt = await w.payInvoice(bolt11);
  console.log("PREIMAGE PRESENT — executed in", Date.now() - t0, "ms");
} catch (e) {
  console.log("payment threw after", Date.now() - t0, "ms:", (e as Error).name);
  console.log("OUTCOME UNKNOWN — not retrying. Card balance is the authority.");
}

try {
  const after = await w.balanceSats();
  console.log("treasury after:", after, "sats | spent:", before - after);
} catch {
  console.log("balance re-read failed (broker silent); card balance decides");
}
