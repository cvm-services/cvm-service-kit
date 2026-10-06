# CVM service wrappers — reseller platform

**Status:** implementing (Phase 0/1)
**Repo:** `cvm-services/cvm-service-kit`
**Created:** 2026-10-06

## Goal

Turn third-party paid services (from the kycnot.me Lightning list) into
**ContextVM (MCP-over-Nostr) services**: an agent calls a tool over Nostr, pays
via CEP-8, and the wrapper fulfils the order at the upstream.

## Locked decisions

| Decision | Choice |
|---|---|
| Custody model | **Reseller with markup** — the wrapper holds value upstream and charges the client + margin |
| First batch | Tier 1 + Tier 2: **sms4sats, NanoGPT, PayPerQ, OrangeFren, CypherGoat, Trocador, Boltz** |
| Repo layout | **One directory per service** under `services/`; shared helpers in `cvm-service-kit` (`src/`) |
| Sequencing | **Wrappers first**, M7 hardening in parallel |

## Reseller implications (read first)

Because wrappers hold value upstream, the platform needs a **treasury layer**:

- a Lightning wallet (NWC) or Cashu wallet that can **pay** upstream invoices
  and return **preimages** (L402), and **mint** invoices for refunds;
- **balance monitoring + auto-topup + refuse-when-low** (honest availability,
  CEP-0001 P13);
- **reconciliation** of upstream spend vs client income;
- **refund plumbing** (upstream refund → client);
- **margin engine** using the fleet formula: `client = cost * (1 + markup)`;
  displayed margin = `markup/(1+markup)`, so set `markup = X/(100-X)` for X%.

## Architecture

```
agent ──kind 1059 CVM JSON-RPC──▶ wrapper CVM (bun)
   tools/* → http-bridge ──▶ upstream API
            │                    ▲
            │ L402 client ───────┘ (pay 402 invoice, replay with preimage)
            │
            ├─ pricing (cost → client price + margin)
            ├─ orders  (persisted, idempotent, refund state)
            ├─ treasury/lnwallet (pay upstream, balance guard)
            └─ CEP-8 gate (client pays us: Cashu / BOLT11)
```

## Shared kit modules (`src/`)

| Module | Purpose |
|---|---|
| `pricing.ts` | cost→client price, margin formula, rounding, clamps |
| `orders.ts` | persisted order store (SQLite) + idempotency + refund state |
| `http.ts` | declarative tool→HTTP bridge with `{param}` substitution |
| `lnwallet.ts` | `LnWallet` interface, `FakeLnWallet`, `NwcLnWallet` (NIP-47) |
| `l402.ts` | parse 402 challenge, pay invoice, replay with `Authorization: L402` |
| `reseller.ts` | treasury balance guard + reconciliation counters |

## Services in scope

| Service | Class | Upstream | Notes |
|---|---|---|---|
| sms4sats | `sms`,`email` | L402 agent API (`skill.md`) | verified; proves L402 reseller flow |
| NanoGPT | `ai` | OpenAI-compatible + x402 (`lightning-l402`) | verified |
| PayPerQ | `ai` | fleet-integrated PPQ API | wrap existing |
| OrangeFren | `rates` | aggregator rates | read-only, ~no custody |
| CypherGoat | `rates` | aggregator | read-only |
| Trocador | `swap`,`rates` | REST (API key required) | reseller account |
| Boltz | `swap` | public REST (non-custodial) | verify reachability |

## Phases

- **Phase 0** — kit foundation (pricing, orders, http, lnwallet, l402, reseller)
  + parameterized Ansible role `cvm_service`.
- **Phase 1** — sms4sats wrapper + registry entry (proves the L402 reseller path).
- **Phase 2** — NanoGPT, PayPerQ.
- **Phase 3** — OrangeFren, CypherGoat.
- **Phase 4** — Trocador, Boltz.
- **Phase 5 (parallel)** — M7: persist orders, default-deny egress, rate limits,
  vault secrets, observability, ADR, CI evidence.

## Risks

1. **Treasury/float** — minimal balances, refuse-when-low, auto-topup + alerts.
2. **Preimage secrecy** — L402 preimages never logged or exposed.
3. **Upstream ToS** — resale restrictions (esp. VPN); SMS/AI are least contentious.
4. **Refunds** — upstream→client idempotent plumbing.
5. **Reachability** — Boltz/Trocador were blocked/unauthenticated from the
   control host; verify from the deploy host before committing.

## Open items (needed for live Phase 1)

- Treasury wallet backend (NWC string to an existing node, or a new wallet).
- Funded accounts/keys: NanoGPT, PayPerQ, Trocador API key.
- Margin policy (target displayed margin + per-service floor).
- Deploy host (wrappers are I/O-bound → vps3/hermes likely fits).
