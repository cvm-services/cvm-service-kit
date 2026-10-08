# PROGRESS — t_6b0769fd (pr/real-wallet)

Branch: pr/real-wallet, base = github/pr/cvm-2fiat @ c6cc3f3. Baseline: 92 pass.
Deliverable: PR #6 https://github.com/cvm-services/cvm-service-kit/pull/6

## Done
1. 572a985 — wallet honesty (code): src/treasury-env.ts walletFromEnv; Treasury
   optional wallet + rail_unavailable on every money question; sms4sats
   create_sms_order rail guard BEFORE order mint; treasuryHealthReport shared
   by availability + /health (no balance key unless real); PAYMENT_MODE=none
   no longer casts FakeLnWallet as processor. RED (0 pass, module seam absent)
   -> GREEN 106 pass / 0 fail; tsc clean; deno check clean.
   Evidence: .artifacts/{RED.txt,GREEN-targeted.txt,GREEN-full.txt}
2. e95c05b — Ansible: cvm_service_secrets -> /etc/<svc>/managed-secrets.env
   (0600, fully managed, no_log), require-secrets assert fails deploy loudly,
   unit gains third EnvironmentFile only when set; playbook wrappers_secrets
   maps sms4sats NWC_URL from cvm_nwc_url (invoke-time, never committed);
   README operator recipe. Offline verify playbook: ok=10 failed=0.
   Evidence: .artifacts/{ANSIBLE-verify.txt,ansible.diff}
   Both commits dual-pushed (github + ngit verified at e95c05b via ls-remote).
3. PR #6 open (body carries RED/GREEN + exact Ansible diff + ngit footer).
4. Vault probe (.artifacts/vault_probe*.py, keys-only, no values printed):
   fleet/* reads HEALTHY (keepass, env-master answer); NO nwc secret exists
   (25+ names all 404); nodes have no write capability -> operator must
   `bao kv put secret/fleet/cvm-nwc nwc_url=...`. NOT invented (per task).

## Remaining
- Cross-family review of PR #6 (child card t_968d7179 announce depends on this
  card + the vault write; it stays gated until then).
- After review+merge: deploy via playbook with -e cvm_nwc_url (operator writes
  vault secret first).

## Constraints kept
- NWC value never printed/committed/logged (no_log renders; probes key-names only).
- vps2 read-only (evidence from the task body only; no deploy run here).

---
# t_539cd9d9 — review-fix round (2026-10-07)

Fix card for cold-review t_41180764 findings on PR #6. Base 90c3248, 3 commits,
dual-pushed, CI green.

5. 96aa7a3 — F1 (MAJOR): de-vacuous "mints NO order" test in
   services/cvm-sms4sats/src/wallet.test.ts. answeringClient() 402-stub over the
   same fetchImpl seam tools.test.ts uses + requestOrder counter; digest field
   order fixed to mirror deriveOrderId (caller\ncountry\nservice\ntype ->
   0bcd91ea27b161900f21c97fe32b3522 for handler({service:"tg"})); asserts BOTH
   orders.get(handler-derived-id) null AND spy requestOrder===0; non-vacuity
   control test (rail configured -> same client DOES mint, spy=1,
   pending_payment). Mutations all red: guard below createOrGet (minted order
   0bcd91ea... caught), guard deleted (reviewer's exact mutation), guard after
   requestOrder (spy Expected:0 Received:1). Evidence .artifacts/RED-GREEN-F1.txt,
   RED-DELETED-F1.txt, RED-MUTATION2-F1.txt. Suite 107/0 (was 106/0).
6. a1d5c9c — F2+F3: assert expression | default('', true) before | string
   (None/int-0 no longer pass; jinja2 3.1.6 probe in transcript); assert HOISTED
   above bun-check/sync -> README "before writing anything" + fail_msg
   "No value was written" now true. verify-secrets-offline.yml: +None case,
   +int-0 case, follow-ups "failed is defined"->"is true" (was vacuously true on
   ansible-core 2.21), +2 drift pins reading the ROLE's main.yml (None-safe
   expression present; assert before 'Sync wrapper source'). Pin sensitivity
   proven (role-expression revert -> failed=1). ok=16 failed=0 (was ok=10).
7. e2f0bcb — NIT: server.ts walletFromEnv now reads cfg.nwcUrl (was parsed-but-
   dead; behaviour identical). tsc clean, deno check+task test clean.

Gates at e2f0bcb: bun 107/0, tsc clean, deno check clean, deno task test 24/0,
ansible offline ok=16 failed=0, gitleaks-clean tree (no secrets in diff),
CI ci.yml success (bun+deno) at head. Both remotes verified at e2f0bcb via
ls-remote (github + ngit). PR #6 head=e2f0bcb MERGEABLE OPEN.

---

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
