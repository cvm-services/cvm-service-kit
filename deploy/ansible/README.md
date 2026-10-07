# Wrapper deployment (Ansible)

Generic role `cvm_service` to deploy any ContextVM service wrapper under
`services/` as a systemd unit on a host.

```
deploy/ansible/
  inventory.ini            # executor host(s)
  roles/cvm_service/       # generic role
  playbook-wrappers.yml    # deploys sms4sats, nanogpt, ppq
```

## Run

```bash
cd deploy/ansible
ansible-playbook playbook-wrappers.yml
```

Idempotent: a second run reports `changed=0`.

## Per-service config

The role takes `cvm_service_name`, `cvm_service_script`, `cvm_service_config`
(dict), optional `cvm_service_state_dir` and `cvm_service_after`. It writes
`/etc/<name>/config.env` (managed) and `/etc/<name>/secret.env` (write-once,
holds the generated `SERVER_SECRET_KEY`).

## Vault-sourced secrets (NWC_URL &c.)

Paid wrappers need the treasury NWC connection URI. It is NEVER committed and
never appears in a unit file: it lands in
`/etc/<name>/managed-secrets.env` (root:root, 0600, fully managed — a rotated
value overwrites it on the next deploy), which the unit loads as a third
`EnvironmentFile=`. The unit file itself stays secret-free.

Sourcing (fleet vault — OpenBao, read path `fleet/*`):

1. Operator writes the secret once (nodes hold no vault write capability):

   ```bash
   bao kv put secret/fleet/cvm-nwc nwc_url='<nostr+walletconnect://…>'
   ```

2. Operator reads it out of the vault and supplies it at invoke time:

   ```bash
   NWC=$(python3 ~/.hermes/scripts/fleet_secret.py get cvm-nwc | …)  # never echoed
   ansible-playbook playbook-wrappers.yml -e "cvm_nwc_url=$NWC"
   # or: -e @/root/vault-cvm.yml   (0600, gitignored, never committed)
   ```

`playbook-wrappers.yml` maps it per wrapper (`wrappers_secrets`), and every key
listed there is a REQUIRED secret: the role **fails the deploy loudly** before
writing anything if the value is empty or unset. A service that would otherwise
silently come up with a fake/unconfigured wallet instead refuses at deploy
time — and if it is ever started without `NWC_URL`, the code itself refuses
paid calls with `rail_unavailable` and reports no treasury balance rather than
a fabricated one.

## Going live

Set in the playbook per wrapper:

- `ANNOUNCE: "true"` to publish to CEP-6 (only once the rail is real — see the
  announce ordering note on the board).
- Per-wrapper vault secrets via `wrappers_secrets` as above.

The executor role (`services/cvm-lambda/deploy/ansible`) still owns the
Firecracker adapter; wrappers are independent and I/O-bound and can run
elsewhere.

## fail2ban

Both roles whitelist the controller's public IP at the end of each run
(best-effort runtime allow-list) to avoid locking the operator out of hosts
behind fail2ban.
