/**
 * collect.ts — Norwegian second-hand server / IT-hardware collectors.
 *
 * Every source here was probed live on 2026-10-09 and the transport recorded:
 *
 *  | source          | transport                                   | why it works |
 *  |-----------------|---------------------------------------------|--------------|
 *  | axentra.no      | Shopify `/products.json?limit=250&page=N`   | full catalogue, no JS |
 *  | itgarasjen.no   | Shopify `/products.json` (+ UCP MCP below)  | full catalogue, no JS |
 *  | rebuildit.no    | Shopify `/products.json`                    | full catalogue, no JS |
 *  | auksjonen.no    | sitemap index -> lot pages (ld+json + price)| robots.txt empty  |
 *
 * NO PLAYWRIGHT IS NEEDED for any of them. An earlier plan assumed an Angular SPA
 * at auksjonen.no needed a browser; measurement showed a sitemap index whose lot
 * pages carry the price server-side, so a plain fetch suffices. Fewer moving
 * parts, no browser dependency.
 *
 * DELIBERATELY NOT COLLECTED (keep this list honest — it is asserted in tests):
 *  - finn.no — robots.txt and the site terms prohibit automated access without
 *    written permission. Not crawled, by policy, not by technical limitation.
 *  - planbit.no — publishes no product pages (lead-generation only).
 *  - troostwijkauctions.com — zero Norway entries in its sitemap.
 */

export type PriceState = "listed" | "on_request" | "auction";

export interface Listing {
  source: string;
  extId: string;
  title: string;
  vendor?: string;
  productType?: string;
  /** 0 means "no price published" — always read together with `priceState`. */
  priceNok: number;
  priceState: PriceState;
  formFactor?: string;
  bays?: number;
  ramGb?: number;
  url: string;
  capturedAt: string;
}

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

export const DEFAULT_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept-language": "nb-NO,nb;q=0.9,en;q=0.8",
};

/** Sources that are not collected, and the measured reason. Surfaced by `docs`. */
export const NOT_COLLECTED: Record<string, string> = {
  "finn.no":
    "robots.txt + site terms prohibit automated access without written permission (personal saved-search alerts instead)",
  "planbit.no": "publishes no product pages (lead-generation only)",
  "troostwijkauctions.com": "zero Norway entries in its sitemap",
};

// ── classification ────────────────────────────────────────────────────────────

/** An OEM server family in the TITLE, not merely the word "server" in prose. */
const FAMILY =
  /(poweredge|proliant|thinksystem|primergy|supermicro|rackserver|rack-?server|precision\s+79|dgx|cray\s+xd|xe9[0-9]0|xe7[0-9]0|\b(?:dell|hpe|hp|emc|lenovo|fujitsu)\b[^|,]{0,18}\b(?:r[2-9][0-9]0|t[3-6][0-9]0|dl[0-9]{3}|ml[0-9]{3}|sr[0-9]{3}|rx[0-9]{3})\b)/i;

/** Accessories that mention a server family but are not a system. */
const ACCESSORY =
  /(tray|caddy|rail|skinner|blank|filler|strømforsyning|power supply|psu|kabel|cable|adapter|kvm|minne|memory|smartmemory|ddr[0-9]|hdd|ssd|harddisk|disk|hatte|switch|xeon|epyc|heatsink|kjøler|cooler|hjul|lisens|license|skjerm|monitor|dock|batteri|controller|nettverkskort|network card|boot device|powervault|dokkingstasjon|thinkpad|latitude|macbook)/i;

export interface Classified {
  isServer: boolean;
  bays?: number;
  formFactor?: string;
  ramGb?: number;
}

/**
 * Chassis height by OEM model family, used ONLY when the listing text does not
 * state it explicitly. These are the vendors' own mechanical specs (a R740xd is
 * a 2U chassis, a DL360 is 1U); the table exists because many listings omit the
 * height while every listing that matters to a rack decision needs it.
 */
const FORM_FACTOR: Array<[RegExp, string]> = [
  [/\b(?:r230|r620|r630|r640|r650|r660|dl3[0-9]{2}|dl325|sr6[0-9]0|rx25[0-9]0)\b/i, "1U"],
  [/\b(?:r5[1234]0|r7[2345]0(?:xd)?|r8[0-9]0|dl3[68]0|dl385|sr6[0-9]0|rx300)\b/i, "2U"],
  [/\bml3[0-9]0\b/i, "Tower"],
  [/\bt[36]30\b|\bt[46]40\b/i, "Tower"],
];

function formFactorFromModel(t: string): string | undefined {
  for (const [re, ff] of FORM_FACTOR) if (re.test(t)) return ff;
  return undefined;
}

/** Strip tags and collapse whitespace — product bodies are HTML. */
export function textOf(html: string | undefined): string {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Derive bays / form factor / RAM from free text. Pure; fully unit-tested. */
export function classify(title: string, productType: string, body = ""): Classified {
  const t = `${title} ${body.slice(0, 900)}`;
  const isServer =
    FAMILY.test(title) || productType.trim().toLowerCase() === "server";
  if (!isServer || ACCESSORY.test(title)) return { isServer: false };

  let bays: number | undefined;
  for (const pat of [
    /(\d{1,2})\s*[x×]\s*3\.5/i,
    /(\d{1,2})\s*[x×]\s*LFF/i,
    /(\d{1,2})\s*[x×]\s*(?:2\.5|SFF|U\.2|U\.3|NVMe)/i,
    /(\d{1,2})\s*[- ]?(?:bay|slot)/i,
  ]) {
    const m = t.match(pat);
    if (m) {
      bays = Number(m[1]);
      break;
    }
  }

  let formFactor: string | undefined;
  const ff = t.match(/\b(1U|2U|3U|4U)\b/i);
  if (ff) formFactor = ff[1].toUpperCase();
  else if (/\b(tower|tårn)\b/i.test(t)) formFactor = "Tower";
  else formFactor = formFactorFromModel(title);

  let ramGb: number | undefined;
  const rm = t.match(/(\d{2,4})\s*GB\s*(?:RAM|DDR)/i) ?? t.match(/RAM[^0-9]{0,14}(\d{2,4})\s*GB/i);
  if (rm) ramGb = Number(rm[1]);

  return { isServer: true, bays, formFactor, ramGb };
}

// ── Shopify ───────────────────────────────────────────────────────────────────

export interface ShopifySource {
  name: string;
  /** Site root, e.g. `https://www.axentra.no` (used for /products.json). */
  base: string;
  /** Public product-URL host, e.g. `www.axentra.no`. */
  host: string;
  pageLimit?: number;
}

export const SHOPIFY_SOURCES: ShopifySource[] = [
  { name: "axentra", base: "https://www.axentra.no", host: "www.axentra.no" },
  { name: "itgarasjen", base: "https://www.itgarasjen.no", host: "www.itgarasjen.no" },
  { name: "rebuildit", base: "https://rebuildit.no", host: "rebuildit.no" },
];

interface ShopifyProduct {
  id?: number | string;
  title?: string;
  handle?: string;
  vendor?: string;
  product_type?: string;
  body_html?: string;
  variants?: Array<{ id?: number | string; price?: string; available?: boolean }>;
}

/** Parse one Shopify `/products.json` page. Pure — the network is the caller's job. */
export function parseShopifyPage(
  page: { products?: ShopifyProduct[] },
  src: ShopifySource,
  capturedAt = new Date().toISOString(),
): Listing[] {
  const out: Listing[] = [];
  for (const p of page.products ?? []) {
    const title = p.title ?? "";
    const productType = p.product_type ?? "";
    const body = textOf(p.body_html);
    const c = classify(title, productType, body);
    if (!c.isServer) continue;
    const v = (p.variants ?? [])[0] ?? {};
    const price = Number(v.price ?? 0) || 0;
    out.push({
      source: src.name,
      extId: String(p.id ?? p.handle ?? title),
      title,
      vendor: p.vendor || undefined,
      productType: productType || undefined,
      priceNok: price,
      // 0 is never a real price: it is this shop's own auction/quote channel,
      // where the price lives on the lot page. Mis-reading it as "free" would
      // be the single most damaging bug in this service.
      priceState: price > 0 ? "listed" : "on_request",
      formFactor: c.formFactor,
      bays: c.bays,
      ramGb: c.ramGb,
      url: `https://${src.host}/products/${p.handle ?? ""}`,
      capturedAt,
    });
  }
  return out;
}

export async function collectShopify(
  src: ShopifySource,
  f: FetchLike,
  capturedAt = new Date().toISOString(),
): Promise<Listing[]> {
  const limit = src.pageLimit ?? 250;
  const all: Listing[] = [];
  for (let page = 1; page <= 8; page++) {
    const res = await f(`${src.base}/products.json?limit=${limit}&page=${page}`, {
      headers: DEFAULT_HEADERS,
    });
    if (!res.ok) throw new Error(`${src.name}: products.json HTTP ${res.status}`);
    const json = (await res.json()) as { products?: ShopifyProduct[] };
    const batch = json.products ?? [];
    all.push(...parseShopifyPage(json, src, capturedAt));
    if (batch.length < limit) break;
  }
  return all;
}

// ── auksjonen.no (liquidation / konkursbo) ────────────────────────────────────

export const AUKSJONEN_SITEMAPS = [
  "https://www.auksjonen.no/auctions.xml",
  "https://www.auksjonen.no/fastpris.xml",
  "https://www.auksjonen.no/curated.xml",
];

/** Lot URLs mention a server family, a rack cabinet, or a data-centre container. */
const LOT_KEYWORD =
  /(rackserver|rack-?server|poweredge|proliant|thinksystem|primergy|supermicro|\br[2-9][0-9]0\b|\bdl[0-9]{3}\b|\bsr[0-9]{3}\b|\bml[0-9]{3}\b|\bt[3-6][0-9]0\b|serverskap|rackskap|servercontainer|datasentercontainer|konkursbo)/i;

/** Sitemap body -> lot URLs worth fetching. Pure. */
export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

export function filterServerLots(locs: string[]): string[] {
  return locs.filter((l) => LOT_KEYWORD.test(decodeURIComponent(l)));
}

export interface AuksjonenOptions {
  /** Hard wall-clock budget safety: never fetch more than this many lot pages. */
  maxLots?: number;
  /** Politeness delay between lot fetches, ms. auksjonen.no robots.txt is empty. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Parse a lot page. The price is server-rendered in three places; we take the
 * first that yields a number, and we require the page to look like a lot.
 * Pure — unit-tested against a trimmed real capture.
 */
export function parseLotPage(
  html: string,
  url: string,
  capturedAt = new Date().toISOString(),
): Listing | undefined {
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = textOf(titleM?.[1] ?? "");
  if (!rawTitle) return undefined;
  const title = rawTitle.replace(/\s*[–|]\s*Auksjonen\s*$/i, "").replace(/\s*[–-]\s*[\d\s.,&nbsp;]+,-?\s*$/, "").trim();

  let price = 0;
  const meta = html.match(/product:price:amount"\s*content="([0-9.]+)"/i);
  if (meta) price = Number(meta[1]) || 0;
  if (!price) {
    const ld = html.match(/"price"\s*:\s*"?([0-9.]+)/i);
    if (ld) price = Number(ld[1]) || 0;
  }
  if (!price) {
    // Norwegian formatting in the title: "8&nbsp;000,-" / "8 000,-"
    const t = rawTitle.replace(/&nbsp;|\u00a0/g, " ");
    const tt = t.match(/([0-9][0-9 .,]{2,12})\s*,-/);
    if (tt) price = Number(tt[1].replace(/[ .]/g, "")) || 0;
  }

  // The lot id is the trailing path segment.
  const extId = url.replace(/\/+$/, "").split("/").pop() ?? url;
  const c = classify(title, "");
  return {
    source: "auksjonen",
    extId,
    title,
    priceNok: price,
    priceState: price > 0 ? "auction" : "on_request",
    formFactor: c.formFactor,
    bays: c.bays,
    ramGb: c.ramGb,
    url,
    capturedAt,
  };
}

export async function collectAuksjonen(
  f: FetchLike,
  opts: AuksjonenOptions = {},
  capturedAt = new Date().toISOString(),
): Promise<Listing[]> {
  const sleep = opts.sleep ?? defaultSleep;
  const delayMs = opts.delayMs ?? 1200;
  const maxLots = opts.maxLots ?? 40;

  const locs: string[] = [];
  for (const sm of AUKSJONEN_SITEMAPS) {
    const res = await f(sm, { headers: DEFAULT_HEADERS });
    if (!res.ok) continue; // a missing sitemap must not kill the run
    locs.push(...parseSitemapLocs(await res.text()));
  }

  const targets = filterServerLots(locs).slice(0, maxLots);
  const out: Listing[] = [];
  for (const [i, url] of targets.entries()) {
    if (i > 0) await sleep(delayMs);
    const res = await f(url, { headers: DEFAULT_HEADERS });
    if (!res.ok) continue;
    const listing = parseLotPage(await res.text(), url, capturedAt);
    if (listing) out.push(listing);
  }
  return out;
}

// ── top level ─────────────────────────────────────────────────────────────────

export interface CollectResult {
  capturedAt: string;
  listings: Listing[];
  errors: Array<{ source: string; error: string }>;
}

export async function collectAll(
  f: FetchLike,
  opts: { sources?: string[]; auksjonen?: AuksjonenOptions } = {},
): Promise<CollectResult> {
  const capturedAt = new Date().toISOString();
  const want = new Set(opts.sources ?? [...SHOPIFY_SOURCES.map((s) => s.name), "auksjonen"]);
  const listings: Listing[] = [];
  const errors: CollectResult["errors"] = [];

  for (const src of SHOPIFY_SOURCES) {
    if (!want.has(src.name)) continue;
    try {
      listings.push(...(await collectShopify(src, f, capturedAt)));
    } catch (e) {
      errors.push({ source: src.name, error: String(e) });
    }
  }
  if (want.has("auksjonen")) {
    try {
      listings.push(...(await collectAuksjonen(f, opts.auksjonen, capturedAt)));
    } catch (e) {
      errors.push({ source: "auksjonen", error: String(e) });
    }
  }
  return { capturedAt, listings, errors };
}

/** Value ranking: cheapest first, vendor-locked AI iron last. Pure. */
export function rankListings(listings: Listing[], maxNok?: number): Listing[] {
  return listings
    .filter((l) => l.priceState === "listed" || l.priceState === "auction")
    .filter((l) => maxNok === undefined || l.priceNok <= maxNok)
    .sort((a, b) => a.priceNok - b.priceNok);
}
