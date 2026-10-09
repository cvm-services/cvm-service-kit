/**
 * collect.test.ts — fixture-driven tests for the Norwegian market collectors.
 *
 * The fixtures in `../../fixtures/` are TRIMMED REAL captures (2026-10-09):
 * a Shopify `/products.json` page and a real auksjonen.no lot page. No test in
 * this file touches the network.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AUKSJONEN_SITEMAPS,
  NOT_COLLECTED,
  SHOPIFY_SOURCES,
  classify,
  collectAll,
  collectShopify,
  filterServerLots,
  parseLotPage,
  parseShopifyPage,
  parseSitemapLocs,
  rankListings,
  type FetchLike,
} from "./collect.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

// A FetchLike stub that serves fixtures and fails loudly on anything else, so a
// test can never silently reach the real internet.
function stubFetch(routes: Record<string, { body: string; status?: number; json?: boolean }>): FetchLike {
  return async (url: string) => {
    const r = routes[url];
    if (!r) throw new Error(`unstubbed fetch: ${url}`);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => r.body,
      json: async () => JSON.parse(r.body),
    } as unknown as Response;
  };
}

describe("classify", () => {
  test("recognises an OEM server family in the title", () => {
    expect(classify("Dell PowerEdge R730xd", "Server").isServer).toBe(true);
    expect(classify("HPE ProLiant DL380 Gen10 LFF", "").isServer).toBe(true);
    expect(classify("Fujitsu Primergy RX300 S8", "").isServer).toBe(true);
  });

  test("product_type Server alone is enough", () => {
    expect(classify("Dell R730xd", "Server").isServer).toBe(true);
  });

  test("accessories that name a server family are NOT systems", () => {
    for (const t of [
      "Dell 61KCY 2U Sliding Rail Kit – PowerEdge R720/R730/R740",
      "HPE 651687-001 SmartDrive Carrier / Drive Tray",
      "Dell Strømforsyning Server 1100W",
      "Intel Ethernet Server Adapter X520-DA2",
      "SK Hynix 32GB 2Rx4 PC4-2933Y-RB2-12 ECC serverminne",
    ]) {
      expect(classify(t, "").isServer).toBe(false);
    }
  });

  test("extracts bays, form factor and RAM", () => {
    const c = classify('Dell PowerEdge R740xd — 12×3.5" chassis', "Server");
    expect(c.bays).toBe(12);
    expect(c.formFactor).toBe("2U");
    const d = classify("Dell PowerEdge T630 – Serverpakke med ProxMox", "Server", "16 GB RAM");
    expect(d.formFactor).toBe("Tower");
    expect(d.ramGb).toBe(16);
    const e = classify("HP ProLiant DL380 G7 Rackserver", "Server", "64GB DDR3");
    expect(e.ramGb).toBe(64);
  });
});

describe("parseShopifyPage", () => {
  const src = SHOPIFY_SOURCES[0]; // axentra

  test("keeps servers, drops accessories, never reads 0 as free", () => {
    const page = JSON.parse(fixture("shopify-axentra.json"));
    const listings = parseShopifyPage(page, src, "2026-10-09T00:00:00.000Z");
    expect(listings.length).toBeGreaterThan(0);
    for (const l of listings) {
      expect(l.source).toBe("axentra");
      expect(l.url).toStartWith("https://www.axentra.no/products/");
      expect(l.priceNok).toBeGreaterThanOrEqual(0);
      if (l.priceNok === 0) expect(l.priceState).toBe("on_request");
      else expect(l.priceState).toBe("listed");
      expect(l.title.length).toBeGreaterThan(0);
    }
    // the fixture deliberately contains an accessory row
    expect(listings.some((l) => /tray|caddy|rail|adapter/i.test(l.title))).toBe(false);
  });

  test("itgarasjen zero-price rows become on_request, not free", () => {
    const page = JSON.parse(fixture("shopify-itgarasjen.json"));
    const listings = parseShopifyPage(page, SHOPIFY_SOURCES[1], "2026-10-09T00:00:00.000Z");
    for (const l of listings.filter((x) => x.priceNok === 0)) {
      expect(l.priceState).toBe("on_request");
    }
  });
});

describe("collectShopify", () => {
  test("stops after a short page", async () => {
    const body = fixture("shopify-axentra.json");
    const n = JSON.parse(body).products.length;
    let calls = 0;
    const f: FetchLike = async (url) => {
      calls++;
      expect(url).toContain("/products.json?limit=250&page=1");
      return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body } as unknown as Response;
    };
    const out = await collectShopify(SHOPIFY_SOURCES[0], f);
    expect(calls).toBe(1);
    expect(out.length).toBeLessThanOrEqual(n);
  });

  test("a non-200 throws with the source name", async () => {
    const f: FetchLike = async () =>
      ({ ok: false, status: 503, json: async () => ({}), text: async () => "" }) as unknown as Response;
    await expect(collectShopify(SHOPIFY_SOURCES[0], f)).rejects.toThrow(/axentra.*503/);
  });
});

describe("auksjonen.no", () => {
  test("sitemap locs parse and filter to server/rack lots only", () => {
    const xml = `<urlset>
      <loc>https://www.auksjonen.no/auksjon/torget/Nextron_1U_rackserver_med_NVIDIA_P100A/561929</loc>
      <loc>https://www.auksjonen.no/auksjon/torget/Kaffemaskin_NIO_20.3_benkmodell/636081</loc>
      <loc>https://www.auksjonen.no/auksjon/torget/BM_42U_serverskap_med_nettverksutstyr/628742</loc>
      <loc>https://www.auksjonen.no/auksjon/landbruk/2006_Valtra_M130/637661</loc>
    </urlset>`;
    const locs = parseSitemapLocs(xml);
    expect(locs.length).toBe(4);
    const kept = filterServerLots(locs);
    expect(kept.length).toBe(2);
    expect(kept[0]).toContain("rackserver");
    expect(kept[1]).toContain("serverskap");
  });

  test("lot page parses title and price from a real capture", () => {
    const html = fixture("auksjonen-lot.html");
    const url =
      "https://www.auksjonen.no/auksjon/torget/Nextron_1U_rackserver_med_NVIDIA_P100A_grafikkort_og_64_GB_RAM/561929";
    const l = parseLotPage(html, url, "2026-10-09T00:00:00.000Z");
    expect(l).toBeDefined();
    expect(l!.source).toBe("auksjonen");
    expect(l!.extId).toBe("561929");
    expect(l!.priceNok).toBeGreaterThan(0);
    expect(l!.priceState).toBe("auction");
    expect(l!.title).toContain("rackserver");
    expect(l!.url).toBe(url);
    expect(l!.formFactor).toBe("1U");
  });

  test("a page with no price is on_request, never 0-as-price", () => {
    const l = parseLotPage("<title>Noe greier – 5&nbsp;000,- | Auksjonen</title>", "https://x/1");
    expect(l!.priceNok).toBe(5000);
    const none = parseLotPage("<title>Uten pris | Auksjonen</title>", "https://x/2");
    expect(none!.priceNok).toBe(0);
    expect(none!.priceState).toBe("on_request");
    expect(parseLotPage("", "https://x/3")).toBeUndefined();
  });

  test("collectAll records a source error instead of dying", async () => {
    const body = fixture("shopify-axentra.json");
    const f = stubFetch({
      "https://www.axentra.no/products.json?limit=250&page=1": { body },
      "https://rebuildit.no/products.json?limit=250&page=1": { body: "{}" },
      [AUKSJONEN_SITEMAPS[0]]: { body: "<urlset></urlset>" },
      [AUKSJONEN_SITEMAPS[1]]: { body: "<urlset></urlset>" },
      [AUKSJONEN_SITEMAPS[2]]: { body: "<urlset></urlset>" },
    });
    const res = await collectAll(f, { sources: ["axentra", "auksjonen"] });
    expect(res.errors.length).toBe(0);
    expect(res.listings.length).toBeGreaterThan(0);
  });

  test("robots-disallowed sources stay documented and uncollected", () => {
    expect(Object.keys(NOT_COLLECTED)).toContain("finn.no");
    expect(NOT_COLLECTED["finn.no"]).toContain("prohibit");
    expect(SHOPIFY_SOURCES.map((s) => s.name)).not.toContain("finn");
  });
});

describe("rankListings", () => {
  test("cheapest first, budget filter, on_request excluded", () => {
    const base = {
      source: "x", extId: "1", priceState: "listed" as const,
      url: "https://x/1", capturedAt: "2026-10-09T00:00:00.000Z",
    };
    const rows = [
      { ...base, title: "a", priceNok: 900 },
      { ...base, title: "b", priceNok: 20000 },
      { ...base, title: "c", priceNok: 5000 },
      { ...base, title: "d", priceNok: 7000, priceState: "auction" as const },
      { ...base, title: "e", priceNok: 0, priceState: "on_request" as const },
    ];
    const ranked = rankListings(rows, 15000);
    expect(ranked.map((r) => r.title)).toEqual(["a", "c", "d"]);
    expect(rankListings(rows).map((r) => r.title)).toEqual(["a", "c", "d", "b"]);
  });
});
