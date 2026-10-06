# cvm-lambda — progress tracker

Update this file as work lands. `[x]` done, `[~]` in progress, `[ ]` todo,
`[!]` blocked. Keep the **Evidence** column honest: a command whose output was
seen, not an intention.

Legend for hosts: **vps2** = `debian@23.182.128.51`, **local** = T14Gen5.

---

## M0 — Plan, tracker, workspace

- [x] Write `PLAN.md`
- [x] Write `PROGRESS.md`
- [x] Clone `cvm-service-kit` → `local:~/repos/cvm-service-kit`
- [x] Clone `loom-adapter-firecracker` → `local:~/repos/loom-adapter-firecracker`
- [ ] Decide remote-repo strategy for cvm-lambda service dir (in-repo)

---

## M1 — vps2 executor

### M1.1 Build artifacts
- [x] Add `rustc`/`cargo` to `scripts/build-rootfs.sh` (patched in clone)
- [x] Build `loom-adapter-firecracker` binary (local, release) — 2.5 MB
- [x] Build `loom-vsock-agent` static musl binary — 611 KB, `statically linked`
- [x] Ship adapter + agent to vps2

### M1.2 Firecracker + assets on vps2
- [x] Install `firecracker` binary on vps2 — v1.10.1
- [x] Place guest kernel (`vmlinux`) on vps2 — 21 MB (S3 quickstart)
- [~] Build rootfs on vps2 (detached; `LOOM_VSOCK_AGENT` prebuilt)
- [ ] Verify rootfs contains python3/node/bash/go/rustc + agent

### M1.3 Adapter service
- [ ] `/etc/default/loom-adapter` (pool=1, cpus=1, mem=1024, socket=/run/loom/adapter.sock)
- [ ] systemd unit enabled+running; `/run/loom/adapter.sock` present
- [ ] Confirm host network side-effects (loomtap, iptables) and document rollback

### M1.4 Acceptance
- [ ] `execute` `python3 -c "print(1+1)"` → stdout `2`, exitCode 0
- [ ] `execute` `go run` snippet → runs (network-independent)
- [ ] `execute` `rustc` snippet → compiles+runs
- [ ] Recycle: two sequential jobs both succeed (warm-pool reuse)

---

## M2 — cvm-service-kit core

- [x] `types.ts` — cap, class, tag, input-requirement types
- [x] `transport.ts` — gift-wrap server (subscribe 1059, NIP-44 decrypt, respond)
  - [x] client-key ≠ server-key guard
  - [x] broad 1059 filter + client-side p-tag match (NIP-12 gap)
  - [x] relay connect timeout
- [x] `announce.ts` — 11316/11317 with `d`, `t`, `cap`, input/tier tags
- [x] `payment.ts` — cap parsing, explicit gate, idempotent order store
- [x] `mcp` dispatch (initialize/tools/list/tools/call) in transport
- [x] unit tests green (17 kit tests; 23 total with service)
- [ ] Acceptance (live): hello-world server answered via raw client over relays
- [ ] Acceptance (live): `nak req -k 11316 -t cvm:service:compute <relay>` returns it

---

## M3 — sync `run_code`

- [ ] Tool `run_code` → adapter `execute` over Unix socket
- [ ] Language → interpreter map (python3/node/bash/go/rustc)
- [ ] Output + time caps; `truncated` flag
- [ ] Acceptance: CVM `run_code` returns `{exit_code,stdout,stderr,duration_ms}`

---

## M4 — async jobs

- [ ] SQLite job store (id, owner npub, status, input, result, timestamps)
- [ ] `submit_job` / `job_status` / `job_result`
- [ ] Worker/queue drains jobs into adapter; concurrency cap
- [ ] Acceptance: submit Go build, poll to completion

---

## M5 — CEP-8 payment

- [ ] `cap` per tool advertised; validate declared == charged
- [ ] `explicit_gating`: unpaid call refused with `payment_required` (BOLT11/Cashu)
- [ ] `payment_accepted` idempotency keyed by order id
- [ ] `pmi` declared (cashu / bolt11) + `availability`
- [ ] Acceptance: replay does not execute twice

---

## M6 — discovery

- [ ] Add provider npub to `cvm-registry/curators.json` (role `provider`)
- [ ] Verify dashboard renders the service from cache (relay down = stale banner)
- [ ] Verify `#t`/`#g` filter behaviour on chosen relays

---

## M7 — harden + docs

- [ ] Admission queue + per-payer rate/concurrency limits (bounded, idempotent)
- [ ] No-egress enforcement (or documented opt-in network tier)
- [ ] Refusal reason catalogue (P11); honest availability (P13)
- [ ] ADR + README + runbook; secrets via env only (P14)
- [ ] Tests + CI evidence per fleet DoD before marking done

---

## Blockers / decisions

- [!] Adapter always sets up TAP+NAT — need containment/rollback on vps2 prod.
- [ ] Rootfs build host: vps2 (has sudo + disk) vs local (has toolchain). Prefer
      vps2 for final artifact; local for fast iteration if needed.
