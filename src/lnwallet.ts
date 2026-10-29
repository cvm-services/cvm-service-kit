import { finalizeEvent, nip04, nip44, type Event } from "nostr-tools";
import { Relay } from "nostr-tools/relay";
import { NwcErrorReply, NwcTimeout, describeNwcFailure } from "./nwc_errors.ts";

export interface MintedInvoice {
  bolt11: string;
  paymentHash: string;
}

export interface PaymentReceipt {
  preimage: string;
  feeSats?: number;
}

export type InvoiceState = "settled" | "pending" | "failed";

export interface InvoiceStatus {
  state: InvoiceState;
  /** Present only when the rail proves settlement. */
  preimage?: string;
}

/**
 * Map an NWC `lookup_invoice` result onto our three states.
 *
 * Exported and pure because this mapping is where an "unknown" gets silently
 * promoted to "paid": some servers nest the payload under `transaction`, others
 * put it at the top level, and the state vocabulary differs per implementation.
 * Anything unrecognised stays `pending` - never settled - so a caller cannot
 * mistake a parsing surprise for money that arrived.
 */
export function mapLookupResult(result: unknown): InvoiceStatus {
  const r = (result ?? {}) as Record<string, unknown>;
  const tx = (r.transaction ?? r) as Record<string, unknown>;
  const raw = String(tx.state ?? tx.status ?? "").toLowerCase();
  const preimage = typeof tx.preimage === "string" && tx.preimage.trim() ? tx.preimage.trim() : undefined;

  if (["paid", "settled", "complete", "completed", "succeeded"].includes(raw)) {
    return preimage ? { state: "settled", preimage } : { state: "settled" };
  }
  if (["failed", "expired", "error"].includes(raw)) return { state: "failed" };
  return { state: "pending" };
}

/** Minimal Lightning wallet the reseller treasury needs. */
export interface LnWallet {
  /** Pay a BOLT11 invoice; returns the preimage (required for L402). */
  payInvoice(bolt11: string): Promise<PaymentReceipt>;
  /** Mint an invoice (used for upstream refunds). */
  makeInvoice(sats: number, memo?: string): Promise<MintedInvoice>;
  /** Current spendable balance in sats. */
  balanceSats(): Promise<number>;
  /**
   * Ask the rail what became of an invoice. Never sends anything.
   *
   * Needed because a payment that times out returns no answer: without this the
   * only options are "retry" (double-pay) or "give up" (lose the money).
   */
  lookupInvoice(bolt11: string): Promise<InvoiceStatus>;
}

export class FakeLnWallet implements LnWallet {
  balance: number;
  paid: string[] = [];
  minted: MintedInvoice[] = [];
  /** bolt11 -> status, so lookup can answer without a network. */
  statuses = new Map<string, InvoiceStatus>();
  private n = 0;

  constructor(balance = 1_000_000) {
    this.balance = balance;
  }

  async payInvoice(bolt11: string): Promise<PaymentReceipt> {
    const amount = invoiceAmountSats(bolt11);
    if (amount !== null && amount > this.balance) {
      throw new Error("insufficient balance");
    }
    if (amount !== null) this.balance -= amount;
    this.paid.push(bolt11);
    const preimage = `preimage-${++this.n}`;
    this.statuses.set(bolt11, { state: "settled", preimage });
    return { preimage };
  }

  async makeInvoice(sats: number, memo?: string): Promise<MintedInvoice> {
    const inv = { bolt11: `lnbc${sats}n1fake${++this.n}`, paymentHash: `hash-${this.n}` };
    this.minted.push(inv);
    return inv;
  }

  async balanceSats(): Promise<number> {
    return this.balance;
  }

  async lookupInvoice(bolt11: string): Promise<InvoiceStatus> {
    return this.statuses.get(bolt11) ?? { state: "pending" };
  }
}

/**
 * Parse a BOLT11 amount. Minimal: handles the common `lnbc<amount><multiplier>`
 * prefix (m/u/n/p) for amounts, returns null for amountless invoices.
 */
export function invoiceAmountSats(bolt11: string): number | null {
  const m = /^lnbc(?:rt|tb)?([0-9]+)([munp]?)/i.exec(bolt11);
  if (!m || !m[1]) return null;
  const value = Number(m[1]);
  const mult = m[2]?.toLowerCase();
  const btc = 100_000_000;
  switch (mult) {
    case "":
      return value * btc;
    case "m":
      return (value / 1000) * btc;
    case "u":
      return (value / 1_000_000) * btc;
    case "n":
      return (value / 1_000_000_000) * btc;
    case "p":
      return (value / 1_000_000_000_000) * btc;
    default:
      return null;
  }
}

/**
 * Nostr Wallet Connect (NIP-47) wallet. NWC URI form:
 *   nostr+walletconnect://<wallet-pubkey-hex>?relay=wss://...&secret=<hex>&encryption=nip44
 */
export class NwcLnWallet implements LnWallet {
  private readonly walletPubkey: string;
  private readonly relayUrl: string;
  private readonly secret: Uint8Array;
  private readonly encryption: "nip04" | "nip44";
  private relay?: Relay;
  private readonly timeoutMs: number;
  private lastDecryptScheme: "nip04" | "nip44" | "none" = "none";

  constructor(nwcUrl: string, opts: { timeoutMs?: number } = {}) {
    const u = new URL(nwcUrl.replace(/^nostr\+walletconnect:\/\//, "https://"));
    this.walletPubkey = u.hostname;
    const relay = u.searchParams.get("relay");
    const secretHex = u.searchParams.get("secret");
    if (!relay || !secretHex) throw new Error("NWC URI missing relay or secret");
    this.relayUrl = relay;
    this.secret = new Uint8Array(secretHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    this.encryption = u.searchParams.get("encryption") === "nip44" ? "nip44" : "nip04";
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async connect(): Promise<Relay> {
    if (!this.relay) {
      this.relay = await Relay.connect(this.relayUrl);
    }
    return this.relay;
  }

  private async encrypt(plaintext: string): Promise<string> {
    if (this.encryption === "nip44") {
      const key = nip44.v2.utils.getConversationKey(this.secret, this.walletPubkey);
      return nip44.v2.encrypt(plaintext, key);
    }
    return nip04.encrypt(this.secret, this.walletPubkey, plaintext);
  }

  private async decrypt(ciphertext: string): Promise<string> {
    if (this.encryption === "nip44") {
      const key = nip44.v2.utils.getConversationKey(this.secret, this.walletPubkey);
      return nip44.v2.decrypt(ciphertext, key);
    }
    return nip04.decrypt(this.secret, this.walletPubkey, ciphertext);
  }

  private async request(method: string, params: Record<string, unknown>): Promise<any> {
    const relay = await this.connect();
    const payload = JSON.stringify({ method, params });
    const content = await this.encrypt(payload);
    const reqEvent: Event = finalizeEvent(
      {
        kind: 23194,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.walletPubkey]],
        content,
      },
      this.secret,
    );

    let eventsSeen = 0;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.close();
        const err = new NwcTimeout(method, eventsSeen === 0 ? "no-reply" : "reply-not-usable");
        // Attach the diagnostic so the message distinguishes silence from an
        // undecryptable reply, and warns about retry safety on spending methods.
        err.message = describeNwcFailure(err, { eventsSeen, decryptScheme: this.lastDecryptScheme });
        reject(err);
      }, this.timeoutMs);
      const sub = relay.subscribe([{ kinds: [23195], authors: [this.walletPubkey], limit: 0 }], {
        onevent: async (event: any) => {
          const eTag = event.tags?.find((t: string[]) => t[0] === "e");
          if (eTag && eTag[1] !== reqEvent.id) return;
          // Count every candidate reply BEFORE trying to read it, so "no reply" is
          // distinguishable from "a reply we could not read". The previous version
          // swallowed undecryptable events silently, which made a real answer look
          // exactly like silence and cost a debugging session.
          eventsSeen += 1;
          let plain: string | null = null;
          let scheme: "nip04" | "nip44" | "none" = "none";
          // Try the declared scheme, then the other one. A wallet that answers with a
          // different scheme is still answering.
          try {
            plain = this.encryption === "nip04"
              ? await nip04.decrypt(this.secret, this.walletPubkey, event.content)
              : nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(this.secret, this.walletPubkey));
            scheme = this.encryption;
          } catch {
            try {
              plain = this.encryption === "nip04"
                ? nip44.v2.decrypt(event.content, nip44.v2.utils.getConversationKey(this.secret, this.walletPubkey))
                : await nip04.decrypt(this.secret, this.walletPubkey, event.content);
              scheme = this.encryption === "nip04" ? "nip44" : "nip04";
            } catch {
              this.lastDecryptScheme = "none";
              return; // counted already; the timeout diagnostic will report it
            }
          }
          this.lastDecryptScheme = scheme;
          try {
            const msg = JSON.parse(plain!);
            clearTimeout(timer);
            sub.close();
            if (msg.error) {
              reject(new NwcErrorReply(method, String(msg.error?.code ?? "unknown"),
                String(msg.error?.message ?? JSON.stringify(msg.error))));
              return;
            }
            resolve(msg.result);
          } catch {
            // A decrypted but unparseable reply is still a protocol failure worth
            // surfacing rather than swallowing.
            clearTimeout(timer);
            sub.close();
            reject(new NwcErrorReply(method, "unparseable", String(plain).slice(0, 120)));
          }
        },
      });
      relay.publish(reqEvent).catch((e: any) => {
        clearTimeout(timer);
        sub.close();
        reject(e);
      });
    });
  }

  async payInvoice(bolt11: string): Promise<PaymentReceipt> {
    const result = await this.request("pay_invoice", { invoice: bolt11 });
    return { preimage: result.preimage, feeSats: result.fees_paid ? Math.ceil(result.fees_paid / 1000) : undefined };
  }

  async makeInvoice(sats: number, memo?: string): Promise<MintedInvoice> {
    const result = await this.request("make_invoice", {
      amount: sats * 1000,
      description: memo ?? "",
    });
    return { bolt11: result.invoice, paymentHash: result.payment_hash };
  }

  async balanceSats(): Promise<number> {
    const result = await this.request("get_balance", {});
    return Math.floor((result.balance ?? 0) / 1000);
  }

  /**
   * NIP-47 `lookup_invoice`, keyed by the invoice itself.
   *
   * Some wallets do not implement it. A failure here is NOT "not paid": the
   * method throws, and the caller must treat that as unknown rather than
   * inferring an outcome from an error.
   */
  async lookupInvoice(bolt11: string): Promise<InvoiceStatus> {
    const result = await this.request("lookup_invoice", { invoice: bolt11 });
    return mapLookupResult(result);
  }
}
