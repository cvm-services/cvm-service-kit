# ADR-0002 — Reseller CVM service wrappers

- **Status:** Accepted
- **Date:** 2026-10-06
- **Context repo:** `cvm-services/cvm-service-kit`
- **Related:** `contextvm-services` ADR-0001 (discovery + trust), CEP-draft-0001 (provider), CEP-8

## Context

Agents can already reach MCP tools over Nostr via ContextVM. There is a large
set of no-KYC services that accept Lightning (kycnot.me). We want to expose them
as CVM services so an agent can use them with CEP-8 payment, without the agent
integrating each service's API.

Two roles are possible for the wrapper: a **pass-through** orchestrator (the
client pays the upstream directly) or a **reseller** (the wrapper holds value
upstream and charges the client).

## Decision

1. **Reseller with markup.** Wrappers hold value upstream (a funded account or a
   Lightning wallet), pay the upstream on the client's behalf, and charge the
   client via CEP-8 with a margin.
2. **L402 where the upstream is Lightning-native** (sms4sats, NanoGPT x402 with
   `lightning-l402`). The wrapper pays the upstream's 402 invoice from the
   treasury and replays with the preimage.
3. **One directory per service** under `services/`; shared machinery in `src/`.
4. **Treasury layer is mandatory.** `LnWallet` (NWC), balance floor +
   refuse-when-low, reconciliation. Selling a service the treasury cannot pay
   for is the cardinal failure.
5. **Margin** uses `client = cost * (1 + markup)`; the *displayed* margin is
   `markup/(1+markup)`, so a target X% means `markup = X/(100-X)`.
6. **Persistence.** Orders and payment-gate state live in SQLite; idempotency is
   keyed by `order_id`.
7. **Class taxonomy** (`t=cvm:service:<class>`): `sms`, `email`, `ai`, `rates`,
   `swap`, `vpn`, `esim`, `hosting`, `giftcard`, `compute`.

## Alternatives considered

- **Pass-through / non-custodial** — rejected by the operator; more client
  integrations and can't serve account-based upstreams.
- **One monolith service** fronting many providers — rejected; one dir per
  service keeps failures and secrets isolated.

## Consequences

- **Float/financial risk**: keep balances minimal, alert on low balance, and
  never advertise a service the treasury can't fund.
- **Preimage secrecy**: L402 preimages must never be logged or exposed.
- **Refunds**: upstream→client refund plumbing must be idempotent.
- **Upstream ToS**: resale restrictions apply (notably VPN); SMS/AI are least
  contentious.
- **Reachability**: some upstreams are blocked from the fleet network (Boltz was
  unreachable from both the control host and vps3) — verify before committing a
  wrapper.
- The shared modules in `src/` (`pricing`, `orders`, `gate-store`, `http`,
  `lnwallet`, `l402`, `reseller`, `openai`, `ratelimit`) are the integration
  contract for every wrapper.

## Status of work

Implemented and merged: kit foundation; `cvm-sms4sats` (L402 reseller, live
read-only E2E); `cvm-nanogpt` + `cvm-ppq` AI wrappers; durable gate store and
per-caller rate limiting.

Blocked: paid live E2E (needs a funded NWC treasury and upstream keys);
Phase 3 aggregators (API discovery); Boltz (network unreachable).
