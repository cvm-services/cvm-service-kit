/**
 * tools.test.ts — the tool surface, driven by a fixed in-memory catalog.
 * No network: `createCatalog` is given a `seed` and never refreshed here.
 */
import { describe, expect, test } from "bun:test";
import { buildDealsTools, createCatalog, renderDigest } from "./tools.ts";
import type { Listing } from "./collect.ts";

const L = (over: Partial<Listing>): Listing => ({
  source: "axentra",
  extId: "1",
  title: "Dell PowerEdge R730xd",
  priceNok: 10000,
  priceState: "listed",
  url: "https://www.axentra.no/products/dell-r730xd",
  capturedAt: "2026-10-09T12:00:00.000Z",
  ...over,
});

const seed: Listing[] = [
  L({ extId: "1", title: "Dell R730xd 12-bay", priceNok: 10000, bays: 12, formFactor: "2U", ramGb: 64 }),
  L({ extId: "2", title: "HPE ProLiant DL380 Gen10", priceNok: 13500, bays: 8, formFactor: "2U", ramGb: 32, source: "itgarasjen" }),
  L({ extId: "3", title: "HPE ProLiant DL380 G7", priceNok: 2000, bays: 8, formFactor: "2U", ramGb: 64, source: "itgarasjen" }),
  L({ extId: "4", title: "Dell PowerEdge R740xd 18-bay", priceNok: 37000, bays: 18, formFactor: "2U", source: "itgarasjen" }),
  L({ extId: "5", title: "Nextron 1U rackserver", priceNok: 11250, priceState: "auction", source: "auksjonen", formFactor: "1U" }),
  L({ extId: "6", title: "Dell PowerEdge T630 Serverpakke", priceNok: 0, priceState: "on_request", source: "itgarasjen", formFactor: "Tower" }),
];

function tools() {
  const catalog = createCatalog({ seed });
  return Object.fromEntries(buildDealsTools({ catalog }).map((t) => [t.definition.name, t]));
}

describe("tool surface", () => {
  test("every tool is read-only and free (no cap tag)", () => {
    const names = Object.keys(tools()).sort();
    expect(names).toEqual(["deal_digest", "docs", "get_listing", "refresh", "search_listings"]);
    for (const t of buildDealsTools({ catalog: createCatalog({ seed }) })) {
      expect(t.definition.priceSats).toBeUndefined();
    }
  });

  test("search_listings filters by budget, source and bays, cheapest first", async () => {
    const r = (await tools().search_listings.handler({ max_price_nok: 15000 }, { caller: "x" })) as any;
    expect(r.matched).toBe(4);
    expect(r.listings.map((l: Listing) => l.priceNok)).toEqual([2000, 10000, 11250, 13500]);
    const bySrc = (await tools().search_listings.handler({ source: "itgarasjen", max_price_nok: 15000 }, { caller: "x" })) as any;
    expect(bySrc.matched).toBe(2);
    const wide = (await tools().search_listings.handler({ min_bays: 12 }, { caller: "x" })) as any;
    expect(wide.matched).toBe(2);
  });

  test("search_listings honours a limit", async () => {
    const r = (await tools().search_listings.handler({ limit: 1 }, { caller: "x" })) as any;
    expect(r.listings.length).toBe(1);
    expect(r.matched).toBeGreaterThan(1);
  });

  test("get_listing returns the row, or a VISIBLE refusal when absent", async () => {
    const hit = (await tools().get_listing.handler({ id: "2" }, { caller: "x" })) as any;
    expect(hit.listing.title).toContain("DL380 Gen10");
    const miss = (await tools().get_listing.handler({ id: "999" }, { caller: "x" })) as any;
    expect(miss.refused).toBe(true);
    expect(miss.reason).toBe("not_found");
    expect(miss.message).toContain("999");
    expect(miss.searched_id).toBe("999");
  });

  test("deal_digest renders budget rows, on-request rows and the refusal list", async () => {
    const r = (await tools().deal_digest.handler({ max_nok: 15000 }, { caller: "x" })) as any;
    expect(r.markdown).toContain("Within budget");
    expect(r.markdown).toContain("NOK 2 000");
    expect(r.markdown).not.toContain("R740xd 18-bay"); // over budget
    expect(r.markdown).not.toContain("\u00a0"); // no non-breaking space in output
    expect(r.markdown).toContain("Price on request");
    expect(r.markdown).toContain("Dell PowerEdge T630 Serverpakke");
    expect(r.markdown).toContain("finn.no");
    expect(r.markdown).toContain("prohibit");
  });

  test("docs states the refusals and the no-browser transport fact", async () => {
    const r = (await tools().docs.handler({}, { caller: "x" })) as any;
    expect(r.service).toBe("no-server-deals");
    expect(r.not_collected["finn.no"]).toContain("prohibit");
    expect(r.transport_note).toContain("No browser automation");
    expect(r.refusals.join(" ")).toContain("never reported as free");
  });

  test("refresh never wipes the cache on a total outage", async () => {
    const catalog = createCatalog({
      seed,
      fetchImpl: async () => {
        throw new Error("network down");
      },
      sources: ["axentra"],
    });
    await catalog.refresh();
    // The cache survives the outage (callers keep being served) and the failure
    // is RECORDED, not swallowed.
    expect(catalog.listings.length).toBe(seed.length);
    expect(catalog.errors.length).toBe(1);
    expect(catalog.errors[0].source).toBe("axentra");
    expect(catalog.errors[0].error).toContain("network down");
  });

  test("renderDigest is empty-safe", () => {
    const md = renderDigest([], 15000, "2026-10-09T00:00:00.000Z");
    expect(md).toContain("nothing priced within budget");
  });
});
