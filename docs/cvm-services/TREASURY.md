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

### Part A — CashuLnWallet
- [ ] `src/proof-store.ts` (+tests)
- [ ] `src/cashu-wallet.ts` `payInvoice`/`makeInvoice`/`balanceSats` (+unit tests)
- [ ] opt-in integration test vs `mint.orangesync.tech`
- [ ] export from `src/index.ts`; tsc + tests green

### Part B — Mock L402 harness
- [ ] `services/_shared/mock-l402.ts`
- [ ] unit: `fetchWithL402` vs mock
- [ ] full-flow: `create_sms_order` vs mock → code `1234`
- [ ] manual cvm-call run recorded

### Part C — Treasury wiring
- [ ] `services/_shared/wallet.ts` factory
- [ ] wire `cvm-sms4sats` (TREASURY_BACKEND/NWC_URL/CASHU_*)
- [ ] `/health` reports backend + balance

### Part D — Live path
- [ ] NWC or funded Cashu wallet available
- [ ] live paid `rent-number` E2E (code returned)
- [ ] `ANNOUNCE=true` + `cvm-registry` entry

### Part E — IaC / ops / docs
- [ ] treasury env in `playbook-wrappers.yml`
- [ ] seed + NWC via vault; runbook
- [ ] low-balance alert wired
- [ ] docs updated; committed & merged

## Open verification (resolve during impl)
- [ ] cashu-ts v2 `meltProofs` return field for the preimage
- [ ] cashu-ts v2 proof-store API shape
- [ ] fakewallet melt preimage behavior
