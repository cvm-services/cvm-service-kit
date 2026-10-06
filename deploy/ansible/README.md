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

## Going live

Set in the playbook per wrapper:

- `ANNOUNCE: "true"` to publish to CEP-6.
- Treasury/upstream secrets. **Today the API keys are passed via managed
  `config.env`; move them to the vault before production** (`secret.env` is
  write-once, so use a vault-sourced managed file instead).

The executor role (`services/cvm-lambda/deploy/ansible`) still owns the
Firecracker adapter; wrappers are independent and I/O-bound and can run
elsewhere.

## fail2ban

Both roles whitelist the controller's public IP at the end of each run
(best-effort runtime allow-list) to avoid locking the operator out of hosts
behind fail2ban.
