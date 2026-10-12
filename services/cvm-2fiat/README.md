# cvm-2fiat — the rail, not the card

A ContextVM service around a [2fiat](https://2fiat.com) prepaid-card rail.
2fiat is an **issuer portal**: its API can read balance, list transactions,
create/fund/freeze a card — and has **no endpoint that authorizes a payment**
(the PAN/CVV sits behind a 6-digit OTP 2fiat emails). So the honest CVM here
is the **credential-free rail**: checkout hand-off instructions, rail facts,
and an owner-only balance read through a LOCAL adapter. Nothing else.

The full contract is served verbatim by the `docs` tool and lives in
`src/contract.ts`.

## Tools

| Tool | Price | Who | What |
|---|---|---|---|
| `card.rail_info` | free | anyone | What the rail is and is NOT (informational, best-effort, human-3DS). |
| `payment.quote` | free | anyone | Validate an https merchant checkout URL; return amount + own-card hand-off instructions. |
| `card.balance` | 0 sats default (owner-only) | OWNER npub only | Read the operator's card balance via the LOCAL adapter. `{currency, amount, as_of}` — no last-4, no PAN, no CVV. |
| `docs` | free | anyone | The contract (llms.txt shape), verbatim. |

## Hard refusals (in the contract, the announcement content, and this README)

- **No `card.details` tool, ever.** The service-input register has no field
  for a PAN/CVV, and a no-KYC PAN is a bearer instrument and an
  authentication factor at once. It cannot be honestly announced.
- **No `payment.authorize` / charge tool, ever.** No authorize endpoint
  exists upstream; human 3DS/SCA is mandatory; the transport has no replay
  protection (one captured gift wrap = a repeated charge).
- **`card.create` and `card.fund` refused.** Issuance is a purchase; funding
  drains a wallet. This service does not spend.

## Money rule

No spend may happen before the caller's payment has **settled**. When the
service runs in paid mode (`PRICE_BALANCE_SATS > 0`), `card.balance` sits
downstream of the kit's `ExplicitGate` (CEP-8): an unpaid call throws
`payment_required` and the adapter is never entered (tested RED-first). A
Cashu receive and a Lightning payment are FINAL — there is no un-pay — so
the failure risk of a settled-then-failed call sits with this service;
refunds are manual and the contract says so.

## The local balance adapter (interface only)

The balance adapter is a **separate private project** on the operator's
machine (the only component in the 2fiat setup that ever touches card
material). This repo defines and consumes the interface
(`src/adapter.ts`), it does not implement the credential-bearing half:

- `balance() -> {currency, amount, as_of}` — no last-4, no PAN.
- `capabilities() -> {card_present, can_authorize: false, needs_human_3ds: true, adapter: "local"}`
- `pay_checkout(url, max_amount) -> {status, order_id}` — this service only
  ever consumes `balance()` and `capabilities()`.

If `ADAPTER_URL` is unset, `card.balance` refuses `rail_unavailable`; it
never invents a balance.

## Configuration (names only — values live in the fleet vault)

Deployed by the parameterized `cvm_service` Ansible role; secrets in
`/etc/cvm-2fiat/secret.env` (mode 0600), non-secret config in
`/etc/cvm-2fiat/config.env`. The systemd unit stays secret-free.

| Variable | Purpose |
|---|---|
| `SERVER_SECRET_KEY` | the service's Nostr identity (64 hex) — **secret** |
| `OWNER_NPUB_HEX` | allow-listed owner pubkey for `card.balance` — **secret** |
| `ADAPTER_URL` | LOCAL balance adapter endpoint (loopback only) — **secret** |
| `RELAYS` | comma-separated relay list |
| `ANNOUNCE` | `false` by default; the announce step waits for the announce card |
| `ANNOUNCE_D` | announcement slug (`cvm-2fiat-01`) |
| `SERVICE_CLASS` | `payment-rail` |
| `PRICE_BALANCE_SATS` | `0` = owner reads free; `>0` = paid via ExplicitGate |
| `PAYMENT_MODE` / `CASHU_MINT_URL` / `GATE_DB` | paid-mode plumbing (as in the other services) |
| `RATE_CAPACITY` / `RATE_REFILL_PER_SEC` | rate limiter |
| `HEALTH_PORT` | loopback health endpoint (optional) |

**Nothing 2fiat may appear in any tracked file, commit, log line or tool
response: no magic-link token, no session cookie, no OTP, no PAN, no CVV, no
expiry, no account email.** `src/hygiene.ts` scans/redacts credential shapes
and the test suite asserts no tool response contains one.

## Announcement

The service is **field-less**: it collects no input the register knows
about, so it is `unclassified` — the announcement carries **no
`cvm:tier:*` tag** and no `cvm:req:*`/`cvm:opt:*` tags (see
`src/announce-content.ts`, which is why `server.ts` leaves both arrays
`undefined` instead of `[]`). The kind-11316 content carries the refusal
list verbatim: omission reads as "maybe".

## Tests

```sh
bun test services/cvm-2fiat     # the invariant suite (RED-first history)
RELAYS=wss://relay2.contextvm.org bun services/cvm-2fiat/src/live.ts   # second-key live harness
```

The invariant suite covers: an unpaid call never reaches the adapter path; a
non-owner pubkey is refused before any work; no tool response can contain a
PAN-shaped or CVV-shaped value; the refusal list is present in the announced
content and in the docs tool output.
