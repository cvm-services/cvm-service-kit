/**
 * adapter.ts — the LOCAL balance-adapter interface this service codes against.
 *
 * IMPORTANT: this file is an INTERFACE + a clearly-labelled stub, nothing more.
 * The real adapter is a separate PRIVATE project (operator decision 2026-10-07)
 * that runs on the operator's own machine and is the only component in the
 * 2fiat setup that ever touches card material. It exposes exactly three
 * things to this service: a balance, a capability report, and a checkout
 * status - never a card number, never a CVV, never a session token.
 *
 * The deployed service speaks to it over a local UNIX socket or loopback HTTP
 * (ADAPTER_URL), and ONLY when the caller is the allow-listed owner npub.
 */

export interface AdapterBalance {
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
  /** Decimal string, e.g. "20.00" - never a float (money is not binary). */
  amount: string;
  /** ISO-8601 timestamp of the read. */
  as_of: string;
}

export interface AdapterCapabilities {
  card_present: boolean;
  /** Always false: 2fiat is an issuer portal; no authorize endpoint exists. */
  can_authorize: false;
  needs_human_3ds: true;
  adapter: "local";
}

export interface AdapterCheckoutResult {
  status: "human_required" | "completed" | "failed";
  order_id: string;
}

/** The interface the private local adapter implements (see its docs/SCOPE.md §6). */
export interface LocalBalanceAdapter {
  balance(): Promise<AdapterBalance>;
  capabilities(): Promise<AdapterCapabilities>;
  pay_checkout(url: string, max_amount: string): Promise<AdapterCheckoutResult>;
}

/**
 * A LOCAL adapter client: speaks loopback HTTP to the operator's private
 * process. There is no credential in this repo - the adapter holds the
 * session, not us. Any transport failure surfaces as an error the caller
 * sees; this client never invents a balance.
 */
export class HttpLocalAdapter implements LocalBalanceAdapter {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    if (!res.ok) throw new Error(`adapter ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  balance(): Promise<AdapterBalance> {
    return this.call("/balance");
  }

  capabilities(): Promise<AdapterCapabilities> {
    return this.call("/capabilities");
  }

  pay_checkout(url: string, max_amount: string): Promise<AdapterCheckoutResult> {
    return this.call("/pay-checkout", {
      method: "POST",
      body: JSON.stringify({ url, max_amount }),
    });
  }
}
