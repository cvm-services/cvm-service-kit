# cvm-lambda — a serverless ("lambda") ContextVM service

**Status:** implementation in progress
**Owner:** operator
**Repo of record:** `cvm-services/cvm-service-kit` (this repo)
**Created:** 2026-10-06

## 1. Goal

A **ContextVM (CVM) service** that behaves like a serverless function platform:

- A client calls an MCP tool over Nostr (CEP-6 discovery, CEP-8 payment).
- The service runs **arbitrary user-supplied code** in an isolated
  **Firecracker microVM**.
- It returns `stdout` / `stderr` / `exit_code` / `duration`, with hard resource
  and time caps.
- It is **publicly discoverable** and **paid** (CEP-8), or callable privately.

This is *not* a new protocol. It is a normal CVM MCP server whose execution
backend is the Loom Firecracker adapter.

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Executor host | **vps2 / testserver2 `23.182.128.51`** | Only fleet VPS with nested KVM (`/dev/kvm`, `vmx`). vps3 has no nested virt. |
| Control plane placement | **co-located with executor on vps2** | User choice; uses the adapter's Unix socket unchanged. |
| Tenancy | **Public + paid (CEP-8)** | Announced via CEP-6; `cap` pricing; `explicit_gating`. |
| Call model | **Both** sync `run_code` + async `submit_job`/`job_status`/`job_result` | Long Go/Rust builds need async. |
| Runtimes v1 | python3, node, bash, **go**, **rustc** | Matches rootfs builder (Go included) + rustc added. |
| Repo | **Extend `cvm-service-kit`** | Build the kit core here; `cvm-lambda` is its first consumer. |
| Execution backend | **loom-adapter-firecracker** | Rust daemon, warm pool, ~125 ms boot, vsock exec protocol. Reused unchanged. |
| Transport | **direct `nostr-tools`** (not `@contextvm/sdk` transport) | SDK `NostrServerTransport` silently hangs. |

## 3. Architecture

```
cvmi / agents
   │  kind 1059 (NIP-59 gift wrap) → kind 25910 inner JSON-RPC
   ▼
cvm-lambda control plane (bun + nostr-tools)            [vps2 23.182.128.51]
   tools: run_code (sync)
          submit_job / job_status / job_result (async)
   CEP-6 announce (11316/11317)  ·  CEP-8 explicit_gating
   SQLite job store + payment idempotency store
   │  Unix socket /run/loom/adapter.sock  (line-delimited JSON)
   ▼
loom-adapter-firecracker (Rust, systemd, root)           [vps2]
   │  vsock port 1024
   ▼
warm Firecracker microVM pool  (custom rootfs)
```

### Wire protocol to the adapter (existing, reused)

Request: `{"type":"execute","identifier":"<id>","cmd":"...","args":[...],"stdin":"...","env":{...}}`

Response stream: `{"type":"started"}` → `{"type":"stdout","data":"..."}` /
`{"type":"stderr","data":"..."}` → `{"type":"completed","exitCode":0,"duration":ms}`
(or `{"type":"error","error":"..."}`).

Arbitrary code is fed via `stdin` to an interpreter, e.g.:

```
cmd="sh", args=["-c","cat >/tmp/main.py; exec python3 /tmp/main.py"], stdin=<code>
```

## 4. Components / workstreams

### 4.1 Executor (vps2)
- Firecracker binary (`v1.16.x`) + guest kernel (Firecracker CI vmlinux).
- Custom rootfs: Ubuntu 24.04 + python3/node/bash/go/**rustc** + `loom-vsock-agent`.
- Loom adapter systemd service (root; needs `/dev/kvm`, TAP, iptables).
- Pool size 1–2, 1–2 vCPU, 512–2048 MiB per VM (host is 2 cores / ~5 GiB free).

### 4.2 `cvm-service-kit` core (built here)
- `transport/` — direct-nostr server: subscribe kind 1059, NIP-44 decrypt, parse
  JSON-RPC, gift-wrap response. Client-key ≠ server-key.
- `announce/` — CEP-6 publisher for kinds 11316/11317 (and 11318–11320 if used).
- `payment/` — CEP-8 `cap` parsing/validation, `explicit_gating` lifecycle,
  idempotency store.
- `mcp/` — minimal tools registry (list/call).
- `types/` — shared types (tags, cap, class, input requirements).

### 4.3 `cvm-lambda` service (first consumer)
- Tool `run_code`: `{language, code, stdin?, env?, timeout_ms?, network?}` →
  `{exit_code, stdout, stderr, duration_ms, truncated}`.
- Tools `submit_job` / `job_status` / `job_result` with SQLite job store.
- Tool `availability`: capacity without placing an order (CEP-0001 P13).
- Announcement per CEP-draft-0001: `d` slug, `t=cvm:service:compute`,
  `cvm:req:none`, `cvm:tier:none`, `cap` per tool, NO `g` (no fixed location).

## 5. Security model (public + untrusted)

- Default **no network egress** to guests (vsock-only execute). Network is a
  separate, higher tier and must be metered. ⚠️ adapter always creates TAP+NAT;
  see §8.
- Per-call caps: wall-clock, output bytes, vCPU, mem; VM recycle by age/jobs.
- Immutable COW rootfs; ephemeral per-VM overlay; code passed over stdin.
- Provider nsec never enters a guest; no host keys/credentials in guest.
- Payment replay defence: idempotency key = order id (CEP-0001 P4/P9/P10).
- Per-payer concurrency + rate limits; global admission queue.
- Refusals are machine-readable data (P11); availability honest (P13).
- Secrets via env, never argv (P14).

## 6. Milestones (checklists live in PROGRESS.md)

- **M0** — plan + tracker + workspace. *(this doc)*
- **M1** — vps2 executor: Firecracker + rootfs(go/rustc) + loom adapter service;
  prove a command runs in a VM over the socket.
- **M2** — kit core: direct-nostr transport + CEP-6 announcer; `cvmi discover`
  (or `nak req`) sees a hello-world service.
- **M3** — sync `run_code` end-to-end over CVM.
- **M4** — async job API + SQLite job store.
- **M5** — CEP-8 payment gating + idempotency.
- **M6** — discovery: register provider npub in `cvm-registry/curators.json`;
  verify dashboard renders from cache.
- **M7** — harden (quotas, queue, egress policy, abuse controls), docs/ADR,
  tests, evidence.

## 7. Host facts (verified 2026-10-06)

| Host | KVM | Cores | RAM (avail) | Disk | Notes |
|---|---|---|---|---|---|
| **vps2 `23.182.128.51`** | **yes (nested)** | 2 | 7.8 G / 4.9 free | 21 G | user `debian`, passwordless sudo, docker group. Production relays/mints. |
| vps3 `23.182.128.219` | no | 2 | 15 G | 23 G | no nested virt. |
| cobradorwave `100.90.101.9` | no | 4 | 7 G | — | control-plane only. |
| T14Gen5 (local) | yes | 18 | 30 G | — | build/dev host (cargo, bun, KVM). |

## 8. Risks / open items

1. **TAP+NAT on a production host.** The adapter unconditionally creates
   `loomtap-*`, `172.16.0.1/24`, enables `ip_forward`, and adds iptables
   MASQUERADE/FORWARD rules. Must be contained, documented, and reversible.
2. **Capacity.** vps2 is 2 cores / ~4.9 GiB free and already busy. Public load
   needs an admission queue and small pool; possibly a second executor later.
3. **Go/Rust cold compile cost.** Heavy; async path + warm pool mitigate.
4. **Rootfs size/time.** debootstrap + apt for go/rustc is a multi-GB, multi-min
   build; must run detached (survive SSH drop).
5. **Foreign network egress** is off by default but the adapter wires NAT anyway;
   true no-egress isolation is a follow-up (adapter change or nftables deny).

## 9. Evidence log

| Date | Milestone | Evidence |
|---|---|---|
| 2026-10-06 | M0 | This plan; `PROGRESS.md`; adapter cloned at `~/repos/loom-adapter-firecracker` |
