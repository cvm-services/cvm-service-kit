import type { FetchLike } from "./http.ts";
import type { LnWallet } from "./lnwallet.ts";

export interface L402Challenge {
  macaroon: string;
  invoice: string;
}

/** Parse `WWW-Authenticate: L402 macaroon="...", invoice="..."`. */
export function parseWwwAuthenticate(header: string | null | undefined): L402Challenge | null {
  if (!header) return null;
  if (!/^L402/i.test(header.trim())) return null;
  const macaroon = /macaroon="([^"]+)"/.exec(header)?.[1];
  const invoice = /invoice="([^"]+)"/.exec(header)?.[1];
  if (!macaroon || !invoice) return null;
  return { macaroon, invoice };
}

/** Many L402 servers return the challenge in the 402 JSON body instead. */
export function parseChallengeBody(body: any): L402Challenge | null {
  if (!body || typeof body !== "object") return null;
  const macaroon = body.macaroon ?? body.token;
  const invoice = body.invoice ?? body.payreq ?? body.payment_request;
  if (typeof macaroon === "string" && typeof invoice === "string") {
    return { macaroon, invoice };
  }
  return null;
}

export interface L402Result {
  response: Response;
  body: any;
  preimage?: string;
  challenge?: L402Challenge;
}

/**
 * Perform a request; on `402 Payment Required`, pay the L402 invoice from the
 * wallet and replay with `Authorization: L402 <macaroon>:<preimage>`.
 */
export async function fetchWithL402(
  url: string,
  init: RequestInit,
  wallet: LnWallet,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<L402Result> {
  const fetchImpl = (opts.fetchImpl ?? fetch) as unknown as typeof fetch;

  const first = await fetchImpl(url, init);
  if (first.status !== 402) {
    return { response: first, body: await safeJson(first) };
  }

  let challenge = parseWwwAuthenticate(first.headers.get("www-authenticate"));
  let firstBody: any = null;
  if (!challenge) {
    firstBody = await safeJson(first);
    challenge = parseChallengeBody(firstBody);
  }
  if (!challenge) {
    return { response: first, body: firstBody };
  }

  const receipt = await wallet.payInvoice(challenge.invoice);

  const headers = new Headers(init.headers as any);
  headers.set("Authorization", `L402 ${challenge.macaroon}:${receipt.preimage}`);
  const second = await fetchImpl(url, { ...init, headers });
  return {
    response: second,
    body: await safeJson(second),
    preimage: receipt.preimage,
    challenge,
  };
}

async function safeJson(res: Response): Promise<any> {
  const raw = await res.text();
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return raw;
  }
}
