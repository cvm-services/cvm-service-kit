# PCB quantity sweep — deterministic, browser-free, token-free

**What this answers.** "What does board X cost at quantity N, and where are the
price cliffs?" — with no browser, no LLM, and no page sampling.

## Why it can be this cheap

JLCPCB/LCSC publishes each part's **price-break table** through an
**unauthenticated** parts API. One call per part returns every band price
exactly. The quantity-dependent cost is therefore published *data*, not
something to be discovered by driving a quote page 16 times.

Validated: deriving the hub v9 parts cost from break tables at qty 5 gives
**$145.03** vs the page-measured **$146.51** — 0.7%, i.e. rounding plus part
substitutions. That agreement is what licenses using the method across the range.

**The cliffs ARE the break boundaries.** They are stated in the data, not
searched for.

## The API

```
POST https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2
  { "currentPage": 1, "pageSize": 25, "keyword": "<LCSC C-number>" }
```

No authentication required. The response's `componentPrices` array is the break
table:

```json
[{"startNumber":1,"endNumber":9,"productPrice":5.7607},
 {"startNumber":10,"endNumber":29,"productPrice":4.955},
 {"startNumber":30,"endNumber":99,"productPrice":4.4787},
 {"startNumber":100,"endNumber":649,"productPrice":3.9943},
 {"startNumber":650,"endNumber":1299,"productPrice":3.7709},
 {"startNumber":1300,"endNumber":-1,"productPrice":3.6698}]
```

`endNumber: -1` means +infinity. Sanitize before storing: drop every other key
(the payload carries multi-KB signed S3 URLs and Chinese marketing text).

## Running it for a new board

1. **Get the BOM with LCSC numbers** — `docs/fab/<board>/<board>_bom_pcba.csv`
   (`Comment,Designator,Footprint,JLCPCB Part #`).
2. **Count designators per line** — that count is `perBoard`. This is the step
   that gets silently wrong; verify against the file, do not trust a summary.
3. **Fetch each part's break table** from the endpoint above.
4. **Call the sweep** with the parts, the fixed fees, the MEASURED pcb map, and
   the quantities:

```ts
sweep({
  parts: [{ lcsc: "C2980300", perBoard: 1, breaks: [[1,9,5.7607], /* … */] }],
  fixedFeesUsd: 25,                 // $25 per assembly side (measured)
  pcbUsdByQty: { 5: 32.30, 10: 45.0, 20: 62.0 },  // MEASURED only
  qtys: [5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20],
})
```

Or over MCP: tool `quote_pcba_sweep`.

## Invariants — each enforced by a test plus a counter-test

| Invariant | Behaviour | Test |
|---|---|---|
| Unpriced is `null` | `unitPriceAt` returns `null` when no band covers the qty. Never interpolated, extrapolated, or snapped to the nearest band. | t1, **t2 counter-test** (a nearest-band impl *would* have answered) |
| No invented PCB ladder | `pcbUsd` comes only from a caller-supplied measured map. Missing entry ⇒ that qty is `complete:false`. | t4 |
| No partial totals | `totalUsd` is `null` unless **every** component is known. | t4, t8 |
| Monotonicity is a verdict | Bad input returns `{ok:false, reason:"monotonicity_violated", violations}` — never silently reordered. | **t6 counter-test** (doctored rising-price input must trip it) |
| Permanent provenance | `isPageQuote:false`, `source:"derived_from_lcsc_breaks"`, plus a `basis` string naming the fees and PCB prices used. | t7 |

A derived number must stay distinguishable from a page quote forever. The
**$4.00 "Special Offer"** incident (a $32.30 board misread as $4.00) is why.

## Worked example — hub v9, qty 5→20

| qty | total | per board |
|---|---|---|
| 5 | $202.33 | $40.47 |
| **10** | **$339.98** | **$34.00** |
| 13 | $423.42 | $32.57 |
| 20 | $621.50 | $31.07 |

**Two real cliffs in range:**

- **qty 10** — five ICs break simultaneously (ESP32-S3, SX1280, MAX-M10S,
  MS5611, LDO, all `perBoard:1`), unit delta **−$2.60**. Captures **~72%** of
  the entire 5→20 unit-price improvement.
- **qty 13** — U.FL (`perBoard:4`, band starts M=49 ⇒ `ceil(49/4)=13`), unit
  delta −$0.27. Below the materiality threshold, but real.

Parts are **72–86%** of the total on this board, so quantity strategy is a
parts-pricing question; the fab ladder barely moves the answer.

## What is NOT included

`per-placement assembly fee` (never captured — only the $25/side setup is
measured) and `shipping` ($23.36/parcel). Treat computed totals as **lower
bounds** on the true assembled order cost. The cliff structure is unaffected.
