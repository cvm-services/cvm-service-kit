import {
  callHttp,
  parseChallengeBody,
  type FetchLike,
  type L402Challenge,
  type LnWallet,
} from "../../../src/index.ts";

const TERMINAL = new Set(["completed", "refunded", "failed", "expired", "cancelled"]);

export type OrderType = "receive-sms" | "receive-sms-reactivate" | "rent-number";

export interface OrderQuote {
  status: number;
  orderId: string | null;
  costSats: number;
  challenge: L402Challenge | null;
  raw: any;
}

export interface PollOptions {
  intervalMs?: number;
  attempts?: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Client for the sms4sats L402 + email APIs (see https://api.sms4sats.com/skill.md). */
export class Sms4SatsClient {
  private readonly fetchImpl: FetchLike;
  readonly base: string;

  constructor(
    opts: { baseUrl?: string; fetchImpl?: FetchLike } = {},
  ) {
    this.base = (opts.baseUrl ?? "https://api.sms4sats.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private http(spec: Parameters<typeof callHttp>[0], args: Record<string, unknown> = {}) {
    return callHttp(spec, args, { fetchImpl: this.fetchImpl });
  }

  health(): Promise<any> {
    return this.http({ url: `${this.base}/health` });
  }

  /** List service codes (tg, go, wa, …). */
  services(): Promise<any> {
    return this.http({ url: `${this.base}/v2/l402/services` });
  }

  /** List SMS/rent offers by country/service. */
  catalog(country?: string, service?: string): Promise<any> {
    return this.http({
      url: `${this.base}/v2/l402/catalog`,
      query: { country: country ?? "", service: service ?? "" },
    });
  }

  /**
   * Create an L402 order and capture the 402 challenge (invoice + macaroon),
   * cost and order id WITHOUT paying. The treasury pays on the paid retry.
   */
  async requestOrder(body: Record<string, unknown>): Promise<OrderQuote> {
    const r = await this.http({ method: "POST", url: `${this.base}/v2/l402/order`, body });
    return {
      status: r.status,
      orderId: r.body?.orderId ?? r.body?.order_id ?? r.body?.id ?? null,
      costSats: Number(r.body?.priceSats ?? r.body?.price_sats ?? r.body?.amountSats ?? 0),
      challenge: parseChallengeBody(r.body),
      raw: r.body,
    };
  }

  /** Pay a captured challenge, then poll the order until terminal or timeout. */
  async payAndPoll(
    orderId: string,
    challenge: L402Challenge,
    wallet: LnWallet,
    opts: PollOptions = {},
  ): Promise<any> {
    const receipt = await wallet.payInvoice(challenge.invoice);
    const auth = `L402 ${challenge.macaroon}:${receipt.preimage}`;
    const interval = opts.intervalMs ?? 5000;
    const attempts = opts.attempts ?? 240; // ~20 min
    let last: any = null;
    for (let i = 0; i < attempts; i++) {
      const r = await this.http({
        url: `${this.base}/v2/l402/order/${orderId}`,
        headers: { Authorization: auth },
      });
      last = r.body;
      if (last?.status && TERMINAL.has(last.status)) return last;
      if (last?.status === "code_received") return last;
      await sleep(interval);
    }
    return last;
  }

  // --- email activation (no L402; returns orderId + payreq + priceSats) ---

  emailDomains(site: string): Promise<any> {
    return this.http({ url: `${this.base}/v2/emails/domains`, query: { site } });
  }

  async requestEmail(site: string, domain: string): Promise<{ orderId: string; invoice: string; costSats: number; raw: any }> {
    const r = await this.http({
      method: "POST",
      url: `${this.base}/v2/emails`,
      body: { site, domain },
    });
    return {
      orderId: r.body?.orderId ?? r.body?.order_id ?? "",
      invoice: r.body?.payreq ?? r.body?.invoice ?? "",
      costSats: Number(r.body?.priceSats ?? r.body?.price_sats ?? 0),
      raw: r.body,
    };
  }

  emailStatus(orderId: string): Promise<any> {
    return this.http({ url: `${this.base}/v2/emails/${orderId}` });
  }
}
