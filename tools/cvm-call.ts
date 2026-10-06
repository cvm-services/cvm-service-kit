/**
 * Minimal CVM client for testing: sends a gift-wrapped JSON-RPC request to a
 * server npub and prints the response. Deliberately uses a different key from
 * the server (sharing a key causes an echo loop).
 *
 * Usage:
 *   bun tools/cvm-call.ts <server-npub|hex> <tool> '<json-args>'
 *   bun tools/cvm-call.ts <server-npub|hex> --list
 */
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  nip44,
} from "nostr-tools";
import { Relay } from "nostr-tools/relay";

const RELAYS = (
  process.env.RELAYS ??
  "wss://nostr.mom,wss://relay.primal.net,wss://nos.lol,wss://relay2.contextvm.org"
)
  .split(",")
  .map((s) => s.trim());

function toHex(pk: string): string {
  if (/^[0-9a-fA-F]{64}$/.test(pk)) return pk;
  const d = nip19.decode(pk);
  if (d.type !== "npub") throw new Error("expected npub");
  return d.data as string;
}

const [, , serverArg, tool, argsJson] = process.argv;
if (!serverArg || !tool) {
  console.error("usage: cvm-call <npub|hex> <tool|--list> ['<json-args>']");
  process.exit(2);
}
const serverPk = toHex(serverArg);
const clientSk = generateSecretKey();
const clientPk = getPublicKey(clientSk);
const id = Math.floor(Math.random() * 1e9);

const rpc = tool === "--list"
  ? { jsonrpc: "2.0", id, method: "tools/list", params: {} }
  : {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} },
    };

const relays: Relay[] = [];
for (const url of RELAYS) {
  try {
    const relay = await Promise.race([
      Relay.connect(url),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
    ]);
    relays.push(relay);
  } catch {
    /* skip */
  }
}
if (!relays.length) throw new Error("no relays connected");

const done = new Promise<void>((resolve) => {
  for (const relay of relays) {
    relay.subscribe([{ kinds: [1059, 21059], limit: 0 }], {
      onevent: (event) => {
        const p = event.tags?.find((t) => t[0] === "p");
        if (!p || p[1] !== clientPk) return;
        const convKey = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
        let inner: any;
        try {
          inner = JSON.parse(nip44.v2.decrypt(event.content, convKey));
        } catch {
          return;
        }
        const resp = JSON.parse(inner.content);
        if (resp.id !== id) return;
        console.log(JSON.stringify(resp, null, 2));
        resolve();
      },
    });
  }
});

const inner = finalizeEvent(
  {
    kind: 25910,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", serverPk]],
    content: JSON.stringify(rpc),
  },
  clientSk,
);
const wrapSk = generateSecretKey();
const wrapPk = getPublicKey(wrapSk);
const convKey = nip44.v2.utils.getConversationKey(wrapSk, serverPk);
const encrypted = nip44.v2.encrypt(JSON.stringify(inner), convKey);
const giftWrap = finalizeEvent(
  {
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", serverPk]],
    content: encrypted,
    pubkey: wrapPk,
  } as any,
  wrapSk,
);

for (const r of relays) await r.publish(giftWrap).catch(() => {});
console.error(`sent ${tool} to ${serverPk} via ${relays.length} relays; waiting...`);

await Promise.race([done, new Promise((r) => setTimeout(r, 30000))]);
for (const r of relays) r.close();
process.exit(0);
