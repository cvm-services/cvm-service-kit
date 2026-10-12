/**
 * contract.ts — the llms.txt contract served verbatim by the `docs` tool.
 *
 * Written as a TS template literal (not a copied .txt) so it cannot drift
 * from the refusal list: REFUSAL_LIST is interpolated, and the tests assert
 * the rendered text carries every line. Reuses the own-card hand-off wording
 * already shipped credential-free in mcp-cashu-exchange/docs/PAYMENT.md
 * rather than inventing a second contract.
 */
import { REFUSAL_LIST } from "./hygiene.ts";
import { TWOFIAT_ABOUT } from "./announce-content.ts";

export const CONTRACT_TEXT = `# cvm-2fiat — the rail, not the card

Service: cvm-2fiat
Class:   cvm:service:payment-rail
Surface: ContextVM (MCP JSON-RPC over Nostr, gift-wrapped) + this contract.
Status:  informational, best-effort, field-less (unclassified tier).

${TWOFIAT_ABOUT}

## What this service is

The RAIL around a 2fiat prepaid Mastercard, and nothing on the card itself:

- ${"card.rail_info"} (free): what the rail is and what it is not.
- ${"payment.quote"} (free): validate a merchant checkout URL and return the
  amount plus the instructions for the own-card hand-off.
- ${"card.balance"} (owner key only, allow-listed npub): read the operator's
  card balance/status through a LOCAL adapter on the operator's machine.
  No last-4, no PAN, no CVV - ever.
- ${"docs"} (free): this document, verbatim.

## The own-card payment pattern (credential-free by design)

The payment boundary is the merchant's hosted checkout URL. The person paying
opens it and types their own card. Nothing else ever sees a card.

1. The service (or a venue plugin) prepares an order and returns the
   merchant's hosted checkout URL.
2. payment.quote validates that URL and returns the hand-off instructions.
   This rail holds no credentials and has nothing to expose.
3. The payer opens the URL and pays with their own card: a 2fiat virtual
   prepaid Mastercard (no-KYC, funded with BTC/XMR/Lightning) or any
   personal card.
4. 3DS / OTP prompts are answered by the payer. Apple Pay and Google Pay
   work at the hosted page where the merchant offers them.

Why this shape: no card number can leak from this service - none is ever
stored, logged, or returned. Every payer's card stays theirs. The merchant's
PSP keeps the PCI scope; this service never touches it.

## Hard refusals (omission would read as "maybe", so they are written out)

${REFUSAL_LIST.map((l) => "- " + l).join("\n")}

## Money rules

- Settle-then-spend: no spend may happen before the caller's payment has
  settled. Any paid path sits downstream of the kit's ExplicitGate (CEP-8);
  an unpaid call is refused with payment_required before any work runs.
- A Cashu receive and a Lightning payment are FINAL - there is no un-pay.
  If a call settles and a downstream step then fails, the failure risk sits
  with this service; refunds are manual and the contract says so.
- A cap bounds what the CLIENT pays this service. It says nothing about the
  card: no tool on this service can charge the card at all.

## Card balance reads (owner only)

card.balance answers only to the operator's allow-listed npub
(OWNER_NPUB_HEX). It reads through a LOCAL adapter process on the
operator's machine - never through a credential the CVM server holds, and
never one that could be replayed. The response carries {currency, amount,
as_of} and nothing card-shaped. If the adapter is not configured the tool
refuses with rail_unavailable; it never invents a balance.

## Local adapter interface (defined here; implemented privately)

The balance adapter is a separate private project on the operator's
machine. This is the interface it implements:

- balance() -> {currency, amount, as_of} - no last-4, no PAN.
- capabilities() -> {card_present, can_authorize: false, needs_human_3ds: true, adapter: "local"}
- pay_checkout(url, max_amount) -> {status: "human_required"|"completed"|"failed", order_id}
  ("human_required" is the honest resting state whenever 3DS is pending.)

This service only ever consumes balance() and capabilities().

## Configuration (names only - values live in the fleet vault)

Deployed by the cvm_service Ansible role; secrets in /etc/cvm-2fiat/secret.env
(mode 0600), non-secret config in /etc/cvm-2fiat/config.env:

- SERVER_SECRET_KEY — the service's Nostr identity (64 hex chars)
- OWNER_NPUB_HEX   — the allow-listed owner pubkey for card.balance
- ADAPTER_URL      — the LOCAL adapter endpoint (loopback only), e.g. http://127.0.0.1:8790
- RELAYS, ANNOUNCE, ANNOUNCE_D, SERVICE_CLASS, PAYMENT_MODE, GATE_DB,
  CASHU_MINT_URL, PRICE_BALANCE_SATS, RATE_CAPACITY, RATE_REFILL_PER_SEC,
  HEALTH_PORT — as in the other kit services.

No 2fiat credential, session, token, OTP, PAN, CVV, expiry or account email
may ever appear in this repo, a commit message, a log line or a tool response.

## Errors

Reuses the kit's refusal vocabulary (src/refusals.ts): payment_required,
rail_unavailable, rate_limited, amount_too_large, upstream_error. Every
refusal is visible with a reason and a remedy; none is silent.
`;
