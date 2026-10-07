/**
 * Mint a testnut Cashu token for testing the paid flow. TEST ONLY.
 *   MINT=https://testnut.cashu.exchange bun tools/mint-testnut.ts 2
 * Prints the encoded token on stdout (progress on stderr).
 */
import { getEncodedToken, Wallet } from "@cashu/cashu-ts";

const MINT = process.env.MINT ?? "https://testnut.cashu.exchange";
const amount = Number(process.argv[2] ?? 2);

const wallet = new Wallet(MINT);
await wallet.loadMint();
const quote = await wallet.createMintQuoteBolt11(amount);
console.error(`quote=${quote.quote} state=${quote.state}`);

let state = quote.state;
for (let i = 0; i < 40; i++) {
  const q = await wallet.checkMintQuoteBolt11(quote.quote);
  state = q.state;
  if (state === "PAID" || state === "ISSUED") break;
  await new Promise((r) => setTimeout(r, 2000));
}
if (state !== "PAID" && state !== "ISSUED") {
  console.error(`quote not paid (state=${state})`);
  process.exit(1);
}
const proofs = await wallet.mintProofsBolt11(amount, quote.quote);
console.log(getEncodedToken({ mint: MINT, proofs }));
