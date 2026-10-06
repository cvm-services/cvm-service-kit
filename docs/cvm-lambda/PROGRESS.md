# cvm-lambda — progress tracker

Update this file as work lands. `[x]` done, `[~]` in progress, `[ ]` todo,
`[!]` blocked. Keep the **Evidence** column honest: a command whose output was
seen, not an intention.

Hosts: **vps2** = `debian@23.182.128.51` (nested KVM), **controller** = T14Gen5.

---

## M0 — Plan, tracker, workspace

- [x] `PLAN.md` + `PROGRESS.md`
- [x] Clone `cvm-service-kit` (this repo) and `loom-adapter-firecracker`
- [x] Ansible role + pinned defaults; committed on branch `pr/cvm-lambda`

---

## M1 — vps2 executor  ✅

### M1.1 Build artifacts
- [x] `rustc`/`cargo` added to the vendored `build-rootfs.sh`
- [x] Adapter + static-musl vsock agent built by the Ansible role
      (`build-artifacts.sh`, pin `251111b…` + `loom-adapter-acpi.patch`)
- [x] Shipped to vps2

### M1.2 Firecracker + assets on vps2
- [x] Firecracker **v1.16.1** (tgz sha256-pinned)
- [x] CI kernel **6.1.155** (sha256-pinned)
- [x] Rootfs built on vps2 (Ubuntu 24.04 + python3/node/bash/go/rustc + agent)
- [x] Verified rootfs contains `go` and `rustc` (mounted image)

### M1.3 Adapter service
- [x] `/etc/default/loom-adapter` (pool=1, cpus=1, mem=1024, socket `/run/loom/adapter.sock`, group `debian`)
- [x] `loom-adapter-firecracker.service` enabled + running; socket present
- [x] TAP/iptables side-effects documented + rollback in role README

### M1.4 Acceptance (evidence)
- [x] `python3` → `2`; `node` → `4`; `go` → `6`; `rustc` → `8` (rc=0)
      `python3 smoke-adapter.py /run/loom/adapter.sock` → 4× PASS
- [x] Warm-pool reuse: repeated jobs succeed on the same VM

### Pitfalls found + fixed (now encoded in IaC)
1. **Firecracker version**: `--enable-pci` is passed unconditionally by the
   adapter; v1.10.1 rejects it → API socket never appears. Pin v1.16.1.
2. **Kernel**: the S3 4.14 quickstart kernel panics mounting PCI virtio-blk
   (`Cannot open root device vda`). Use CI kernel 6.1.155.
3. **Boot args**: adapter hardcodes `acpi=off` with `--enable-pci`; ACPI-off
   prevents PCI enumeration → no `vda`. `loom-adapter-acpi.patch` drops
   `acpi=off` and adds `root=/dev/vda`.
4. **Guest boot blockers**: `systemd-networkd-wait-online` + `dev-ttyS0.device`
   block `multi-user.target`, so `loom-vsock-agent` (ordered into multi-user)
   never starts. Start the agent from `sysinit.target` and disable
   docker/containerd startup.

---

## M2 — cvm-service-kit core  ✅

- [x] `types.ts`, `transport.ts`, `announce.ts`, `payment.ts`
- [x] client-key ≠ server-key guard; broad 1059 filter + client-side p-tag
- [x] relay connect timeout
- [x] 17 kit unit tests green; full suite 23/23
- [x] **Live acceptance**: `nak req -k 11316 -a <npub> wss://relay.primal.net`
      returns `cvm-lambda-01`, `t=cvm:service:compute`, `cvm:req:none`,
      `cvm:tier:none`, `pmi=bitcoin-cashu`
- [~] `publish timed out` is logged by nostr-tools even though the relay stores
      the event (confirmed by `nak req`); cosmetic — investigate multi-relay OK

---

## M3 — sync `run_code`  ✅

- [x] CVM `run_code` → adapter `execute` → structured result
- [x] Acceptance: `cvm-call <npub> run_code '{"language":"python3","code":"print(21*2)"}'`
      → `{"exit_code":0,"stdout":"42\n",...}`

---

## M4 — async jobs  ✅

- [x] SQLite job store + bounded worker (concurrency 2)
- [x] `submit_job` / `job_status` / `job_result`
- [x] Acceptance: Go job → `status=succeeded`, `stdout="42\n"`

---

## M5 — CEP-8 payment (Cashu)  ✅

- [x] `cap` parsing/validation; `pmi=bitcoin-cashu` advertised
- [x] `explicit_gating` helper + idempotent order store (replay does not re-run)
- [x] `PaymentRequiredError` → JSON-RPC `payment_required` error
- [x] `CashuProcessor` (cashu-ts v2): refunds the token **face value** (mint swap
      fee is the server's cost, not the payer's underpayment)
- [x] `PRICE_RUN_CODE_SATS=2`, `PAYMENT_MODE=cashu`, mint `testnut.cashu.exchange`
- [x] Config/secret split: managed `config.env` + write-once `secret.env`
- [x] Transport dedupes gift-wrap events by id (multi-relay publish otherwise
      makes a paid call run N times)
- [x] Acceptance: unpaid → `payment_required`; paid token → `stdout "42\n"`;
      same order_id replay → cached success; same token new order → refused (spent)
- [ ] Persist the order store (in-memory today; survives only per process)
- [ ] Replace testnut with a real mint before charging real value

---

## M6 — discovery  ✅

- [x] 11316 announcement lands and is filterable (`#t`, `-d`)
- [x] Announce on the registry's relay set (`wss://relay2.orangesync.tech`)
- [x] Provider npub added to `cvm-registry/curators.json` (role `provider`)
      — committed to `cvm-registry` main (`e2c1a01`)
- [x] Collector keeps it (`kept=4`, `d=cvm-lambda-01`, class `compute`)
- [x] Dashboard redeployed to vps3; live
      `https://cvm.orangesync.tech/catalog.json` contains `cvm-lambda-01`
- [x] `#g` N/A (location-less service publishes no geohash)

---

## M7 — harden + docs  [ ]

- [ ] Admission queue + per-payer rate/concurrency limits
- [ ] No-egress enforcement (adapter creates TAP+NAT unconditionally)
- [ ] Refusal reason catalogue (P11); honest availability (P13)
- [ ] ADR; secrets via env/vault only (P14)
- [ ] CI evidence per fleet DoD before merge

---

## Evidence log

| Date | Milestone | Evidence |
|---|---|---|
| 2026-10-06 | M1 | `smoke-adapter.py` → 4/4 PASS (python3/node/go/rustc), rc=0 |
| 2026-10-06 | M1 | rootfs rebuilt from the committed Ansible role (`-e cvm_lambda_rootfs_force=true`) → 4/4 PASS again (reproducible) |
| 2026-10-06 | M2 | `nak req -k 11316 -a e3cc6806…` returns cvm-lambda-01 |
| 2026-10-06 | M3 | `run_code` → `{"exit_code":0,"stdout":"42\n"}` |
| 2026-10-06 | M4 | `submit_job`→`job_result` → `status=succeeded stdout="42\n"` |
| 2026-10-06 | M3 | after IaC rebuild: `run_code` rustc → `stdout "42\n"` |
| 2026-10-06 | M5 | no token → `payment_required`; Cashu token → `stdout "42\n"`; order replay → cached; token replay → refused |
| 2026-10-06 | M6 | collector `kept=4` incl. `cvm-lambda-01`; live `https://cvm.orangesync.tech/catalog.json` contains it (HTTP 200) |

---

## Operational notes / incidents

- **fail2ban bans the operator IP (2026-10-06).** After ~4k failed *bot* logins,
  vps2's `sshd` jail banned the shared operator IP `80.187.85.172`; sshd looked
  down but the host was healthy (ICMP + 80/443 up, `systemctl is-active sshd` =
  active). Diagnose with an external TCP check; recover by unbanning via a jump
  host that is *not* banned:
  ```bash
  # vps3 (hermes) still reaches vps2 and holds the fleet key
  ssh debian@23.182.128.219 \
    'ssh -i ~/.ssh/id_fleet debian@23.182.128.51 \
       "sudo -n fail2ban-client set sshd unbanip <operator-ip>"'
  ```
  Follow-up: add the operator/fleet egress to `ignoreip`, or use an SSH jump
  host, so Ansible provisioning cannot lock itself out.
