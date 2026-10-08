# cvm-2fiat task t_3257a720 — progress map

Branch `pr/cvm-2fiat` (remote: github = cvm-services/cvm-service-kit, origin = ngit mirror).
Deliverable: `services/cvm-2fiat/` rail-only service. Card body + manager comment = the spec.

## Facts gathered (READ-ONLY phase, no code yet)
- kit layout: `src/` lib, `services/<name>/src/{server,tools,...}`, `services/_shared/start.ts` (startService bootstrap).
- Announce API (old path, used by every service): `publishAnnouncement(server, AnnounceOptions, serverInfo)` — kind 11316/11317.
  - FIELD-LESS service: pass `requiredInputs: []` AND `optionalInputs: []` → emits only `t=cvm:req:none` + tier `none`.
  - NOTE for card body compliance ("no tier tag for a field-less service"): emitting `cvm:tier:none` is what AnnounceOptions does with both arrays []. The body says "do not carry a tier tag". Use `emitAnnouncementTags` (AnnounceInput with NO required/optional at all) if a no-tier-tag emission is required — check which path satisfies the reader contract (vocab.ts: absent req/opt = unclassified, tier null, no tag).
- Money rule: `ExplicitGate.gate()` from src/payment.ts — paid path must be downstream of gate(). Free tools = no gate.
- Refusal codes: src/refusals.ts (payment_required, rail_unavailable etc.) — reuse, don't invent.
- docs tool pattern: nadanada (python) serves docs/cvm/llms.txt verbatim via a `docs` tool. No TS service in this kit has a docs tool yet — cvm-2fiat adds one; pattern = embed the contract text and return it verbatim.
- payment.quote reference design: ~/worktrees/mcp-cashu-exchange/packages/plugin-pay-2fiat/src/index.ts + docs/PAYMENT.md (own-card hand-off wording — reuse, don't reinvent).
- Local adapter interface (private repo, defined, NOT built): ~/repos/2fiat-local-adapter/src/adapter.py — balance() -> {currency, amount, as_of}; capabilities() -> {card_present, can_authorize:false, needs_human_3ds:true, adapter:"local"}. The service codes against this interface, stub included, labelled.
- 2fiat surface report: ~/reports/research/2fiat-surface-2026-10-07.md (issuer portal; no authorize endpoint; PAN behind emailed OTP).
- Tests: `bun test src services` (bun) + deno tests in tests/ (deno test --allow-read tests/). CI runs both.
- No credentials anywhere. Env var NAMES only. Deploy: parameterized role cvm_service; /etc/cvm-2fiat/{config,secret}.env.

## Plan (TDD)
1. RED: services/cvm-2fiat/src/*.test.ts — (a) unpaid call never reaches adapter (owner balance is free in this service… NO — card body says card.balance is owner-only; the MONEY RULE applies to any paid path; balance is owner-gated not paid) — reread: tests required are (a) unpaid call never reaches balance/adapter, meaning IF a paid path exists it must sit behind the gate; (b) non-owner pubkey refused before any work; (c) no PAN/CVV-shaped value in any tool response; (d) refusal list present in announced content + docs output.
2. GREEN: implement service files.
3. Verify: bun run test; bun run typecheck; deno test + deno check.
4. Commit, push github + ngit (pr/ prefix required), open PR, evidence in PR body.
5. Cross-family review request.

## Status log
- [run 86] read-only recon complete; plan set; no files written yet.
- [run 87] RED → GREEN → shipped. 5 commits on pr/cvm-2fiat (7cd3e5b RED suite, af05bae rail_unavailable, a10c218 service core, 8b1c16c server+live harness, c9daedf deploy wiring). Verified: bun 92/92 pass, tsc clean, deno 24 pass + check clean, credscan CLEAN, live harness LIVE OK over relay2.contextvm.org. Dual push verified: github + ngit both at c9daedf. PR #5 open, CI bun+deno green. Refusal list rendered by docs tool confirmed in PR body. Announce step waits for the announce card (ANNOUNCE=false default).
