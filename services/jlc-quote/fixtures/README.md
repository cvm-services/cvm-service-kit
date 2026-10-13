# Fixture provenance

**These are verbatim captures of real pages. Do NOT edit one to make a test
pass** — re-capture instead. An earlier project hand-wrote a fixture to match its
parser and the whole suite passed while the parser was wrong
(`jlcpcb-service/docs/JLCPCB-QUOTE-FINDINGS.md`).

Capture command (the read-only path; it uploads a gerber and reads the quote, it
never orders):

```bash
cd ~/repos/jlcpcb-service
DISPLAY=:99 JLC_PROFILE=~/.hermes/profiles/manager/state/jlc-browser9 \
  ~/venvs/pw/bin/python -m jlcpcb_client.cli quote <zip> --snapshot ./snapshots --json
# the .txt beside the JSON is the rendered page text, copied here unchanged
```

| Fixture | Source | SHA-256 | Why it is here |
|---|---|---|---|
| `hub_v9_qty5.txt` | `snapshots/quote-20261013-222439.txt` | `0bfc01737c981f44e2508a62a0ec8d8db5b82911932a892ae13e18071b5ab0b0` | The measured hub quote: `$32.30`, 4 layers, `115x103mm`, `$23.36` DHL, `0.33 kg`. Authenticated, fully rendered. |
| `wing_v9_qty5.txt` | `snapshots/quote-20261013-222544.txt` | `482902e1fe3a61bbc48b6a6d0b03aa9a17598e8c6328930fe0c348a7c2936f5f` | The measured wing quote: `$6.40`, 2 layers, `25x184mm`, `$23.36` DHL, `0.20 kg`. |
| `hub_special_offer_trap.txt` | `snapshots/quote-20261013-202023.txt` | `b5b409734057510aa90398a9141830c272ba52ab99e7e82e011b728c38581ac1` | **Exposes invariant 2.** `Calculated Price` is rendered with **no adjacent amount**; the nearby `$4.00` belongs to `Special Offer`. The loose reader returns `$4.00` here (the historical wrong answer for a `$32.30` board); `parse.ts` refuses. |
| `hub_shipping_absent.txt` | `snapshots/quote-20261013-225050.txt` | `e35883ec904d7972e8c80cf7a589b928b99cd582a8322254fb6718fa71dd71d1` | **Exposes invariant 3.** The `Shipping Estimate` row renders **no amount**; the only `$30.00` on the page is the coupon `Save $30.00`. The loose reader calls it shipping; `parse.ts` returns `null` and the response omits the key. |
| `logged_out.txt` | fresh Chrome profile (`/home/c03rad0r/jlc-live-logs/fresh-profile`), headed navigations to `https://jlcpcb.com/` | `81e7c9f295e1923b46d2100ebce8ec05602ea7f2a914b0c450efb3cfc7504e18` | **Exposes invariant 1.** A genuine signed-out page: no signed-in header marker, no `Calculated Price`, no `Shipping Estimate`, no `Detected` sentence. |

Facts each fixture must keep (asserted in `src/parse.test.ts`):

| Fixture | `My Account` | `Calculated Price` | amount after the label | `Shipping Estimate` | amount after it |
|---|---|---|---|---|---|
| `hub_v9_qty5.txt` | yes | yes | `$32.30` | yes | `$23.36` |
| `wing_v9_qty5.txt` | yes | yes | `$6.40` | yes | `$23.36` |
| `hub_special_offer_trap.txt` | yes | yes | **none** | yes | `$23.36` |
| `hub_shipping_absent.txt` | yes | yes | `$32.30` | yes | **none** |
| `logged_out.txt` | **no** | no | — | no | — |

`logged_out.txt` is a large page (the SPA's marketing shell). It is kept whole
rather than trimmed because the absence of the marker is the whole evidence, and
a trimmed fixture would be an edit.
