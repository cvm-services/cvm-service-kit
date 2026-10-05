# cvm-service-kit

**Library for building a [ContextVM](https://www.contextvm.org/) service** — wrap
an existing MCP server (or a plain Python/TS tool) so it is *announced* and
*findable* on Nostr, and optionally *payable*.

Status: **v0.1 implemented** — dependency-free TypeScript (Deno 2; no npm tree,
so a venue operator can run it). The CEP-6 announcement emitter and the
tier-recompute contract from the spec are in `src/`, with 24 tests against the
vendored register (`deno task test`). Payments (CEP-8) and the ring gate are
still to come.

## Scope

| In scope | Out of scope |
|---|---|
| CEP-6 announcement publishing (kinds `11316`/`11317`, plus `11318`–`11320` when the server has resources/prompts) | Being a registry or a crawler (that is `cvm-registry`) |
| The tagging contract from the spec: `d` slug, namespaced `t=cvm:service:<class>`, `g` geohash at **≥2 precisions**, per-tool `cap` prices | Deciding *who* may be listed (that is a curator policy) |
| CEP-8 payment wiring (`pmi`, `transparent` / `explicit_gating`) | Settling the goods — the venue's own rail does that |
| Opt-in ring-proof gate (provider side) | Generic anonymity work |

## What exists today (S2a — the announce emitter)

| File | What it owns |
|---|---|
| `src/vocab.ts` | the input register, the **fixed** tier ladder (`none`0 < `financial`1 < `contact`2 < `fulfilment`3 < `legal`4 < `sensitive`5), `recomputeTier`, the single-letter filter shorthands |
| `src/announce.ts` | `emitAnnouncement` / `emitAnnouncementTags`: `d`, `cvm:service:<class>`, `cvm:req:*`, `cvm:opt:*`, `cvm:req:none` (derived), **exactly one** `cvm:tier:<max>` (computed), `g` precisions, one `cap` per tool, `a`, `r` |
| `src/validate.ts` | the reader side: recompute the tier, surface a mismatch with **both** values, fail loud on an unknown field, treat absent as *unknown*, never as `none` |
| `vocab/service-inputs.json` | vendored **verbatim** from `contextvm-services` (see `vocab/PROVENANCE.md`) |

Two properties carry the design:

1. **The caller cannot supply the tier.** `AnnounceInput` has no tier field; the
   emitter computes `cvm:tier:<max>` from the declared `cvm:req:*`/`cvm:opt:*`
   fields with the same `recomputeTier` a reader uses, so a lying aggregate is
   not expressible at the type level. The emitter then re-assesses its own tag
   set and throws if it is non-conforming (a kit bug, not a caller error).
2. **The field list is the truth.** A reader that meets a `cvm:tier:<x>` tag
   disagreeing with the fields uses the *recomputed* value and surfaces the
   mismatch, naming both values. The tier tag is a cache of the fields, never
   their replacement.

## Usage

```ts
import { emitAnnouncement, parseVocab } from "./src/mod.ts";

const vocab = parseVocab(JSON.parse(await Deno.readTextFile("vocab/service-inputs.json")));

const event = emitAnnouncement({
  serviceClass: "restaurant",
  d: "berlin-neukoelln-pizza-01",
  geohashes: ["u33d", "u33dc0"],          // >=2 precisions of ONE point (P2)
  required: ["ship.address", "contact.phone"],
  optional: ["order.notes"],
  tools: { menu: { amount: 0 }, order: { amount: 676 } },   // cap sats per tool
  registries: ["30000:<curator-pubkey>:berlin-food"],
  content: { name: "Pizza Neukoelln", currency: "EUR" },
}, vocab);

// event.kind === 11316; event.tags carries:
//   ["t","cvm:service:restaurant"]
//   ["t","cvm:req:ship.address"] ["t","cvm:opt:order.notes"]
//   ["t","cvm:tier:fulfilment"]          <- computed, not supplied
```

Read side:

```ts
import { assessAnnouncementTags } from "./src/mod.ts";

const a = assessAnnouncementTags(event.tags, vocab);
// a.effective  -> the tier a conforming reader MUST use (recomputed)
// a.tierMismatch, a.violations, a.warnings
```

Rules the kit enforces, straight from `docs/spec/service-inputs.md`:

- exactly **one** `cvm:tier:<tier>` per announcement, equal to the recomputed max
  of the declared fields — this is what makes a coarse "no personal data" query a
  single server-side `#t` REQ (several values are OR);
- `cvm:req:none` is the tag form of *tiers none/financial only* — the emitter
  derives it exactly when the computed tier is `none`/`financial`, and a
  financial-tier announcement without it is an advisory warning on the read side;
- absent is **not** `none`: no `cvm:req:*`/`cvm:opt:*` tag at all is an *unknown*
  appetite (`recomputeTier` returns `null`);
- an unknown field name **fails loud** (`deno` emitter refuses it unless
  `allowUnknownFields` is set) and is never counted as `none`; a reader treats it
  at the most restrictive rank and surfaces it;
- `g` is published at ≥2 precisions because `#g` is **exact match**;
- multi-letter tags are never filterable — only `d`/`t`/`g` carry filters.

## Why it is separate from the registry

Build-side and discover-side fail differently, have different consumers, and are
tested differently. The kit must stay dependency-light (a venue operator runs it);
the registry needs relay + browser plumbing and a cache. See the split table in
[`contextvm-services`](https://github.com/cvm-services/contextvm-services).

## Targets

- **TypeScript first** — the CVM SDK ecosystem is TS (`@contextvm/sdk`).
- **Deno 2** runs the sources and the tests with no install step; the modules use
  no npm package and no Deno-specific API beyond the test harness, so they also
  `tsc`-type-check for a Node consumer. Node is *not* required to test the kit.
- Python (via `nostr_sdk` bindings) only if a real Python-only consumer appears.

## Read first

- [`docs/spec/cep-draft-0001-provider.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/spec/cep-draft-0001-provider.md) — the provider/facilitator-facing spec (P1–P15).
- [`docs/spec/service-inputs.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/spec/service-inputs.md) — the input register, the tiers and the tier tag.
- [`docs/adr/0001-discovery-and-trust.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/adr/0001-discovery-and-trust.md) — tagging, pinned registries, and where ring proofs earn their keep.
- [`docs/SPIKE-PLAN.md`](https://github.com/cvm-services/contextvm-services/blob/main/docs/SPIKE-PLAN.md) — acceptance criteria; nothing is "proven" without pasted command output.

## Pitfalls already known (do not rediscover)

- **Do not use multi-letter tags as relay filters.** Only single-letter tags (`t`, `g`, `d`) are filterable; `#g` is **exact match**, which is why the spec publishes the geohash at several precisions.
- **The TypeScript `NostrServerTransport` / `ApplesauceRelayPool` transport silently hangs.** Direct `nostr-tools` (or Python `nostr_sdk`) implementations are the working path.
- **`relay.contextvm.org` is unreachable.** Use `nostr.mom`, `relay.primal.net`, `nos.lol`, `relay2.contextvm.org`, `relay.nostr.band`.
- **Client and server must use different Nostr keys** or the server's own gift-wrapped requests echo back into its subscription.
- **The tier tag is max-only, and it is computed.** Publishing every tier present would make "has no sensitive field" an absence test no relay can express; accepting a tier from the caller would make a lying aggregate possible.
- **`cvm:req:none` is not "no fields at all".** An announcement with neither `cvm:req:*` nor `cvm:opt:*` is *unclassified*; a tier tag on such an announcement is a contract violation.
- **The register is a shared copy.** `vocab/service-inputs.json` is vendored from `contextvm-services` and is never hand-edited here — refresh it and update `vocab/PROVENANCE.md` (see the file).

## Test

```sh
deno task test        # deno test --allow-read -> 24 tests
deno task check       # deno check src/mod.ts
```

## Mirror, CI and releases on Nostr (ngit)

This repository is mirrored to **ngit** — git hosting and CI on Nostr. The mirror
carries the default branch, every `pr/<slug>` branch and every tag, so the whole
repository is reachable without GitHub.

Clone it over Nostr (the `nostr://` remote speaks the ngit protocol):

```bash
git clone nostr://npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/relay.ngit.dev/cvm-service-kit
git clone https://relay.ngit.dev/npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/cvm-service-kit.git
git clone https://gitnostr.com/npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/cvm-service-kit.git
```

- **Browse / open PRs:** https://gitworkshop.dev/npub1nng5mxkdh2mu593twukfr7j3fk5wxfy0v8ujf0e5g8nwwtzlphhqksqpew/relay.ngit.dev/cvm-service-kit
- **CI:** every push is built by [ngit-CI](https://ci.orangesync.tech) — the
  workflows run from the **ngit side**, so the mirror above is the build of record.
- **Announcement (source of truth for the URLs above):** kind `30617`,
  `d=cvm-service-kit`, by `9cd14d9acdbab7ca162b772c91fa514da8e3248f61f924bf3441e6e72c5f0dee`, relays: `wss://relay.ngit.dev wss://gitnostr.com`

### Build artifacts (Nostr, not GitHub releases)

Artifacts are published as NIP-94 **kind `1063`** events, not attached to GitHub
releases. Each event carries one `url` tag per Blossom mirror and an `x` tag with
the file's **sha256** — download from any mirror and verify the hash.

No kind-`1063` artifact is announced for this repo yet, so here is the exact query:

```bash
nak req -k 1063 -t "A=30617:9cd14d9acdbab7ca162b772c91fa514da8e3248f61f924bf3441e6e72c5f0dee:cvm-service-kit" wss://relay.ngit.dev   # url + x tags
```

When one appears, download from any `url` and prove the `x` sha256 before use:

```bash
echo "<x-tag-sha256>  artifact" | sha256sum -c -
```

---
*Generated by `ngit-readme-section.sh` from the live kind-`30617` announcement
`86615d28a5504d02f518b420cd5b0fd4a2db3e10d29b4851b69c0144ff6ff59d` (created 1791154668). Doc not be hand-edited: re-run the generator.*
