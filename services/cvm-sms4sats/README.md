# cvm-sms4sats — SMS verification over ContextVM (reseller)

A reseller wrapper around [sms4sats](https://sms4sats.com)'s L402 agent API
(`https://api.sms4sats.com/skill.md`). An agent calls a tool over Nostr, pays via
CEP-8 (Cashu), and the service fulfils the order upstream and returns the SMS
code.

## Flow (reseller)

```
client ── create_sms_order ─▶ CVM
  CVM: POST /v2/l402/order ─▶ 402 {invoice, macaroon, priceSats}   (quote)
  CVM: price = cost * (1 + margin); refuse with payment_required (Cashu)
  client pays (Cashu) ─▶ CVM
  CVM: pay upstream invoice (NWC) ─▶ preimage
  CVM: poll /v2/l402/order/:id with L402 auth until code_received
  CVM: return { status, code }
  CVM: charge the client; order persisted (idempotent by order_id)
```

## Tools

| Tool | Paid | Purpose |
|---|---|---|
| `list_services` | no | service codes (tg, go, wa, …) |
| `catalog` | no | SMS/rent offers by country/service |
| `availability` | no | treasury health |
| `create_sms_order` | yes | order a number, return the code |
| `order_status` | no | status/result of a prior order |

## Config (env)

| Var | Meaning |
|---|---|
| `SERVER_SECRET_KEY` | 64-hex CVM signing key |
| `NWC_URL` | Nostr Wallet Connect URI for the treasury (required in prod) |
| `MARGIN` | displayed margin, e.g. `0.2` (converted to markup internally) |
| `MIN_PRICE_SATS` | client-price floor |
| `TREASURY_FLOOR_SATS` | refuse upstream spend below this balance |
| `PAYMENT_MODE` / `CASHU_MINT_URL` | client payment rail |
| `ORDER_DB` | SQLite path |
| `ANNOUNCE_D` / `SERVICE_CLASS` | CEP-6 announcement identity |

## Run (dev)

```bash
SERVER_SECRET_KEY=$(openssl rand -hex 32) \
PAYMENT_MODE=cashu \
bun services/cvm-sms4sats/src/server.ts
```

No `NWC_URL` uses `FakeLnWallet` (dev only). Live fulfilment requires an NWC
wallet funded above `TREASURY_FLOOR_SATS` and the upstream invoice paid from it.

## Status

- Upstream client + tools + reseller flow: implemented, unit-tested (mocked
  upstream + fake wallet).
- Live E2E: **blocked on the treasury wallet** (NWC credentials) and a funded
  upstream refund invoice.
