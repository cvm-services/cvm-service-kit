/**
 * tools.ts — the MCP tool surface of the `no-server-deals` CVM service.
 *
 * Read-only over publicly published retailer catalogues. No caller input, no
 * payment, no personal data: `requiredInputs`/`optionalInputs` are both empty,
 * so the announcement tier is `none` (see startService in services/_shared).
 *
 * Design rule for every tool here: a miss is a VISIBLE refusal, never an empty
 * result. Silence is the failure mode a caller cannot distinguish from "no
 * deals today".
 */
import type { Tool } from "../../../src/index.ts";
import {
  collectAll,
  NOT_COLLECTED,
  rankListings,
  type FetchLike,
  type Listing,
} from "./collect.ts";

export interface Catalog {
  listings: Listing[];
  capturedAt: string;
  errors: Array<{ source: string; error: string }>;
  /** Re-poll every source and replace `listings`. Never throws. */
  refresh(): Promise<void>;
}

export interface CatalogOptions {
  fetchImpl?: FetchLike;
  /** Sources to poll; default = all. */
  sources?: string[];
  maxLots?: number;
  /** Initial listings (tests / warm start). */
  seed?: Listing[];
}

export function createCatalog(opts: CatalogOptions = {}): Catalog {
  const f: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const catalog: Catalog = {
    listings: opts.seed ?? [],
    capturedAt: new Date().toISOString(),
    errors: [],
    async refresh() {
      const res = await collectAll(f, {
        sources: opts.sources,
        auksjonen: { maxLots: opts.maxLots ?? 40 },
      });
      // Only replace on a non-empty poll: a total outage must not wipe the
      // cache the callers are still being served from.
      if (res.listings.length > 0) {
        catalog.listings = res.listings;
        catalog.capturedAt = res.capturedAt;
      }
      catalog.errors = res.errors;
    },
  };
  return catalog;
}

export interface DealsDeps {
  catalog: Catalog;
  maxNokDefault?: number;
}

function refusal(reason: string, message: string, extra: Record<string, unknown> = {}) {
  return { refused: true, reason, message, ...extra };
}

/**
 * NOK formatting for humans. `toLocaleString("nb-NO")` inserts U+00A0
 * (non-breaking space) as the thousands separator, which survives into
 * downstream parsing and markdown/Signal rendering as an invisible trap — so we
 * normalise it to a plain space at the boundary.
 */
export function nok(n: number): string {
  return Math.round(n).toLocaleString("nb-NO").replace(/\u00a0/g, " ");
}

/** Markdown digest. Pure — the same shape as the manager-side DIGEST.md. */
export function renderDigest(listings: Listing[], maxNok: number, capturedAt: string): string {
  const priced = rankListings(listings, maxNok);
  const onRequest = listings.filter((l) => l.priceState === "on_request");
  const lines: string[] = [
    `# Norwegian used-server market — ${capturedAt.slice(0, 10)}`,
    "",
    `${listings.length} server-class listings captured ${capturedAt}.`,
    "",
    `## Within budget (<= NOK ${nok(maxNok)})`,
    "",
  ];
  if (priced.length === 0) lines.push("_nothing priced within budget in this capture_");
  for (const l of priced) {
    const spec = [l.formFactor, l.bays ? `${l.bays}-bay` : undefined, l.ramGb ? `${l.ramGb}GB` : undefined]
      .filter(Boolean)
      .join(" ");
    lines.push(`- **NOK ${nok(l.priceNok)}** · ${l.title} · ${spec || "spec n/a"} · ${l.source}`);
    lines.push(`  ${l.url}`);
  }
  lines.push("", `## Price on request / auction channel (${onRequest.length})`, "");
  for (const l of onRequest.slice(0, 20)) {
    lines.push(`- ${l.title} · ${l.source}`);
    lines.push(`  ${l.url}`);
  }
  lines.push("", "## Not collected, and why", "");
  for (const [src, why] of Object.entries(NOT_COLLECTED)) lines.push(`- ${src} — ${why}`);
  return lines.join("\n");
}

export function buildDealsTools(d: DealsDeps): Tool[] {
  const maxNokDefault = d.maxNokDefault ?? 15000;

  const search: Tool = {
    definition: {
      name: "search_listings",
      description:
        "Search the captured Norwegian second-hand server market (Axentra, IT Garasjen, Rebuild IT, Auksjonen.no liquidation lots).",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "axentra | itgarasjen | rebuildit | auksjonen" },
          max_price_nok: { type: "number" },
          min_bays: { type: "number" },
          price_state: { type: "string", description: "listed | auction | on_request" },
          limit: { type: "number", description: "default 25, max 100" },
        },
      },
    },
    handler: (args) => {
      const limit = Math.min(Number(args.limit ?? 25) || 25, 100);
      let rows = d.catalog.listings.slice();
      if (args.source) rows = rows.filter((l) => l.source === String(args.source));
      if (args.price_state) rows = rows.filter((l) => l.priceState === String(args.price_state));
      if (args.min_bays !== undefined) rows = rows.filter((l) => (l.bays ?? 0) >= Number(args.min_bays));
      if (args.max_price_nok !== undefined) {
        const cap = Number(args.max_price_nok);
        rows = rows.filter((l) => l.priceNok > 0 && l.priceNok <= cap);
      }
      rows.sort((a, b) => (a.priceNok || Infinity) - (b.priceNok || Infinity));
      return {
        captured_at: d.catalog.capturedAt,
        total_captured: d.catalog.listings.length,
        matched: rows.length,
        source_errors: d.catalog.errors,
        listings: rows.slice(0, limit),
      };
    },
  };

  const get: Tool = {
    definition: {
      name: "get_listing",
      description: "Fetch one captured listing by its id (source's own id / lot number).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          source: { type: "string", description: "disambiguates when ids collide" },
        },
        required: ["id"],
      },
    },
    handler: (args) => {
      const id = String(args.id);
      const rows = d.catalog.listings.filter(
        (l) => l.extId === id && (!args.source || l.source === String(args.source)),
      );
      if (rows.length === 0) {
        // Visible refusal: state what we searched and over how many rows.
        return refusal(
          "not_found",
          `no listing with id '${id}'${args.source ? ` from '${args.source}'` : ""} in the capture of ${d.catalog.capturedAt} (${d.catalog.listings.length} rows)`,
          { searched_id: id, captured_at: d.catalog.capturedAt },
        );
      }
      return { listing: rows[0], duplicates: rows.length - 1 };
    },
  };

  const digest: Tool = {
    definition: {
      name: "deal_digest",
      description: "Human-readable markdown digest of the current capture, ranked cheapest-first.",
      inputSchema: {
        type: "object",
        properties: { max_nok: { type: "number", description: `default ${maxNokDefault}` } },
      },
    },
    handler: (args) => {
      const maxNok = Number(args.max_nok ?? maxNokDefault) || maxNokDefault;
      return { max_nok: maxNok, markdown: renderDigest(d.catalog.listings, maxNok, d.catalog.capturedAt) };
    },
  };

  const refresh: Tool = {
    definition: {
      name: "refresh",
      description:
        "Re-poll every source now and return the new capture stats. Read-only upstream; safe to call (rate-limited by the caller's own discretion).",
      inputSchema: { type: "object", properties: {} },
    },
    handler: async () => {
      await d.catalog.refresh();
      return {
        captured_at: d.catalog.capturedAt,
        total: d.catalog.listings.length,
        source_errors: d.catalog.errors,
      };
    },
  };

  const docs: Tool = {
    definition: {
      name: "docs",
      description: "What this service collects, what it refuses to collect, and how the data is obtained.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: () => ({
      service: "no-server-deals",
      scope: "Norwegian second-hand server / IT-hardware market",
      sources: {
        axentra: "Shopify /products.json — refurb enterprise, ~2y warranty",
        itgarasjen: "Shopify /products.json — refurb, <=3y warranty; also exposes its own UCP MCP surface",
        rebuildit: "Shopify /products.json — Asker, components + systems",
        auksjonen: "sitemap index -> lot pages (ld+json + price) — liquidation / konkursbo lots",
      },
      transport_note:
        "No browser automation is used or needed: every source serves structured data or server-rendered HTML. An earlier plan assumed the auksjonen.no Angular SPA required Playwright; measurement showed a sitemap index with priced lot pages, so plain HTTP is enough.",
      not_collected: NOT_COLLECTED,
      refusals: [
        "No price is ever inferred. priceNok=0 always means 'price not published' and carries price_state=on_request — it is never reported as free.",
        "No bidder account, no bidding, no purchase. This service reads catalogues only; procurement stays a human action.",
        "No personal data is collected or accepted: requiredInputs/optionalInputs are empty and the announcement tier is computed as 'none'.",
      ],
      price_states: {
        listed: "retailer published a fixed price in NOK",
        auction: "live lot price / current bid in NOK; moves until the lot closes",
        on_request: "retailer publishes no price (its own auction or quote channel)",
      },
    }),
  };

  return [search, get, digest, refresh, docs];
}
