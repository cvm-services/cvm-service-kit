/**
 * RED-BEFORE / GREEN-AFTER evidence for the escalation DM delivery bug found
 * while building card t_89dcb160.
 *
 * Both schemes below produce a kind-1059 gift wrap carrying a kind-14 DM. They
 * differ only in WHICH conversation key encrypts the payload:
 *
 *   BEFORE  encrypt with the CVM's own key   (getConversationKey(cvmSk, ownerPk))
 *           ... but sign the wrapper with a RANDOM key.
 *           The operator decrypts with getConversationKey(ownerSk, wrap.pubkey)
 *           -> a different shared secret -> the payload cannot be read AT ALL.
 *   AFTER   encrypt with the WRAPPER key     (getConversationKey(wrapSk, ownerPk))
 *           -> what src/transport.ts has always done, and what NostrDmSink now does.
 *
 * A test that only asserts "the content is not plaintext" passes on BEFORE. The
 * operator, in the real world, does not.
 *
 * Run:  bun run src/evidence/dm_delivery_before_after.ts
 * Exit: 0 when BEFORE is unreadable and AFTER is readable (the fix is real).
 */
import { finalizeEvent, getPublicKey, nip44 } from "nostr-tools";

const cvmSkHex = "a".repeat(64);
const ownerSkHex = "b".repeat(64);
const cvmSk = hexBytes(cvmSkHex);
const ownerSk = hexBytes(ownerSkHex);
const ownerPk = getPublicKey(ownerSk);
const text = "intent 7f3a needs a manual refund; sats proof settled";

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

function buildScheme(scheme: "before" | "after") {
  const inner = finalizeEvent(
    { kind: 14, created_at: 1, tags: [["p", ownerPk]], content: text },
    cvmSk,
  );
  const wrapSk = hexBytes("d".repeat(64));
  const wrapPk = getPublicKey(wrapSk);
  const convKey =
    scheme === "before"
      ? nip44.v2.utils.getConversationKey(cvmSk, ownerPk) // the bug
      : nip44.v2.utils.getConversationKey(wrapSk, ownerPk); // the fix
  const wrap = finalizeEvent(
    {
      kind: 1059,
      created_at: 1,
      tags: [["p", ownerPk]],
      content: nip44.v2.encrypt(JSON.stringify(inner), convKey),
      pubkey: wrapPk,
    } as never,
    wrapSk,
  );
  return wrap;
}

/** Exactly what the operator can do with the event as delivered. */
function operatorReads(wrap: { pubkey: string; content: string }): string | undefined {
  try {
    const convKey = nip44.v2.utils.getConversationKey(ownerSk, wrap.pubkey);
    const inner = JSON.parse(nip44.v2.decrypt(wrap.content, convKey)) as { content?: string };
    return inner.content;
  } catch {
    return undefined;
  }
}

const before = operatorReads(buildScheme("before"));
const after = operatorReads(buildScheme("after"));

console.log(`[before] ciphertext hides the text: ${!JSON.stringify(buildScheme("before")).includes(text)}`);
console.log(`[before] operator reads:             ${before === undefined ? "NOTHING (decryption fails)" : JSON.stringify(before)}`);
console.log(`[after]  operator reads:             ${JSON.stringify(after)}`);

const ok = before === undefined && after === text;
console.log(
  ok
    ? "PASS: the pre-fix scheme was undeliverable (undecryptable) and the fixed scheme round-trips to the operator."
    : `FAIL: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
);
process.exit(ok ? 0 : 1);
