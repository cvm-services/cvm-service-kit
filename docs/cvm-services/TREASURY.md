# Treasury plan — Cashu backend + mock harness

**Status:** implementing
**Related:** `PLAN.md`, `ADR-0002`, `PROGRESS.md`
**Created:** 2026-10-06

## Why

The reseller wrappers must **pay upstreams in real value**. Today the only
wallets on cobradorwave are test ecash (`mint.orangesync.tech` is `cdk-mintd`
with `CDK_MINTD_LN_BACKEND=fakewallet`; the rest are testnut). So we need:

1. a second real treasury backend — **Cashu ecash** (`CashuLnWallet`), and
2. a way to prove the whole reseller pipeline **without real money** — a
   **mock L402 upstream**.

## Locked decisions

- Cashu backend: **in-process cashu-ts v2 + SQLite proof store**, dedicated
  seed/DB (not the shared `ours` wallet).
- Mock harness treasury: **FakeLnWallet** (flow proof); CashuLnWallet validated
  separately against the mint.
- First live sms4sats order: **`rent-number`** (non-refundable → no amountless
  refund invoice needed).
- Scope: **Parts A–E now.**

## Part A — `CashuLnWallet` (`src/cashu-wallet.ts`)

`class CashuLnWallet implements LnWallet` over cashu-ts v2:

- `payInvoice(bolt11)`: `createMeltQuote` → pick proofs from store → `meltProofs`
  → persist change → return `{ preimage, feeSats }` (preimage is required for L402).
- `makeInvoice(sats, memo)`: `createMintQuote` → `{ bolt11: quote.request, paymentHash }`.
- `balanceSats()`: sum of unspent proofs in the store.

`src/proof-store.ts`: SQLite store (mirrors `orders.ts`) for proofs/keysets,
single-writer.

**Acceptance:** unit tests vs a mocked mint; opt-in integration vs
`mint.orangesync.tech` (melt returns a preimage, mint quote returns a BOLT11,
balance round-trips).

## Part B — Mock L402 upstream (`services/_shared/mock-l402.ts`)

Bun HTTP server mimicking sms4sats:

- `POST /v2/l402/order` → `402 { macaroon, invoice, priceSats, orderId }`
  (JSON body + `WWW-Authenticate`).
- `GET /v2/l402/order/:id` + `Authorization: L402 <mac>:<preimage>` →
  `{ status: "completed", code: "1234" }` (trust any non-empty preimage).
- Configurable price/code/latency; optional `/v2/emails`.

**Acceptance:** full `buildSmsTools` + `Sms4SatsClient({baseUrl: mock})` +
`ExplicitGate` + `Treasury(FakeLnWallet)` → `create_sms_order` returns `1234`.

## Part C — Treasury wiring (`services/_shared/wallet.ts`)

`makeWallet(env)`: `NWC_URL` → `NwcLnWallet`; `CASHU_MINT_URL`+seed →
`CashuLnWallet`; else `FakeLnWallet`. Wire into `cvm-sms4sats`; add config keys.

**Acceptance:** wrapper boots with each backend and reports it in `/health`.

## Part D — Live path

`rent-number` against the real sms4sats, paid from a real NWC wallet or funded
CashuLnWallet; then `ANNOUNCE=true` + provider npub in `cvm-registry`.

## Part E — IaC / ops / docs

Treasury env in `playbook-wrappers.yml`; seed + `NWC_URL` in the vault; fleet
alert on `/health` `low_treasury`; funding runbook; docs updates.

---

## Checklist

### Part A — CashuLnWallet  ✅
- [x] `src/proof-store.ts` (Memory + SQLite) + tests
- [x] `src/cashu-wallet.ts` `payInvoice`/`makeInvoice`/`balanceSats`/`fund` + unit tests
- [x] opt-in integration test vs a live mint (`MINT_INTEGRATION=1`)
- [x] exported; tsc + tests green

**Melt fix:** the first cut split an exact sum via `wallet.send` then melted it,
which failed with `insufficient_inputs` because the mint's input fee scales with
the number of proofs. Correct NUT-05 flow: submit enough proofs and take the
change. Verified against `testnut.cashu.exchange`: `state=PAID`,
`preimage=0fd0…`, change returned.

### Part B — Mock L402 harness  ✅
- [x] `services/_shared/mock-l402.ts` (+ standalone entrypoint)
- [x] unit: `fetchWithL402` vs mock
- [x] full-flow: `create_sms_order` vs mock → code `1234`
- [x] manual cvm-call run recorded → `{"status":"completed","code":"1234"}`

### Part C — Treasury wiring  ✅
- [x] `services/_shared/wallet.ts` factory (nwc | cashu | fake) + tests
- [x] wired into `cvm-sms4sats` (TREASURY_BACKEND/NWC_URL/CASHU_TREASURY_MINT_URL/CASHU_WALLET_SEED)
- [x] `/health` reports `treasury_backend` + balance
- [x] end-to-end with the **Cashu treasury**: `e2e-cashu-mock.ts` — the mock
      upstream issues a real testnut BOLT11, the wrapper's Cashu treasury melts
      it (`state=PAID`, preimage) → `{"status":"completed","code":"1234"}`

### Part D — Live path  [!] blocked
- [x] client validated against the live sms4sats order API (402 shape; both
      order types require `refundInvoice`); `create_sms_order` sends
      `type`/`refundInvoice`/`durationMinutes`
- [ ] funded wallet that can issue an **amountless** BOLT11 (refund invoice)
- [ ] live paid order E2E (code returned)
- [ ] `ANNOUNCE=true` + `cvm-registry` entry

### Part E — IaC / ops / docs  ✅
- [x] treasury env in `playbook-wrappers.yml`
- [x] managed `secrets.env` (0600, vault-sourced) in the `cvm_service` role
- [x] low-balance/liveness timer (`<name>-health.timer`, fails when `/health` != ok)
- [x] docs updated; deploy idempotent

## Funding runbook

### Real NWC (fastest)
1. Fund a Lightning wallet that exposes NWC (Alby/CLN/LND).
2. `-e sms_treasury_backend=nwc -e sms_nwc_url='nostr+walletconnect://…'`
   (`ansible-playbook playbook-wrappers.yml -e @vault-treasury.yml`).
3. Flip `ANNOUNCE: "true"` for `cvm-sms4sats`.

### Real ecash (Cashu)
1. Create a dedicated wallet: `-e sms_treasury_backend=cashu`
   `-e sms_cashu_treasury_mint_url='https://mint.minibits.cash/Bitcoin'`
   `-e sms_cashu_seed="$(openssl rand -hex 32)"`.
2. Fund it: `makeInvoice` mints a BOLT11 quote; pay that invoice from any real
   Lightning wallet → ecash credits the treasury wallet DB.
3. `/health` shows `treasury_balance_sats`; the alert fires below the floor.

### Refund invoice — the real live blocker (verified against the live API)
Both `receive-sms` **and** `rent-number` require a `refundInvoice` (a no-amount
BOLT11 valid ≥30 min). Our Cashu/NWC `makeInvoice` produces *amounted* invoices,
so the live path needs a Lightning wallet that can issue an **amountless**
invoice. `create_sms_order` now takes `type` (`receive-sms` | `rent-number`),
`duration_minutes`, and requires `refund_invoice`.

## Open verification
- [x] cashu-ts v2 melt preimage field → `MeltProofsResponse.quote.payment_preimage`
- [x] proof-store API shape → custom (SQLite) store
- [x] fakewallet melt preimage → testnut (Nutshell FakeWallet) returns a real
      preimage on melt → a fakewallet mint can settle the L402 handshake

## Finding — mint compatibility (cashu-ts v2)
`cashu-ts@2.9.0` **cannot verify cdk-mintd keysets** ("Couldn't verify keyset
ID"): `mint.minibits.cash/Bitcoin` and `mint.orangesync.tech` both fail to load.
Nutshell-family mints load fine: `testnut.cashu.exchange`,
`mint.cubabitcoin.org`. So:
- Free mechanics/integration tests use `testnut.cashu.exchange`.
- A **real-ecash treasury** should use a Nutshell mint (e.g. Cuba Bitcoin) until
  we move to a cashu-ts that verifies cdk keysets (v3+), or the fleet mint is
  changed. NWC remains the fastest real path.

## Notes
- nanogpt/ppq `-health.timer` units report failed while `status=unconfigured`
  (expected until upstream keys are supplied); sms4sats reports `low_treasury`
  below the floor.
