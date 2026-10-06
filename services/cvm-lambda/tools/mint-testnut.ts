/**
 * Mint a testnut Cashu token for testing the paid flow. TEST ONLY.
 *   MINT=https://testnut.cashu.exchange bun tools/mint-testnut.ts 2
 * Prints the encoded token on stdout (progress on stderr).
 */
import { CashuMint, CashuWallet, getEncodedToken } from "@cashu/cashu-ts";

const MINT = process.env.MINT ?? "https://testnut.cashu.exchange";
const amount = Number(process.argv[2] ?? 2);

const wallet = new CashuWallet(new CashuMint(MINT));
await wallet.loadMint();
const quote = await wallet.createMintQuote(amount);
console.error(`quote=${quote.quote} state=${quote.state}`);

let q = quote;
for (let i = 0; i < 40; i++) {
  q = await wallet.checkMintQuote(quote);
  if (q.state === "PAID" || q.state === "ISSUED") break;
  await new Promise((r) => setTimeout(r, 2000));
}
if (q.state !== "PAID" && q.state !== "ISSUED") {
  console.error(`quote not paid (state=${q.state})`);
  process.exit(1);
}
const proofs = await wallet.mintProofs(amount, q as any);
console.log(getEncodedToken({ mint: MINT, proofs }));
