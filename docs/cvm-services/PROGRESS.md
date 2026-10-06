# CVM service wrappers — progress tracker

`[x]` done, `[~]` in progress, `[ ]` todo, `[!]` blocked. Keep evidence honest.

---

## Phase 0 — shared kit foundation

- [x] Plan + tracker (`docs/cvm-services/`)
- [x] `pricing.ts` (+tests) — markup/margin formula, floor/ceiling/rounding
- [x] `orders.ts` persisted store (+tests) — SQLite, idempotent createOrGet
- [x] `http.ts` bridge (+tests) — `{param}` substitution, dot-path pick
- [x] `lnwallet.ts` interface + fake + NWC (+tests) — NIP-47 `NwcLnWallet`
- [x] `l402.ts` client (+tests) — header + JSON-body challenges, pay & replay
- [x] `reseller.ts` treasury guard (+tests) — refuse-when-low, reconciliation
- [x] `index.ts` exports; **59 tests pass**, `tsc` clean
- [ ] Parameterized Ansible role `cvm_service` (cvm-lambda role is the template)

## Phase 1 — sms4sats (`services/cvm-sms4sats`)

- [x] Upstream client: `services`, `catalog`, `requestOrder` (402 challenge),
      `payAndPoll`; email endpoints stubbed
- [x] Tools: `list_services`, `catalog`, `availability`, `create_sms_order`,
      `order_status`
- [x] Reseller flow: quote → CEP-8 charge → pay upstream → poll → return code
- [x] Pricing via treasury margin (markup/margin formula)
- [x] Tests (mocked upstream + fake wallet) — 7 service tests
- [x] server.ts wiring (env, NWC-or-fake wallet, announce)
- [x] **Live E2E (read-only)**: an external CVM client called `list_services`
      over Nostr; the wrapper returned the full sms4sats catalogue
- [ ] Email tools (`create_email_order`, `email_status`, `cancel`)
- [!] Paid live E2E — **blocked on treasury NWC wallet + funded upstream**
- [ ] Announcement (class `sms`) + registry entry (after paid proof)

## Phase 2 — AI

- [ ] NanoGPT wrapper (`chat`, `models`, `images`) — x402/lightning-l402 or key
- [ ] PayPerQ wrapper (reuse fleet PPQ client)
- [ ] Announcements + registry entries

## Phase 3 — rates

- [ ] OrangeFren wrapper (`get_rates`)
- [ ] CypherGoat wrapper (`get_rates`)
- [ ] Announcements + registry entries

## Phase 4 — swap

- [ ] Verify Trocador API key + Boltz reachability from deploy host
- [ ] Trocador wrapper (`get_rates`, `quote`, `create_exchange`, `status`)
- [ ] Boltz wrapper (`get_pairs`, `get_fees`, `create_*_swap`, `get_swap_status`)
- [ ] Announcements + registry entries

## Phase 5 — M7 hardening (parallel)

- [ ] Persist cvm-lambda order store (shared `orders.ts`)
- [ ] Default-deny egress for `loomtap-*` + opt-in network tier
- [ ] Admission queue + per-payer rate/concurrency limits
- [ ] Vault secrets (provider nsec, treasury key); rotation runbook
- [ ] Observability: health, counters, low-balance alerts, reconciliation
- [ ] ADR + README + CI evidence

---

## Open items / decisions

- [ ] Treasury wallet backend (NWC vs Cashu) — needed for live fulfilment
- [ ] Funded upstream accounts/keys (NanoGPT, PayPerQ, Trocador)
- [ ] Margin policy (target % + floor)
- [ ] Deploy host (vps2 executor vs vps3)

## Evidence log

| Date | Item | Evidence |
|---|---|---|
| 2026-10-06 | Plan | PLAN.md + PROGRESS.md |
| 2026-10-06 | Phase 0 | 59 tests pass, `tsc` clean (pricing/orders/http/lnwallet/l402/reseller) |
| 2026-10-06 | Phase 1 | live `list_services` over Nostr → upstream sms4sats catalogue |
