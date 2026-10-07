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
