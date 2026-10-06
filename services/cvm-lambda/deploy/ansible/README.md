# cvm-lambda — Ansible provisioning (vps2)

Infrastructure as code for the cvm-lambda executor and control plane. This is
the **canonical** way to install; do not provision by hand.

## What it installs

On the target (vps2, `23.182.128.51` — the only fleet VPS with nested KVM):

1. Host packages: `debootstrap`, `e2fsprogs`, `qemu-utils`, `ubuntu-keyring`, …
2. **Firecracker `v1.10.1`** at `/usr/local/bin/firecracker`.
3. Guest kernel (sha256-pinned) at `/var/lib/loom/firecracker/vmlinux`.
4. **Loom adapter + vsock agent** built on the controller from a pinned commit
   (`loom_adapter_commit`) and copied in.
5. Guest rootfs (Ubuntu 24.04 + python3/node/bash/go/rustc + agent), built once.
6. `loom-adapter-firecracker.service` — warm microVM pool, Unix socket
   `/run/loom/adapter.sock`, group `debian`.
7. `cvm-lambda.service` — the ContextVM MCP server (bun + nostr-tools).

## Pins (defaults/main.yml)

| Pin | Value |
|---|---|
| Firecracker | `v1.10.1` |
| Guest kernel sha256 | `ea5e7d5c…` |
| Loom adapter commit | `251111baea5741c556f10be9bb0bf50ee4e9c36e` |
| vsock agent sha256 | `6d502799…` |

Change a pin in `roles/cvm_lambda/defaults/main.yml`, then re-run. The adapter
artifacts are cached under `~/.cache/cvm-lambda/artifacts`; delete them to force
a rebuild after a commit bump.

## Run

```bash
cd services/cvm-lambda/deploy/ansible
ansible-playbook playbook.yml
```

First run is slow (rootfs build, several minutes) and is guarded by
`creates:` so re-runs are fast.

## Secrets

`SERVER_SECRET_KEY` is written once to `/etc/cvm-lambda/env` (0600). Pin it for
true reproducibility:

```bash
ansible-playbook playbook.yml -e cvm_lambda_server_key=$(openssl rand -hex 32)
```

Otherwise a key is generated on first run and never overwritten. No secret is
committed to git.

## Verify

```bash
ssh debian@23.182.128.51 'systemctl status loom-adapter-firecracker cvm-lambda --no-pager'
ssh debian@23.182.128.51 'sudo cat /etc/cvm-lambda/env'   # server pubkey is derivable from the key
```

## Host network side-effects (documented, reversible)

The adapter creates `loomtap-*` TAP devices, adds `172.16.0.1/24`, enables
`net.ipv4.ip_forward`, and adds iptables MASQUERADE/FORWARD rules for the TAP
interface. Rollback:

```bash
sudo systemctl stop loom-adapter-firecracker cvm-lambda
sudo ip tuntap del dev loomtap-* mode tap 2>/dev/null || true
sudo iptables -t nat -S | grep 172.16.0.0/24     # inspect MASQUERADE rules
sudo iptables -S | grep loomtap                   # inspect FORWARD rules
```

## Known non-hermetic pieces

- The rootfs apt set is not snapshot-pinned (Ubuntu noble archive). Pin with a
  snapshot mirror for byte-reproducible builds.
- The Firecracker tgz is version-pinned but not checksum-pinned yet.
