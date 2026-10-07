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
