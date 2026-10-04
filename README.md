# cvm-service-kit

**Library for building a [ContextVM](https://www.contextvm.org/) service** — wrap
an existing MCP server (or a plain Python/TS tool) so it is *announced* and
*findable* on Nostr, and optionally *payable*.

Status: **planned.** No code yet. Spec first, then implement against it.

## Scope

| In scope | Out of scope |
|---|---|
| CEP-6 announcement publishing (kinds `11316`/`11317`, plus `11318`–`11320` when the server has resources/prompts) | Being a registry or a crawler (that is `cvm-registry`) |
| The tagging contract from the spec: `d` slug, namespaced `t=cvm:service:<class>`, `g` geohash at **≥2 precisions**, per-tool `cap` prices | Deciding *who* may be listed (that is a curator policy) |
| CEP-8 payment wiring (`pmi`, `transparent` / `explicit_gating`) | Settling the goods — the venue's own rail does that |
| Opt-in ring-proof gate (provider side) | Generic anonymity work |

## Why it is separate from the registry

Build-side and discover-side fail differently, have different consumers, and are
tested differently. The kit must stay dependency-light (a venue operator runs it);
the registry needs relay + browser plumbing and a cache. See the split table in
[`contextvm-services`](https://github.com/cvm-services/contextvm-services).

## Targets

- **TypeScript/Node first** — the CVM SDK ecosystem is TS (`@contextvm/sdk`), and
  `NostrMCPGateway` already wraps existing stdio/HTTP MCP servers.
- Python (via `nostr_sdk` bindings) only if a real Python-only consumer appears.

## Read first

- [`docs/spec/cep-draft-0001-provider.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/spec/cep-draft-0001-provider.md) — the provider/facilitator-facing spec (P1–P14).
- [`docs/adr/0001-discovery-and-trust.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/adr/0001-discovery-and-trust.md) — tagging, pinned registries, and where ring proofs earn their keep.
- [`docs/SPIKE-PLAN.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/SPIKE-PLAN.md) — acceptance criteria; nothing is "proven" without pasted command output.

## Pitfalls already known (do not rediscover)

- **Do not use multi-letter tags as relay filters.** Only single-letter tags (`t`, `g`, `d`) are filterable; `#g` is **exact match**, which is why the spec publishes the geohash at several precisions.
- **The TypeScript `NostrServerTransport` / `ApplesauceRelayPool` transport silently hangs.** Direct `nostr-tools` (or Python `nostr_sdk`) implementations are the working path.
- **`relay.contextvm.org` is unreachable.** Use `nostr.mom`, `relay.primal.net`, `nos.lol`, `relay2.contextvm.org`, `relay.nostr.band`.
- **Client and server must use different Nostr keys** or the server's own gift-wrapped requests echo back into its subscription.
