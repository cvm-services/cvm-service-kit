# cvm-jlc-quote — a read-only JLCPCB gerber quote, as a CVM service

One tool, `quote`. Give it a gerber zip; it reports the price, shipping,
quantity, layers, board dimensions and weight that `cart.jlcpcb.com` **actually
rendered**. Free, no payment, no ordering, ever.

The whole point of this service is that it **does not lie**. Every way of failing
— an expired session, a price row that did not render, a row that rendered no
amount, two readers of the same page disagreeing — comes back as a *visible
refusal*, and each refusal is enforced by a test that has a counter-test proving
the assertion can fail.

```
services/jlc-quote/
  src/parse.ts          pure, browser-free reading of a page capture  ← the honesty core
  src/parse.test.ts     the parser against REAL captures (invariants 1–3)
  src/types.ts          QuoteFields, BrowserRun, Refusal (exactly 3 keys)
  src/provenance.ts     the limitation/refusal text, in ONE place
  src/adapter.ts        the ONLY module that spawns a subprocess      ← the seam
  src/adapter.test.ts   the spawn seam, injected (no browser, no network)
  src/tools.ts          the published tool shape                      (invariants 1–3)
  src/tools.test.ts     end-to-end against fixtures, adapter injected
  src/announce.ts       the CEP-6 announcement                        (invariant 4)
  src/announce.test.ts  the frozen tag set + adversarial counter-tests
  src/server.ts         entrypoint: CvmServer + /health + announce
  tools/capture_page.py the browser leg; REUSES the wrapped client's primitives
  fixtures/             verbatim captures, incl. two that EXPOSE the traps
```

## Tools

| Tool | Price | What |
|---|---|---|
| `quote` | free (no `cap` tag) | Quote a gerber zip. Send exactly one of `zip_path` / `zip_base64` (plus an optional `qty`, see below). |
| `docs` | free | The contract verbatim: what it is, what it is NOT, the refusal list, the quantity limitation. |

`priceSats` is left `undefined` on every tool, so no `["cap",…]` tag is emitted
(asserted, with a counter-test that a priced tool *does* produce one).

## Verified usage

Read-only; it uploads the gerber and reads the quote. It never places an order.

```bash
# The measured commands — run on cobrador (2026-10-13), qty 5, page default:
DISPLAY=:99 JLC_PROFILE=~/.hermes/profiles/manager/state/jlc-browser9 \
  ~/venvs/pw/bin/python -m jlcpcb_client.cli quote ~/jlc-quote-inputs/hub_v9.zip \
  --snapshot ./snapshots --json
```

| Board | Layers | Dimensions | PCB price | Shipping | Weight |
|---|---|---|---|---|---|
| **hub v9** | 4 | **115×103 mm** | **$32.30** | $23.36 DHL | 0.33 kg |
| **wing v9** | 2 | **25×184 mm** | **$6.40** | $23.36 DHL | 0.20 kg |

Those two figures are the fixtures' own numbers, read by `parse.ts` under test.
Run the service's own suite:

```bash
bun install --frozen-lockfile   # a fresh worktree has no node_modules: tsc is absent without this
bun test services/jlc-quote
bun run typecheck
```

## Environment requirements (each of these cost real time)

| Requirement | Detail |
|---|---|
| **An X server** | The quote drives **headed** Chrome. `Xvfb :99 -screen 0 1400x1100x24`. Without it the browser cannot start and the tool refuses `adapter_error`. |
| **`executable_path="/usr/bin/google-chrome"`** | Playwright's **bundled Chromium is MISSING** on this host. Launching without it fails with *"Executable doesn't exist at …/ms-playwright/chromium-1243/…"*. The adapter passes `JLC_CHROME`; the capture script honours it. |
| **`~/venvs/pw/bin/python`** | The venv that has Playwright. An older README references `/tmp/pwvenv`, which no longer exists (`/tmp` is tmpfs and is cleared). |
| **The persistent session profile** | `~/.hermes/profiles/manager/state/jlc-browser9`. When it expires the tool refuses `session_expired`. Re-login harness: `~/.hermes/profiles/manager/state/jlc-signup/`. |
| **Input zips outside `/tmp`** | `~/jlc-quote-inputs/`. `zip_path` under `/tmp` is refused `input_invalid`: a reboot loses the file and a quote would fail for a reason that looks like a bug in the board. |

Wiring: `src/server.ts` → `src/adapter.ts` (`liveConfigFromEnv`) → `tools/capture_page.py`.
The capture script **reuses the wrapped client's own primitives** — `browser`,
`_goto`, `is_authed`/`AUTH_MARKER`, `_upload`, `_wait_for_quote`, `_snapshot` —
so the browser flow is not re-derived. Pin it: `jlcpcb-service` @ `62c63c7`.

## The quantity limitation — stated, not hidden

> **This service quotes at the page-default quantity (5) ONLY.**

It has no working quantity parameter. A call with `qty` set to anything other
than 5 is **refused** with `reason: "qty_unsupported"`, and the refusal happens
*before* the browser leg runs (asserted: the recording adapter's call list stays
empty). A default-quantity price is **never** presented as a requested-quantity
price.

Why it is not solved: the control is Element-UI (`#QtyDom > span.qtySelect`, a
**teleported** `ul.qty-select-list`, and a `Confirm` button that starts
disabled), and three traps are measured and on record
(`jlcpcb-service/docs/JLCPCB-QUOTE-FINDINGS.md`):

1. clicking text outside `#QtyDom` hit the **Layers** option `"10"` and produced an
   impossible **$268.60** for the hub;
2. the option list is **teleported out of `#QtyDom`**, so any scoped selector
   returns `null` once it opens;
3. `Confirm` is disabled until a selection, and it was never settled whether it
   is required at all.

**Optional bonus work was not attempted.** The gate for it would be: the widget's
own value must be proven to have changed *before* the price is read, plus ≥2
distinct totals across quantities and monotonic pricing (total non-decreasing,
unit non-increasing) — else refuse. Re-deriving a price without that is how the
`$4.00` and `$268.60` figures happened, and a wrong price is far worse than an
honest refusal. Multiplying the default-qty price is **not** offered either:
JLCPCB's setup fee is per-design, its shipping is per-parcel and its build-time
adders are not linear.

## The four honesty invariants

| # | Invariant | Enforced by | Counter-test (proves the assertion has teeth) |
|---|---|---|---|
| 1 | An expired/absent session is a **visible refusal** — `{refused: true, reason: "session_expired", message: "<what was attempted>"}`. Never a price, never `0`, never a silent empty result. | `parse.ts::parseCapture` (auth **first**) → `tools.ts::quoteFromRun`; a refusal's key set is asserted to be **exactly** `["message","reason","refused"]` so it has nowhere to put a price. | An authenticated, priced capture is **not** refused (otherwise "always refuse" would pass every assertion). Four failure modes are each asserted to produce a refusal object that has no `pcb_price_usd` key. |
| 2 | A price the page did not actually render is **never reported**. | The price comes **only** from a label-anchored read: `Calculated Price` immediately followed by an amount (whitespace alone). The `Special Offer` fallback the wrapped client carries is deliberately **not** reproduced, and a disagreement with the wrapped client's own reading is a refusal. | `fixtures/hub_special_offer_trap.txt` is a **real capture** where `Calculated Price` rendered with no adjacent amount and the only nearby figure is `$4.00` (`Special Offer`). The test reimplements the wrapped client's loose reader — *first `$` after the label* — and asserts it returns **$4.00**, i.e. exactly the wrong number that was once reported for a **$32.30** board. |
| 3 | Absent data (e.g. no shipping row) is **never emitted as a value/number**. | `parseCapture` yields `null`; `assembleQuote`/`dropAbsentNumbers` **delete** null fields (an absent key cannot be collapsed into `0`); `assertNoNullNumbers` rejects a present `0`/`NaN`/null immediately before the value leaves the tool; `soundnessViolation` refuses a non-positive price. | `fixtures/hub_shipping_absent.txt` is a **real capture** whose `Shipping Estimate` row rendered **no amount**. The same loose reader harvests **$30.00** from a **coupon** line (`Save $30.00`) and calls it shipping; `parse.ts` returns `null` there, and the response omits the key entirely. |
| 4 | The **announcement tag set is asserted**, and a counter-test proves the assertion can fail. | `announce.ts` declares the sentinel only; `announce.test.ts` asserts the emitted tags **equal** the frozen set; `server.ts` re-runs `assertAnnouncementTags` and **fails closed** before publishing. | Four counter-tests: a priced tool **does** emit `["cap","tool:quote","5","sats"]`; a real declared field **does** emit `cvm:tier:financial` (and suppresses the sentinel); injecting `cvm:tier:none` breaks the equality **and** is flagged by the reader; adding a cap tag breaks it too. |

### The announcement contract, stated

```
d=cvm-jlc-quote-01
t=cvm:service:pcb-quote        t=pcb t=jlcpcb t=gerber t=quote
t=cvm:req:none                 ← the sentinel ONLY: this service declares no register field
r=https://github.com/cvm-services/cvm-service-kit/tree/main/services/jlc-quote
```

- **Tier-less by sentinel, and it carries no `cvm:tier:*` tag.** The register says
  a `cvm:tier` tag is not required when the declared field list recomputes to the
  bottom of the ladder, and the kit's own tier example emits `cvm:req:none`
  **alone** for that case (`tests/announce_test.ts`, the coffee kiosk). Publishing
  `cvm:tier:none` here would be a tag the register does not ask for, so this
  service does not publish one. The reader recomputes `none` from the sentinel
  and reports no violation.
- **No `cap` tags, no `pmi` tags.** There is no payment rail and no price, so
  there is nothing to gate — and `explicit_gating` is not needed for a free tool.
- A gerber zip is a **tool argument** (an opaque archive), not a declared input
  field, and nothing is stored, so there is no `cvm:req:*`/`cvm:opt:*` field to
  declare beyond the sentinel.
- Why the shared `services/_shared/start.ts` bootstrap is **not** used: its
  `announcementTags` path emits the sentinel only when an input array is defined
  *and* then also emits `cvm:tier:none`. `server.ts` wires `CvmServer` + the
  shared `/health` server directly and publishes the exact tag set its tests
  assert. See the header of `src/server.ts`.

## A measured finding about the code this wraps

While verifying the live path, a **real** capture came back in which
`Calculated Price` rendered **before** any amount and the `Shipping Estimate` row
rendered with **no amount at all**:

```
Calculated Price
$32.30
SAVE TO CART
Shipping Estimate
Weight
0.33kg
Coupons
Save $30.00Save $20.00
```

The wrapped client's reader takes "the first `$` after the label", which is why
it returned **`shipping_usd: 30.00`** on that run — a **coupon** figure — where
the board price ($32.30) was right. `parse.ts` returns `null` for that same
capture, and the response omits `shipping_usd`.

First-hand evidence that this is **intermittent, not a one-off**: the same hub v9
zip was quoted three times, and the `Shipping Estimate` row rendered an amount in
two of them and nothing in the third.

| Run | `Calculated Price` | `Shipping Estimate` | Wrapped client's `shipping_usd` | This service's `shipping_usd` |
|---|---|---|---|---|
| `quote-20261013-222439` (fixture `hub_v9_qty5.txt`) | `$32.30` | `$23.36` | `23.36` | `23.36` |
| `quote-20261013-225050` (fixture `hub_shipping_absent.txt`) | `$32.30` | **no amount** | **`30.00`** (a coupon) | **absent** |
| this service's `verify-live` run, 21:12Z | `$32.30` | `$23.36` | `23.36` | `23.36` |

This is why the parsing rules here are **strict anchors**, not label searches, and
why the wrapped client's own number arrives as `client_cross_check_usd`
**evidence** for comparison rather than as the answer: on a disagreement, the
service refuses. It is also why an unrendered row is reported as **absent** rather
than as `0` — the truthful answer for that third run is "JLCPCB did not show
shipping this time", and a `0` would read as "free shipping".

## Configuration (names only — values live in the fleet vault)

Deployed by the parameterized `cvm_service` Ansible role; non-secret config in
`/etc/cvm-jlc-quote/config.env`, secrets in `/etc/cvm-jlc-quote/secret.env`
(0600). The systemd unit stays secret-free.

| Variable | Purpose |
|---|---|
| `SERVER_SECRET_KEY` | the service's Nostr identity (64 hex) — **secret** |
| `RELAYS` | comma-separated relay list |
| `ANNOUNCE` | **`false` by default**: announcing waits for the announce card |
| `ANNOUNCE_D` | announcement slug (`cvm-jlc-quote-01`) |
| `JLC_PYTHON` | Playwright venv python (`~/venvs/pw/bin/python`) |
| `JLC_CLIENT_DIR` | checkout of the wrapped client (holds `tools/capture_page.py`) |
| `JLC_INPUT_DIR` | gerber zip directory (outside `/tmp`) |
| `JLC_PROFILE` | persistent Chrome profile holding the JLCPCB session |
| `JLC_SNAPSHOT_DIR` | where raw page text is archived |
| `JLC_DISPLAY` | X display for the headed browser (`:99`) |
| `JLC_CHROME` | the Chrome binary (`/usr/bin/google-chrome`) |
| `JLC_TIMEOUT_MS` | per-quote deadline (default 360000) |
| `HEALTH_PORT` | loopback health endpoint (optional) |

**No credential value is read, logged or returned by this service.** The Chrome
profile holds the JLCPCB session; this process passes its **path** only. A test
asserts no tool's input schema mentions a credential-shaped field.

## Refusals

| Reason | Meaning |
|---|---|
| `session_expired` | the profile renders no signed-in header. Nothing was priced. |
| `price_not_rendered` | the `Calculated Price` row showed no amount (or the two readers disagreed). The `Special Offer`/adder/coupon figures are **not** substitutes. |
| `qty_unsupported` | a quantity other than the page default (5) was requested. |
| `input_invalid` | no source, both sources, a `/tmp` path, or bad base64. |
| `adapter_error` | the browser leg failed (no X display, missing Chrome, dead profile, a page that never rendered), or no adapter is configured. |

## Not offered

See `NOT_OFFERED` in `src/provenance.ts`, carried into the announcement content
and the `docs` tool: no ordering, no quantity automation, no price arithmetic, no
fallback-label price, no fabricated zero, no credentials. Omission reads as
"maybe".
