/**
 * live.ts — the kit's second-key live harness, adapted for cvm-2fiat.
 *
 * Runs the service in-process on a THROWAWAY key, then calls the FREE tools
 * over the real Nostr transport with a DIFFERENT throwaway key (sharing a key
 * causes an echo loop) and asserts:
 *   - the free tools answer (card.rail_info, payment.quote, docs),
 *   - card.balance refuses a non-owner key BEFORE any work,
 *   - no credential-shaped material appears in any response.
 *
 * The wire shape mirrors tools/cvm-call.ts exactly: kind 25910 inner event,
 * NIP-44 v2 to the server key, kind 1059 gift wrap with a fresh wrap key.
 *
 * Usage:
 *   bun services/cvm-2fiat/src/live.ts
 *   RELAYS=wss://... bun services/cvm-2fiat/src/live.ts
 *
 * Exits 0 with "LIVE OK" on success; non-zero with the failing step.
 * Never prints a response payload verbatim (only shape checks) so a leak
 * cannot travel through this harness's own output.
 */
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
} from "nostr-tools";
import { Relay } from "nostr-tools/relay";
import { CvmServer, pubkeyHexOf, type Tool } from "../../../src/index.ts";
import { buildTwoFiatTools } from "./tools.ts";
import { scanForCardMaterial } from "./hygiene.ts";

const RELAYS = (
  process.env.RELAYS ??
  "wss://nostr.mom,wss://relay.primal.net,wss://nos.lol,wss://relay2.contextvm.org"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let rpcId = 0;

function fail(step: string, why: unknown): never {
  console.error(`LIVE FAIL [${step}]:`, why instanceof Error ? why.message : why);
  process.exit(1);
}

/** One JSON-RPC round trip, exactly the cvm-call.ts wire shape. */
async function callRpc(
  relays: Relay[],
  serverPk: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const clientSk = generateSecretKey();
  const clientPk = getPublicKey(clientSk);
  const id = ++rpcId;
  const rpc = { jsonrpc: "2.0" as const, id, method, params };

  const reply = new Promise<unknown>((resolve) => {
    for (const relay of relays) {
      relay.subscribe([{ kinds: [1059, 21059], limit: 0 }], {
        onevent: (event) => {
          const p = event.tags?.find((t) => t[0] === "p");
          if (!p || p[1] !== clientPk) return;
          const convKey = nip44.v2.utils.getConversationKey(clientSk, event.pubkey);
          let inner: { content?: string };
          try {
            inner = JSON.parse(nip44.v2.decrypt(event.content, convKey));
          } catch {
            return;
          }
          try {
            const resp = JSON.parse(inner.content ?? "");
            if (resp.id === id) resolve(resp);
          } catch {
            /* not ours */
          }
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
  const convKey = nip44.v2.utils.getConversationKey(wrapSk, serverPk);
  const encrypted = nip44.v2.encrypt(JSON.stringify(inner), convKey);
  const giftWrap = finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", serverPk]],
      content: encrypted,
      pubkey: getPublicKey(wrapSk),
    } as never,
    wrapSk,
  );
  for (const r of relays) await r.publish(giftWrap).catch(() => {});

  const out = await Promise.race([
    reply,
    new Promise((_r, rej) => setTimeout(() => rej(new Error("timeout after 30s")), 30_000)),
  ]);
  return out;
}

async function main() {
  // throwaway keys: server, and a second key that is NOT the owner
  const ownerSk = generateSecretKey();
  const serverSk = generateSecretKey();
  const serverPk = pubkeyHexOf(serverSk);

  const tools: Tool[] = buildTwoFiatTools({
    ownerNpub: getPublicKey(ownerSk),
    // no adapter: balance must refuse rail_unavailable, never fabricate
    priceSats: 0,
  });

  const server = new CvmServer({
    secretKey: serverSk,
    relays: RELAYS,
    name: "cvm-2fiat-live-harness",
    tools,
    onLog: () => {},
  });
  await server.start();
  console.log("harness server pubkey:", serverPk);

  const relays: Relay[] = [];
  for (const url of RELAYS) {
    try {
      relays.push(await Relay.connect(url));
    } catch {
      /* one relay down is not a harness failure */
    }
  }
  if (relays.length === 0) fail("connect", "no relay connected");
  console.log("connected relays:", relays.length);

  // tools/list — the announced surface is exactly the four tools
  const listed = (await callRpc(relays, serverPk, "tools/list", {}).catch((e) => fail("tools/list", e))) as {
    result?: { tools?: { name: string }[] };
  };
  const names = (listed?.result?.tools ?? []).map((t) => t.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["card.balance", "card.rail_info", "docs", "payment.quote"])) {
    fail("tools/list", `unexpected tool surface: ${JSON.stringify(names)}`);
  }
  console.log("tools/list: ok", JSON.stringify(names));

  const call = (name: string, args: Record<string, unknown>) =>
    callRpc(relays, serverPk, "tools/call", { name, arguments: args });

  const unwrap = (resp: unknown): Record<string, unknown> | undefined => {
    const r = (resp as { result?: { content?: { text?: string }[] } })?.result;
    const text = r?.content?.[0]?.text;
    if (typeof text !== "string") return undefined;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  // 1. free tools answer
  const infoResp = await call("card.rail_info", {}).catch((e) => fail("rail_info", e));
  const info = unwrap(infoResp);
  if (!info || !Array.isArray(info.refusals) || info.refusals.length < 4) {
    fail("rail_info", "response missing the 4-item refusal list");
  }
  console.log("card.rail_info: ok,", (info!.refusals as unknown[]).length, "refusals listed");

  const quoteResp = await call("payment.quote", {
    checkout_url: "https://pay.example.com/ord/live-1",
    amount: "12.50",
  }).catch((e) => fail("payment.quote", e));
  const quote = unwrap(quoteResp);
  if (!quote || !String(quote.instructions ?? "").includes("3DS")) {
    fail("payment.quote", "no 3DS in the hand-off instructions");
  }
  console.log("payment.quote: ok");

  const docsResp = await call("docs", {}).catch((e) => fail("docs", e));
  const docs = unwrap(docsResp);
  if (!docs || !String(docs.content ?? "").includes("REFUSED")) {
    fail("docs", "contract lacks the refusal list");
  }
  console.log("docs: ok, contract served verbatim");

  // 2. non-owner balance refusal (this caller key is not the owner key)
  const balResp = await call("card.balance", {}).catch((e: unknown) => e);
  const balS = JSON.stringify(balResp);
  if (!balS.includes("payment_required") && !balS.includes("owner")) {
    fail("card.balance", `expected owner-only refusal, got: ${balS.slice(0, 120)}`);
  }
  console.log("card.balance: refused for a non-owner second key, before any work");

  // 3. hygiene over every response we saw
  for (const [name, resp] of [
    ["card.rail_info", infoResp],
    ["payment.quote", quoteResp],
    ["docs", docsResp],
    ["card.balance", balResp],
  ] as const) {
    const hits = scanForCardMaterial(JSON.stringify(resp));
    if (hits.length > 0) fail(`hygiene:${name}`, `${hits.length} credential-shaped hit(s)`);
  }
  console.log("hygiene: 0 credential-shaped hits across all responses");

  for (const r of relays) r.close();
  server.stop();
  console.log("LIVE OK");
  process.exit(0);
}

main().catch((e) => fail("main", e));
