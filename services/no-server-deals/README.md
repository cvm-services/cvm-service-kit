# no-server-deals — Norwegian second-hand server market over ContextVM

Read-only CVM service exposing the Norwegian second-hand server / IT-hardware
market as MCP tools over Nostr. Zero-cost tools, no payment rail, no caller
input, no personal data.

## Sources

Every transport below was probed live on **2026-10-09**; the table records what
was measured, not what was assumed.

| source | transport | measured |
|---|---|---|
| `axentra.no` | Shopify `/products.json?limit=250&page=N` | 86 products, real NOK prices |
| `itgarasjen.no` | Shopify `/products.json` | 289 products; also exposes its own UCP MCP surface (`/api/ucp/mcp`) |
| `rebuildit.no` | Shopify `/products.json` | 250+ products, component-level + systems |
| `auksjonen.no` | sitemap index → lot pages (ld+json + `"price"`) | 3 722 live lots, 155 categories incl. `vareparti_konkursbo` |

### No browser automation is used

An earlier plan assumed `auksjonen.no` (an Angular SPA whose `/sok`, `/search`
and `/kategori/...` routes all 404) required Playwright. Measurement showed a
`sitemap.xml` **index** whose lot pages carry the price server-rendered plus a
`BreadcrumbList` ld+json block, and its `robots.txt` is empty. Plain HTTP is
enough for every source here, so there is no browser dependency to deploy,
patch or keep alive.

## Deliberately NOT collected

| source | why |
|---|---|
| `finn.no` | robots.txt and the site terms prohibit automated access without written permission. Policy, not a technical limitation. Use FINN's own saved-search alerts. |
| `planbit.no` | publishes no product pages (lead-generation only) |
| `troostwijkauctions.com` | zero Norway entries in its sitemap |

This list is asserted in the tests and returned by the `docs` tool, so a future
maintainer cannot quietly start crawling a disallowed source.

## Tools

| tool | args | returns |
|---|---|---|
| `search_listings` | `source`, `max_price_nok`, `min_bays`, `price_state`, `limit` | filtered listings, cheapest first |
| `get_listing` | `id`, `source` | one listing, or a **visible refusal** naming what was searched |
| `deal_digest` | `max_nok` | markdown digest (budget band, on-request band, refusal list) |
| `refresh` | — | re-poll every source; returns capture stats |
| `docs` | — | scope, sources, non-collected list, refusals, price states |

No tool has a `priceSats` cap: the whole surface is free and read-only.

### `priceNok = 0` is never "free"

IT Garasjen publishes `0` for rows in its own auction/quote channel, where the
price lives on the lot page. Such rows are emitted with
`price_state = "on_request"` and are excluded from every ranked/budget view.
Reading `0` as a price would be the single most damaging bug in this service, so
it is covered by tests at both the adapter and the tool layer.

## Run

```bash
bun install --frozen-lockfile
SERVER_SECRET_KEY=$(openssl rand -hex 32) \
HEALTH_PORT=9101 \
bun services/no-server-deals/src/server.ts
```

The server key must **differ** from any client key (a shared key makes the
server receive its own gift-wrapped requests).

### Env

| var | default | meaning |
|---|---|---|
| `SERVER_SECRET_KEY` | — (required) | 64-hex CVM signing key |
| `RELAYS` | kit relay set | comma-separated relay URLs |
| `ANNOUNCE` | `true` | publish the CEP-6 catalogue (11316/11317) |
| `ANNOUNCE_D` | `no-server-deals-01` | stable `d` slug |
| `SERVICE_CLASS` | `market` | `t=cvm:service:<class>` |
| `HEALTH_PORT` | `0` | loopback `/health` port |
| `MAX_NOK_DEFAULT` | `15000` | default budget for `deal_digest` |
| `AUKSJONEN_MAX_LOTS` | `40` | lot-page fetch cap per refresh |
| `REFRESH_MIN` | `0` | periodic re-poll interval, minutes |

### Announcement

`requiredInputs` and `optionalInputs` are both empty, so the tier is **computed**
as `none` by the kit's `recomputeTier` (there is no caller-supplied tier anywhere
in this path). `is_announced`, one `cap`-free tool list, one `g` geohash set.

## Layout

```
services/no-server-deals/
  src/collect.ts        adapters + pure classifiers (fetch injected)
  src/collect.test.ts   fixture tests (no network)
  src/tools.ts          MCP tool surface + digest renderer
  src/tools.test.ts
  src/server.ts         entrypoint (kit + services/_shared)
  fixtures/             trimmed REAL captures used by the tests
  README.md
```

`fetch` is injected everywhere, so tests never touch the network and the
adapters stay testable against a saved capture.

## Status

Code + tests complete and green (`bun test`, `bun run typecheck`). Not yet
deployed/announced — deployment goes through the kit's `cvm_service` Ansible
role with `ANNOUNCE=false` until the host is confirmed.
