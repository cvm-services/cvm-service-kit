import {
  finalizeEvent,
  getPublicKey,
  nip44,
  type Event,
} from "nostr-tools";
import { Relay } from "nostr-tools/relay";
import type { CvmServerOptions, RelayLike, Tool } from "./types.ts";

export function secretKeyFrom(input: string | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length !== 32) throw new Error("secret key must be 32 bytes");
    return input;
  }
  const hex = input.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("secret key must be 64 hex chars (not nsec)");
  }
  return new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

export function pubkeyHexOf(sk: Uint8Array): string {
  return getPublicKey(sk);
}

const RELAY_TIMEOUT_MS = 10_000;
const PUBLISH_TIMEOUT_MS = 10_000;

async function connectWithTimeout(url: string): Promise<RelayLike> {
  const relay = await Promise.race([
    Relay.connect(url),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout connecting ${url}`)), RELAY_TIMEOUT_MS),
    ),
  ]);
  return relay as unknown as RelayLike;
}

/**
 * Format a relay-close "reason" of any shape into one log-safe string.
 *
 * The kit's RelayLike type used to declare `reasons: string[]`, but that was
 * never what nostr-tools sends: AbstractRelay calls the SUBSCRIPTION onclose
 * with a single string (`this.onclose?.(reason)`) and the RELAY-level onclose
 * with no argument at all — and future versions may hand over a CloseEvent.
 * Assuming `.join` here threw `TypeError: reasons?.join is not a function`
 * inside the close handler and restart-looped every deployed unit
 * (observed 2026-10-07: NRestarts 11-12 across all four services, hidden by
 * Restart=always). Never assume the shape; stringify defensively.
 */
function formatCloseReason(reasons: unknown): string {
  if (reasons == null) return "";
  if (Array.isArray(reasons)) {
    return reasons.map(formatCloseReason).filter(Boolean).join(",");
  }
  if (reasons instanceof Error) return reasons.message;
  if (typeof reasons === "object") {
    const { code, reason } = reasons as { code?: unknown; reason?: unknown };
    const parts: string[] = [];
    if (typeof code === "number") parts.push(String(code));
    if (typeof reason === "string" && reason) parts.push(reason);
    return parts.join(" ") || "closed";
  }
  return String(reasons);
}

/**
 * Minimal CVM server: subscribes to gift-wrapped kind 1059 events addressed to
 * its pubkey, decrypts the inner kind 25910 JSON-RPC, dispatches MCP tools, and
 * sends the gift-wrapped response back.
 *
 * NOTE: intentionally does NOT use @contextvm/sdk's NostrServerTransport, which
 * silently hangs. This is the verified direct-nostr-tools path.
 */
export class CvmServer {
  readonly secretKey: Uint8Array;
  readonly pubkey: string;
  private readonly opts: CvmServerOptions;
  private readonly tools = new Map<string, Tool>();
  private relays: RelayLike[] = [];
  // Gift-wrap events arrive once per relay the client published to. Process
  // each event id exactly once, or a paid call runs (and pays) N times.
  private seen = new Map<string, number>();
  private readonly seenTtlMs = 10 * 60_000;

  constructor(opts: CvmServerOptions) {
    this.opts = opts;
    this.secretKey = secretKeyFrom(opts.secretKey);
    this.pubkey = getPublicKey(this.secretKey);
    for (const t of opts.tools) this.tools.set(t.definition.name, t);
  }

  private log(line: string): void {
    this.opts.onLog?.(line);
  }

  async start(): Promise<void> {
    for (const url of this.opts.relays) {
      try {
        const relay = await connectWithTimeout(url);
        relay.subscribe([{ kinds: [1059, 21059], limit: 0 }], {
          onevent: (event: any) => {
            // Relay #p filtering is unreliable for gift-wrap kinds (NIP-12 gap):
            // subscribe broadly and filter client-side.
            const p = event?.tags?.find((t: string[]) => t[0] === "p");
            if (!p || p[1] !== this.pubkey) return;
            void this.handleGiftWrap(event).catch((e) =>
              this.log(`handle error: ${e?.message ?? e}`),
            );
          },
          onclose: (reasons: unknown) =>
            this.log(`relay closed ${url}: ${formatCloseReason(reasons)}`),
        });
        this.relays.push(relay);
        this.log(`connected ${url}`);
      } catch (e: any) {
        this.log(`failed ${url}: ${e?.message ?? e}`);
      }
    }
    if (this.relays.length === 0) throw new Error("no relays connected");
  }

  stop(): void {
    for (const r of this.relays) {
      try {
        r.close?.();
      } catch {
        /* ignore */
      }
    }
    this.relays = [];
  }

  private isDuplicate(eventId: string): boolean {
    const now = Date.now();
    if (this.seen.size > 5000) {
      for (const [id, t] of this.seen) if (now - t > this.seenTtlMs) this.seen.delete(id);
    }
    if (this.seen.has(eventId)) return true;
    this.seen.set(eventId, now);
    return false;
  }

  private async handleGiftWrap(event: any): Promise<void> {
    if (this.isDuplicate(event.id)) return;
    const convKey = nip44.v2.utils.getConversationKey(
      this.secretKey,
      event.pubkey,
    );
    const decrypted = nip44.v2.decrypt(event.content, convKey);
    const inner = JSON.parse(decrypted);
    const clientPk: string = inner.pubkey;

    if (clientPk === this.pubkey) {
      this.log("ignoring self-addressed request (client and server share a key)");
      return;
    }

    let rpc: any;
    try {
      rpc = JSON.parse(inner.content);
    } catch {
      return;
    }

    const response = await this.handleRpc(rpc, clientPk);
    if (response === undefined) return; // notification, no reply
    await this.sendGiftWrapped(response, clientPk);
  }

  /** Dispatch one JSON-RPC request. Public for tests and embedding. */
  async handleRpc(rpc: any, caller: string): Promise<any | undefined> {
    const { id, method, params } = rpc ?? {};
    if (id === undefined || id === null) return undefined; // notification

    try {
      switch (method) {
        case "initialize":
          return ok(id, {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: this.opts.name,
              version: this.opts.version ?? "1.0.0",
            },
          });
        case "ping":
          return ok(id, {});
        case "tools/list":
          return ok(id, {
            tools: [...this.tools.values()].map((t) => ({
              name: t.definition.name,
              description: t.definition.description,
              inputSchema: t.definition.inputSchema,
            })),
          });
        case "tools/call": {
          const name = params?.name;
          const tool = this.tools.get(name);
          if (!tool) {
            return err(id, -32602, `unknown tool: ${name}`);
          }
          const result = await tool.handler(params?.arguments ?? {}, { caller });
          const text =
            typeof result === "string" ? result : JSON.stringify(result);
          return ok(id, { content: [{ type: "text", text }], isError: false });
        }
        default:
          return err(id, -32601, `method not found: ${method}`);
      }
    } catch (e: any) {
      // Domain errors (payment_required, treasury_insufficient, …) carry a
      // JSON-RPC code + data; surface them as protocol errors.
      if (e && typeof e.code === "number" && e.code < 0 && e.data) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: e.code, message: e.message, data: e.data },
        };
      }
      return ok(id, {
        content: [{ type: "text", text: `error: ${e?.message ?? e}` }],
        isError: true,
      });
    }
  }

  private async sendGiftWrapped(message: unknown, recipientPk: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const inner = finalizeEvent(
      {
        kind: 25910,
        created_at: now,
        tags: [["p", recipientPk]],
        content: JSON.stringify(message),
      },
      this.secretKey,
    );
    const wrapSk = new Uint8Array(32);
    crypto.getRandomValues(wrapSk);
    const wrapPk = getPublicKey(wrapSk);
    const convKey = nip44.v2.utils.getConversationKey(wrapSk, recipientPk);
    const encrypted = nip44.v2.encrypt(JSON.stringify(inner), convKey);
    const giftWrap = finalizeEvent(
      {
        kind: 1059,
        created_at: now,
        tags: [["p", recipientPk]],
        content: encrypted,
        pubkey: wrapPk,
      } as any,
      wrapSk,
    );
    await this.publishToAll(giftWrap, "publish failed");
  }

  /**
   * Publish one event to every connected relay CONCURRENTLY, each bounded by
   * a per-relay deadline. The old sequential `for … await` loop let a single
   * relay whose publish() never settles (dead TCP, half-open socket, a relay
   * that accepts the frame and never replies OK) wedge the whole loop, so the
   * event was never even attempted on the remaining healthy relays — one bad
   * relay suppressed all delivery. Each relay is raced against its own
   * timeout; failures are logged and dropped, never awaited forever.
   */
  private async publishToAll(event: Event, errPrefix: string): Promise<void> {
    const timeoutMs = this.opts.publishTimeoutMs ?? PUBLISH_TIMEOUT_MS;
    await Promise.all(
      this.relays.map((r) =>
        Promise.race([
          // async IIFE, NOT `r.publish().catch(...)`: a publish() that throws
          // SYNCHRONOUSLY (before returning a promise) would escape a plain
          // `.catch` chain, reject this Promise.all and starve every other
          // relay — the very failure this method exists to prevent. The IIFE
          // converts both sync throws and async rejections into one caught,
          // logged path. (`Promise.resolve(r.publish(...))` would NOT fix it:
          // the argument is still evaluated before the wrapper exists.)
          (async () => {
            try {
              await r.publish(event);
            } catch (e: any) {
              this.log(`${errPrefix}: ${e?.message ?? e}`);
            }
          })(),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              this.log(`${errPrefix}: timeout after ${timeoutMs}ms`);
              resolve();
            }, timeoutMs),
          ),
        ]),
      ),
    );
  }

  /** Publish a signed replaceable/announcement event to all connected relays. */
  async publish(args: { kind: number; content: string; tags: string[][] }): Promise<Event> {
    const event = finalizeEvent(
      {
        kind: args.kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: args.tags,
        content: args.content,
      },
      this.secretKey,
    );
    await this.publishToAll(event, `publish ${args.kind} failed`);
    return event;
  }
}

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
