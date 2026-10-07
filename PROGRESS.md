# PROGRESS — t_6b0769fd (pr/real-wallet)

Branch: pr/real-wallet, base = github/pr/cvm-2fiat @ c6cc3f3 (the head of the
services stack: services/ + deploy/cvm_service + src/refusals.ts all present).
Baseline: `bun test src services` = 92 pass / 0 fail (2026-10-07).

## Findings
- Fake wallet seam: services/cvm-sms4sats/src/server.ts:68
  `cfg.nwcUrl ? new NwcLnWallet(cfg.nwcUrl) : new FakeLnWallet()` + WARNING log.
- Health/availability lie: server.ts:107-108 reports treasury_balance_sats from
  treasury.balanceSats() -> FakeLnWallet -> 1,000,000 fabricated; same lie in
  tools.ts availability handler (services/cvm-sms4sats/src/tools.ts:41-43).
- Real wallet exists: src/lnwallet.ts NwcLnWallet (NIP-47 payInvoice/makeInvoice/balanceSats).
- rail_unavailable exists: src/refusals.ts:60 (code -32006, CvmRefusalError, refuse()).
- Ansible role: deploy/ansible/roles/cvm_service — secret.env.j2 is FIRST-RUN-ONLY
  (`when: not cvm_secret_stat.stat.exists`), so NWC_URL could never land on an
  already-deployed host. Unit stays secret-free (2x EnvironmentFile). mode 0600 OK.
- No wallet selection unit exists anywhere (neither service tests nor src tests).

## Plan
1. src/treasury-env.ts: walletFromEnv(env) -> {wallet?: LnWallet, real: boolean}
   (undefined when NWC_URL unset; NO FakeLnWallet substitute in production path).
2. RED tests: services/cvm-sms4sats/src/wallet.test.ts
   (a) unconfigured -> paid tool refuses rail_unavailable; (b) health/availability
   payload has no fabricated balance (rail: "nwc", status rail_unavailable);
   (c) configured -> real balance surfaces; paid tool proceeds past the rail check.
3. GREEN: server.ts + tools.ts use walletFromEnv; Treasury with no wallet refuses
   rail_unavailable on balanceSats/canSpend/assertCanSpend; tools refusal guard
   before gate.gate; availability reports balance only when real.
4. Ansible: NWC_URL via secret.env.j2 (fleet vault -> group vars / --extra-vars,
   never a repo value), write-if-changed + mode 0600 + restart wiring; ansible.cfg
   vars_plugins stage; role README secret sourcing note.
5. Dual push (github + ngit), PR with RED/GREEN output + Ansible diff, cross-family
   review, then kanban_complete (releases child t_968d7179 announce card).
