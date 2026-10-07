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

- [x] `src/openai.ts` — shared OpenAI-compatible client (chat/models)
- [x] `services/_shared/ai.ts` — `buildAiTools` (chat/models/availability), paid chat
- [x] `services/cvm-nanogpt/` — code + tests
- [x] `services/cvm-ppq/` — code + tests (+ `balance` tool)
- [ ] Live E2E — **blocked on funded `NANOGPT_API_KEY` / `PPQ_API_KEY`**
- [ ] Announcements + registry entries (after live proof)

## Phase 3 — rates

- [~] API discovery: OrangeFren public API not found on-site; CypherGoat exposes
      `api.cyphergoat.com` with a `/reference` page but `/docs/swagger.json`
      404s — **needs manual API discovery** before implementing
- [ ] OrangeFren wrapper (`get_rates`)
- [ ] CypherGoat wrapper (`get_rates`)
- [ ] Announcements + registry entries

## Phase 4 — swap

- [x] Reachability checked: Boltz `api.boltz.exchange` **unreachable from the
      control host and vps3** (deferred); Trocador API returns 401 (key required)
- [ ] Obtain Trocador API key
- [ ] Trocador wrapper (`get_rates`, `quote`, `create_exchange`, `status`)
- [ ] Boltz wrapper (`get_pairs`, `get_fees`, `create_*_swap`, `get_swap_status`)
- [ ] Announcements + registry entries

## Phase 5 — M7 hardening (parallel)

- [x] Persist the payment gate store — `SqliteGateStore` (kit) wired into
      cvm-lambda; survives restarts / replay
- [x] Per-payer rate limiting — `RateLimiter` (token bucket) wired into
      cvm-lambda `run_code`/`submit_job`
- [x] Default-deny egress — `loom-egress-deny.service` (nft rule
      `iifname "loomtap*" drop`) in the executor role; verified a guest cannot
      reach `1.1.1.1:80` while offline code still runs (4/4 smoke PASS)
- [ ] Opt-in, metered network tier (flip `cvm_lambda_deny_egress` and gate it)
- [x] Admission queue — `ConcurrencyLimiter` (FIFO, `queue_timeout` refusal) in
      the kit; wired into cvm-lambda `run_code`/`submit_job` (`MAX_CONCURRENCY`)
- [ ] Vault secrets (provider nsec, treasury key); rotation runbook
- [x] Observability (partial): loopback `/health` + `/metrics` on every wrapper
      (sms4sats reports `treasury_balance_sats` + `low_treasury`; `HEALTH_PORT`)
- [ ] Fleet alerting on `low_treasury` / `unconfigured`; richer counters
- [x] Refusal-reason catalogue (`src/refusals.ts`, CEP-0001 P11) — stable
      reasons + remedies; domain error codes asserted against it
- [ ] ADR + README + CI evidence

---

## Known issues

- **Adapter VM recycle (FIXED).** Recycle failed with `Failed to add vsock`
  because `kill_vm` reused the vm dir with a stale `vsock.sock` (and raced the
  exiting firecracker). `loom-adapter-recycle.patch` makes `kill_vm` wait for
  exit and remove `vsock.sock`; recycle now succeeds (`VM pool-0 recycled`).
  Verified with `adapter_max_age=0` (recycle after every release).
- **Slow recycle (~37 s).** The adapter COW-copies the 5 GB rootfs on recycle
  (ext4 has no reflink), leaving the pool empty for ~37 s. At the default hourly
  `max_age` this is a rare blip; shrinking the rootfs (drop docker/ffmpeg) would
  cut it. Follow-up.

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
| 2026-10-06 | Phase 2 | NanoGPT + PPQ wrappers, 73 tests pass, `tsc` clean |
| 2026-10-06 | Phase 5 | durable gate store + rate limiter wired into cvm-lambda |
| 2026-10-06 | Phase 0/5 | generic `cvm_service` Ansible role; wrappers deployed staging; egress deny; admission queue |
| 2026-10-06 | ops | adapter recycle fix (vsock cleanup) verified with max_age=0; executor 4/4 PASS at default |
| 2026-10-06 | Treasury | `CashuLnWallet` + proof store; mock L402 harness; wallet factory; full pipeline over CVM → `code=1234` (see `TREASURY.md`) |
