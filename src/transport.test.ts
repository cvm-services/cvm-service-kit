import { describe, expect, test } from "bun:test";
import { CvmServer, pubkeyHexOf, secretKeyFrom } from "./transport.ts";
import { PaymentRequiredError } from "./payment.ts";
import type { RelayLike } from "./types.ts";
import { Relay } from "nostr-tools/relay";

// A real secp256k1 point: nip44 getConversationKey rejects non-points, so a
// recipient must be an actual derived pubkey, not an arbitrary hex string.
const RECIPIENT_PK = pubkeyHexOf(secretKeyFrom("04".repeat(32)));

function mkServer(tools: any[] = []) {
  return new CvmServer({
    secretKey: "01".repeat(32),
    relays: [],
    name: "test",
    tools: tools.length
      ? tools
      : [
          {
            definition: { name: "echo", description: "echo", inputSchema: {} },
            handler: (args: any) => ({ echoed: args.x }),
          },
        ],
  });
}

describe("secretKeyFrom", () => {
  test("accepts 64 hex chars", () => expect(secretKeyFrom("ab".repeat(32)).length).toBe(32));
  test("rejects nsec", () => expect(() => secretKeyFrom("nsec1abc")).toThrow(/hex/));
  test("rejects short hex", () => expect(() => secretKeyFrom("abcd")).toThrow(/hex/));
});

describe("handleRpc", () => {
  test("tools/list", async () => {
    const r = await mkServer().handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "ff");
    expect(r.result.tools[0].name).toBe("echo");
  });

  test("tools/call returns JSON text content", async () => {
    const r = await mkServer().handleRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { x: 7 } } },
      "ff",
    );
    expect(JSON.parse(r.result.content[0].text)).toEqual({ echoed: 7 });
  });

  test("unknown tool is a JSON-RPC error", async () => {
    const r = await mkServer().handleRpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } },
      "ff",
    );
    expect(r.error.code).toBe(-32602);
  });

  test("PaymentRequiredError becomes a payment_required error", async () => {
    const s = mkServer([
      {
        definition: { name: "paid", description: "paid", inputSchema: {} },
        handler: () => {
          throw new PaymentRequiredError("payment_required", {
            orderId: "o1",
            invoice: "lnbc...",
            amountSats: 10,
            paymentHash: "aa",
            pmi: "bitcoin-lightning-bolt11",
          });
        },
      },
    ]);
    const r = await s.handleRpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "paid", arguments: {} } },
      "ff",
    );
    expect(r.error.message).toBe("payment_required");
    expect(r.error.data.amountSats).toBe(10);
  });

  test("notification (no id) yields no response", async () => {
    const r = await mkServer().handleRpc({ jsonrpc: "2.0", method: "tools/list" }, "ff");
    expect(r).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Relay-close crash (card: restart-looping all four deployed services).
//
// nostr-tools 2.25.2 calls the subscription's onclose with a STRING reason
// (AbstractRelay.closeAllSubscriptions: `this.onclose?.(reason)`), and the
// relay-level onclose with NO argument — never the string[] the kit's type
// declared. The old handler did `reasons?.join(",")`, which throws
// "TypeError: reasons?.join is not a function" on a string and restart-loops
// the deployed unit (Restart=always hides it; observed 2026-10-07 on vps2:
// NRestarts 12/12/11/12 across cvm-sms4sats, cvm-ppq, cvm-nanogpt, cvm-lambda).
// ---------------------------------------------------------------------------

/** Drive the real start() → connectWithTimeout() → subscribe() wiring. */
function withFakeRelay(relayOverrides: Partial<RelayLike> = {}) {
  const captured: { onclose?: (reason?: unknown) => void } = {};
  const relay: RelayLike = {
    publish: () => Promise.resolve({}),
    subscribe: (_filters: unknown[], opts: any) => {
      captured.onclose = opts.onclose;
      return { close: () => {} };
    },
    close: () => {},
    ...relayOverrides,
  };
  const logs: string[] = [];
  const server = new CvmServer({
    secretKey: "02".repeat(32),
    relays: ["wss://fake.example"],
    name: "close-test",
    tools: [],
    onLog: (l) => logs.push(l),
  });
  // Replace Relay.connect in-place so start()'s connectWithTimeout resolves to
  // our fake relay: the production subscribe() call is the code under test.
  const realConnect = Relay.connect;
  Relay.connect = () => Promise.resolve(relay) as unknown as Promise<Relay>;
  return {
    server,
    relay,
    captured,
    logs,
    restore: () => {
      Relay.connect = realConnect;
    },
    start: () => server.start().then(() => captured),
  };
}

describe("relay close: onclose must survive every reasons shape", () => {
  test("nostr-tools 2.25.2 string reason does not throw", async () => {
    const h = withFakeRelay();
    try {
      const captured = await h.start();
      expect(() => captured.onclose!("connection closed")).not.toThrow();
    } finally {
      h.restore();
    }
  });

  test("CloseEvent-like object (no .join) does not throw", async () => {
    const h = withFakeRelay();
    try {
      const captured = await h.start();
      expect(() =>
        captured.onclose!({ code: 1006, reason: "abnormal closure", type: "close" }),
      ).not.toThrow();
    } finally {
      h.restore();
    }
  });

  test("undefined reasons (relay-level onclose, no args) does not throw", async () => {
    const h = withFakeRelay();
    try {
      const captured = await h.start();
      expect(() => captured.onclose!()).not.toThrow();
    } finally {
      h.restore();
    }
  });

  test("the close is logged, so a closed relay is observable in journalctl", async () => {
    const h = withFakeRelay();
    try {
      const captured = await h.start();
      captured.onclose!("connection closed");
      expect(h.logs.some((l) => l.includes("relay closed"))).toBe(true);
      expect((h.server as any).relays.length).toBe(1);
    } finally {
      h.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// A never-answering relay must not suppress delivery to a healthy relay.
//
// The old publish paths awaited relays sequentially (`for … await
// r.publish(ev)`), so a relay whose publish never settles wedges the loop and
// the event is never even attempted on the remaining healthy relays. The
// contract under test: publishes run concurrently, each bounded by a per-relay
// deadline; a stuck/dead relay is logged and dropped, not awaited forever.
// ---------------------------------------------------------------------------

describe("publish: a never-answering relay must not starve a healthy one", () => {
  async function startedPair(stuckPublish: () => Promise<unknown>) {
    const stuck: RelayLike = {
      publish: stuckPublish,
      subscribe: () => ({ close: () => {} }),
      close: () => {},
    };
    const healthy: unknown[] = [];
    const healthyRelay: RelayLike = {
      publish: (ev: unknown) => {
        healthy.push(ev);
        return Promise.resolve({});
      },
      subscribe: () => ({ close: () => {} }),
      close: () => {},
    };
    const logs: string[] = [];
    const server = new CvmServer({
      secretKey: "03".repeat(32),
      relays: ["wss://stuck.example", "wss://healthy.example"],
      name: "publish-test",
      tools: [],
      onLog: (l) => logs.push(l),
      publishTimeoutMs: 25,
    });
    const realConnect = Relay.connect;
    const queue = [stuck, healthyRelay];
    Relay.connect = () => Promise.resolve(queue.shift()) as unknown as Promise<Relay>;
    try {
      await server.start();
    } finally {
      Relay.connect = realConnect;
    }
    return { server, healthy, logs };
  }

  test("publish() delivers to the healthy relay despite a stuck sibling", async () => {
    const { server, healthy } = await startedPair(() => new Promise(() => {})); // never settles
    const ev = await server.publish({ kind: 1, content: "hello", tags: [] });
    expect(healthy.length).toBe(1);
    expect((ev as any).content).toBe("hello");
  });

  test("sendGiftWrapped delivers to the healthy relay despite a stuck sibling", async () => {
    const { server, healthy } = await startedPair(() => new Promise(() => {})); // never settles
    await (server as any).sendGiftWrapped({ jsonrpc: "2.0", id: 9, result: {} }, RECIPIENT_PK);
    expect(healthy.length).toBe(1);
  });

  test("a rejecting publish is logged, not thrown (both paths)", async () => {
    const { server, healthy, logs } = await startedPair(() =>
      Promise.reject(new Error("boom")),
    );
    await server.publish({ kind: 1, content: "x", tags: [] });
    await (server as any).sendGiftWrapped({ id: 1 }, RECIPIENT_PK);
    expect(logs.filter((l) => l.includes("publish")).length).toBe(2);
    expect(healthy.length).toBe(2);
  });
});

